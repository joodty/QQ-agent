// Production admission for the existing tool-capable engine. No alternate BYOK engine.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getConfig, updateConfig, DATA_DIR } from './config.js';
import { createConversationBudget } from './conversation-budget.js';
import { currentConversationContext, runWithConversationContext } from './conversation-context.js';

const APP_ID = 0x51425047, SCHEMA = 1, MICRO = 1_000_000;
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const chatKey = x => typeof x === 'string' && /^(group|private):[1-9]\d*$/.test(x) && Number.isSafeInteger(Number(x.split(':')[1]));
const money = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1_000_000;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const error = (message, code = 'PAID_CALL_DENIED') => Object.assign(Error(message), { code, statusCode: 403 });
const isDate = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x + 'T00:00:00Z')) && new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) === x;
const stable = x => Array.isArray(x) ? '[' + x.map(stable).join(',') + ']' : plain(x) ? '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}' : JSON.stringify(x);
const hash = x => crypto.createHash('sha256').update(stable(x)).digest('hex');
const fundingFingerprint = (p, key) => hash({ endpoint: p.endpoint, model: p.model, prices: p.prices, funding: p.funding[key], outputCap: p.outputCap, imageTokensPerImage: p.imageTokensPerImage ?? null, responseModels: p.verifiedResponseModels || [] });
function endpoint(value) {
  if (typeof value !== 'string') throw error('付费端点未明确配置');
  let u; try { u = new URL(value); } catch { throw error('付费端点无效'); }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw error('付费端点无效');
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw error('生产付费端点必须使用 HTTPS');
  return u.href.replace(/\/+$/, '');
}
function policy(config) {
  const p = config?.productionBudget;
  if (!plain(p) || p.enabled !== true || typeof p.model !== 'string' || !p.model || !plain(p.prices)
    || !['inputCnyPerMillion', 'cacheHitCnyPerMillion', 'outputCnyPerMillion'].every(k => money(p.prices[k]))
    || p.prices.reasoningIncluded !== true || !money(p.defaultDailyLimitCny)
    || !Number.isSafeInteger(p.outputCap) || p.outputCap < 1 || p.outputCap > 8192
    || !plain(p.overrides) || !plain(p.funding) || !plain(p.initialSpent)
    || p.verifiedResponseModels !== undefined && (!Array.isArray(p.verifiedResponseModels) || p.verifiedResponseModels.some(x => typeof x !== 'string' || !x || x.length > 200))
    || p.imageTokensPerImage !== undefined && p.imageTokensPerImage !== 1024) throw error('生产费用保护未就绪或缺少完整人民币报价');
  if (!p.prices.inputCnyPerMillion && !p.prices.outputCnyPerMillion) throw error('不能用缺失的零报价开放付费调用');
  for (const [key, limit] of Object.entries(p.overrides)) if (!chatKey(key) || !money(limit)) throw error('会话预算覆盖配置无效');
  for (const [key, f] of Object.entries(p.funding)) if (!chatKey(key) || !plain(f) || typeof f.mode !== 'string' || typeof f.enabled !== 'boolean') throw error('会话出资策略无效');
  for (const [date, rows] of Object.entries(p.initialSpent)) {
    if (!isDate(date) || !plain(rows)) throw error('初始会话费用格式无效');
    for (const [key, amount] of Object.entries(rows)) if (!chatKey(key) || !money(amount)) throw error('初始会话费用无效');
  }
  return { ...p, endpoint: endpoint(p.endpoint) };
}
// Accepts the complete configuration and returns a validated budget policy only.
export const validateProductionBudgetConfig = policy;
function allowed(config, key) {
  if (!chatKey(key)) return false;
  const [kind, id] = key.split(':'), name = kind === 'group' ? 'groups' : 'private';
  const allow = config.allow?.[name], deny = config.deny?.[name];
  return Array.isArray(allow) && allow.map(String).includes(id) && !(Array.isArray(deny) && deny.map(String).includes(id));
}
function authorize(config, context) {
  const p = policy(config), key = context?.conversationKey;
  if (!context || context.botId !== 'primary' || !allowed(config, key) || context.fundingRef?.id !== 'platform'
    || p.funding[key]?.mode !== 'platform' || p.funding[key]?.enabled !== true) throw error('该群或私聊没有明确的平台出资授权；未启用 BYOK 或普通体验额度');
  return p;
}

export function createPaidCallStorage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw error('费用账本需要绝对路径');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exists = fs.existsSync(file), db = new DatabaseSync(file); let depth = 0;
  try {
    db.exec('PRAGMA busy_timeout=10000');
    if (!exists) db.exec(`BEGIN IMMEDIATE; CREATE TABLE paid_documents(name TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT; PRAGMA application_id=${APP_ID}; PRAGMA user_version=${SCHEMA}; COMMIT;`);
    if (db.prepare('PRAGMA application_id').get().application_id !== APP_ID || db.prepare('PRAGMA user_version').get().user_version !== SCHEMA
      || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
      || JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x => x.name)) !== '["paid_documents"]') throw error('费用账本身份、版本或结构损坏', 'PAID_LEDGER_UNAVAILABLE');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw e; }
  return {
    transaction(work) {
      const nested = depth++ > 0;
      try { if (!nested) { db.exec('BEGIN IMMEDIATE'); if (db.prepare('PRAGMA application_id').get().application_id !== APP_ID || db.prepare('PRAGMA user_version').get().user_version !== SCHEMA) throw error('费用账本版本已改变', 'PAID_LEDGER_UNAVAILABLE'); }
        const value = work(); if (value?.then) throw error('费用事务必须同步'); if (!nested) db.exec('COMMIT'); return value;
      } catch (e) { if (!nested) try { db.exec('ROLLBACK'); } catch {} throw e; } finally { depth--; }
    },
    readText(name) { return db.prepare('SELECT body FROM paid_documents WHERE name=?').get(name)?.body ?? null; },
    writeText(name, body, expected) {
      const actual = db.prepare('SELECT body FROM paid_documents WHERE name=?').get(name)?.body ?? null;
      if (actual !== expected) throw error('费用账本版本冲突', 'PAID_LEDGER_UNAVAILABLE');
      db.prepare('INSERT INTO paid_documents VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(name, body);
    },
    close() { db.close(); },
  };
}

// Validate the final transformed request. Text is conservatively estimated in UTF-8 bytes
// plus protocol allowance; this is platform estimation, not a supplier invoice guarantee.
function constrainedBody(input, p, degraded) {
  let body; try { body = JSON.parse(JSON.stringify(input)); } catch { throw error('无法为该模型请求报价'); }
  if (!plain(body) || body.model !== p.model || !Array.isArray(body.messages) || !body.messages.length || body.stream !== false
    || body.n !== undefined && body.n !== 1 || body.audio !== undefined || body.video !== undefined
    || body.modalities !== undefined && stable(body.modalities) !== '["text"]') throw error('请求模型或计费模态不在已确认报价内');
  let images = 0;
  const pricedMessages = body.messages.map(m => {
    if (!plain(m) || typeof m.role !== 'string') throw error('消息格式无法报价');
    if (typeof m.content === 'string' || m.content === null || m.content === undefined) return m;
    if (!Array.isArray(m.content)) throw error('消息模态无法报价');
    return { ...m, content: m.content.map(part => {
      if (part?.type === 'text' && typeof part.text === 'string') return part;
      if (part?.type === 'image_url' && plain(part.image_url) && typeof part.image_url.url === 'string' && part.image_url.url && p.imageTokensPerImage === 1024) {
        images++; return { type: 'image_url', image_url: { url: '[priced-image]' } };
      }
      throw error('图片未获明确报价或包含未知音视频模态');
    }) };
  });
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(t => t?.type !== 'function' || !plain(t.function)))) throw error('服务端付费工具尚未纳入预算');
  const cap = Math.min(p.outputCap, degraded ? 256 : p.outputCap,
    typeof body.max_tokens === 'number' && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : p.outputCap);
  body.max_tokens = cap; delete body.max_completion_tokens; delete body.max_output_tokens;
  if (degraded) body.messages.push({ role: 'system', content: '今日会话预算已达节流阈值：正文最多120个汉字，只发一条简短回复。不主动追问、开启话题或做额外研究；需要回复时仍使用原有发送工具。' });
  const priced = { ...body, messages: pricedMessages };
  // Do not count data/base64 or remote image URL length as text tokens.
  if (degraded) priced.messages = [...pricedMessages, body.messages.at(-1)];
  const inputTokens = Buffer.byteLength(JSON.stringify(priced), 'utf8') + 2048 + body.messages.length * 128 + images * (p.imageTokensPerImage ?? 0);
  if (!integer(inputTokens) || inputTokens > 4_000_000) throw error('输入过大，无法安全预留费用');
  const amount = Math.max(1 / MICRO, Math.ceil((inputTokens * Math.max(p.prices.inputCnyPerMillion, p.prices.cacheHitCnyPerMillion) + cap * p.prices.outputCnyPerMillion) - 1e-7) / MICRO);
  if (!money(amount)) throw error('预估费用超出支持范围');
  return { body, amount, inputTokens, outputTokens: cap };
}
function usageCost(raw, token) {
  const u = raw?.usage;
  if (!plain(u) || !integer(u.prompt_tokens) || !integer(u.completion_tokens)) return null;
  if (raw.model !== undefined && ![token.model, ...token.responseModels].includes(raw.model)) return null;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0;
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0;
  if (!integer(cached) || cached > u.prompt_tokens || !integer(reasoning) || reasoning > u.completion_tokens
    || u.total_tokens !== undefined && (!integer(u.total_tokens) || u.total_tokens !== u.prompt_tokens + u.completion_tokens)) return null;
  const amount = ((u.prompt_tokens - cached) * token.prices.inputCnyPerMillion + cached * token.prices.cacheHitCnyPerMillion + u.completion_tokens * token.prices.outputCnyPerMillion) / MICRO;
  return money(amount) ? amount : null;
}

export function createPaidCallGuard({ storage, config, now = Date.now } = {}) {
  if (!storage || typeof config !== 'function') throw error('费用保护缺少依赖');
  let seedAt = null;
  const budget = createConversationBudget({ storage, file: 'conversation-budget', botId: 'primary', now: () => seedAt ?? now() });
  function sync(p) {
    const current = budget.config(), target = { enabled: true, defaultDailyLimitCny: p.defaultDailyLimitCny,
      overrides: Object.fromEntries(Object.entries(p.overrides).map(([k, v]) => [k, { enabled: true, dailyLimitCny: v }])) };
    const removals = Object.fromEntries(Object.keys(current.overrides).filter(k => !Object.hasOwn(p.overrides, k)).map(k => [k, null]));
    if (current.enabled !== true || current.defaultDailyLimitCny !== target.defaultDailyLimitCny || stable(current.overrides) !== stable(target.overrides)) budget.update({ configVersion: current.configVersion, ...target, overrides: { ...removals, ...target.overrides } });
  }
  storage.transaction(() => {
    const p = policy(config()), original = storage.readText('initial-spent-marker'), seedHash = hash(p.initialSpent);
    if (original !== null) {
      let marker; try { marker = JSON.parse(original); } catch { throw error('初始费用标记损坏', 'PAID_LEDGER_UNAVAILABLE'); }
      if (!plain(marker) || marker.version !== 1 || marker.seedHash !== seedHash) throw error('初始费用快照发生变化，不能再次覆盖已运行账本', 'PAID_LEDGER_UNAVAILABLE');
    } else {
      if (budget.records().length) throw error('已有费用但缺少初始化标记，拒绝重新初始化', 'PAID_LEDGER_UNAVAILABLE');
      budget.update({ configVersion: budget.config().configVersion, enabled: false });
      try {
        for (const [date, entries] of Object.entries(p.initialSpent)) for (const [key, amount] of Object.entries(entries)) {
          if (!amount) continue;
          seedAt = Date.parse(date + 'T04:00:00Z');
          const hold = budget.reserve(key, { operationId: 'seed:' + hash([date, key]), estimatedMaxCost: amount, quote: { currency: 'CNY', complete: true } });
          if (!hold.allowed || !budget.dispatch(hold.id).mayDispatch) throw error('初始费用入账失败', 'PAID_LEDGER_UNAVAILABLE');
          budget.settle(hold.id, { amount, currency: 'CNY' });
        }
      } finally { seedAt = null; }
      storage.writeText('initial-spent-marker', JSON.stringify({ version: 1, seedHash }), null);
    }
    sync(p);
  });
  return {
    status(key) { return storage.transaction(() => { sync(policy(config())); return budget.status(key); }); },
    records: filters => budget.records(filters),
    prepare({ api, body, purpose = 'chat', direct = true, platformCredential, operationId = crypto.randomUUID() }) {
      return storage.transaction(() => {
        const cfg = config(), context = currentConversationContext(), p = authorize(cfg, context); sync(p);
        if (endpoint(api.baseUrl) !== p.endpoint || api.model !== p.model || !platformCredential || api.apiKey !== platformCredential) throw error('当前端点、模型或凭据不在平台付费授权内');
        if (!['chat', 'memory', 'proactive'].includes(purpose)) throw error('未知付费调用用途');
        const current = budget.status(context.conversationKey), first = constrainedBody(body, p, false);
        const degraded = current.action !== 'normal' || current.enabled && current.spentCny + current.reservedCny + first.amount >= current.dailyLimitCny * 0.8;
        if (degraded && (purpose !== 'chat' || !direct)) throw error('预算达到80%，已暂停主动参与和后台记忆整理');
        const quote = degraded ? constrainedBody(body, p, true) : first;
        const hold = budget.reserve(context.conversationKey, { operationId, estimatedMaxCost: quote.amount, quote: { currency: 'CNY', complete: true } });
        if (!hold.allowed) throw error(hold.reason || '今日会话预算不足');
        return { id: hold.id, key: context.conversationKey, requestId: context.requestId, model: p.model, endpoint: p.endpoint,
          prices: { ...p.prices }, responseModels: p.verifiedResponseModels || [], body: quote.body, degraded, purpose,
          configFingerprint: fundingFingerprint(p, context.conversationKey) };
      });
    },
    dispatch(token) {
      return storage.transaction(() => {
        const p = authorize(config(), currentConversationContext()); sync(p);
        if (currentConversationContext().conversationKey !== token.key || currentConversationContext().requestId !== token.requestId
          || token.configFingerprint !== fundingFingerprint(p, token.key)) throw error('付费来源或请求配置已变化');
        const current = budget.status(token.key);
        if (current.action !== 'normal' && !token.degraded) throw error('费用已达到节流阈值，请按新限制重新发起请求');
        const raw = storage.readText('interactive-cooldown'), prior = raw === null ? {} : JSON.parse(raw);
        if (!plain(prior) || Object.values(prior).some(x => !plain(x) || typeof x.requestId !== 'string' || !integer(x.at))) throw error('费用节流记录损坏', 'PAID_LEDGER_UNAVAILABLE');
        if (token.degraded && prior[token.key]?.requestId !== token.requestId && now() - (prior[token.key]?.at ?? -Infinity) < 60_000) throw error('预算节流中，请间隔至少60秒再发起回复');
        if (current.action !== 'normal' && token.purpose !== 'chat') throw error('预算已达到80%，后台调用暂停');
        if (!budget.dispatch(token.id).mayDispatch) throw error('剩余额度或配置已变化，未发送调用暂停');
        if (token.purpose === 'chat' && prior[token.key]?.requestId !== token.requestId) {
          Object.defineProperty(prior, token.key, { value: { requestId: token.requestId, at: now() }, enumerable: true, configurable: true, writable: true });
          storage.writeText('interactive-cooldown', JSON.stringify(prior), raw);
        }
      });
    },
    complete(token, { text }) {
      let raw; try { raw = JSON.parse(text); } catch { return this.unknown(token, 'invalid_json'); }
      const amount = usageCost(raw, token);
      if (amount === null) return this.unknown(token, 'missing_usage');
      return budget.settle(token.id, { amount, currency: 'CNY' });
    },
    unknown(token, reason = 'network_error') { return budget.markUnknown(token.id, { reason }); },
    release(token) { return budget.release(token.id); },
  };
}

let production = null;
export function productionPaidCallGuard() {
  const config = getConfig(); if (!Object.hasOwn(config, 'productionBudget') && !production && process.env.QQ_AGENT_REQUIRE_BUDGET !== '1') return null;
  policy(config);
  if (!production) {
    const storage = createPaidCallStorage(path.join(DATA_DIR, 'paid-calls.sqlite'));
    try { production = { storage, guard: createPaidCallGuard({ storage, config: getConfig }) }; } catch (e) { storage.close(); throw e; }
  }
  return production.guard;
}
export function closeProductionPaidCallGuard() { if (production) production.storage.close(); production = null; }

const fundedKeys = (cfg, p) => Object.keys(p.funding).filter(key => allowed(cfg, key) && p.funding[key].mode === 'platform' && p.funding[key].enabled === true).sort();
const limitsVersion = (cfg, p) => hash({ defaultDailyLimitCny: p.defaultDailyLimitCny, overrides: p.overrides, scopes: fundedKeys(cfg, p) });
/** Management-only projection: no credentials, endpoints, price table or initial balances. */
export function productionBudgetOverview() {
  const cfg = getConfig();
  if (!Object.hasOwn(cfg, 'productionBudget') && !production && process.env.QQ_AGENT_REQUIRE_BUDGET !== '1') return { enabled: false, conversations: [] };
  const p = policy(cfg), guard = productionPaidCallGuard();
  return { enabled: true, currency: 'CNY', version: limitsVersion(cfg, p), defaultDailyLimitCny: p.defaultDailyLimitCny,
    overrides: Object.fromEntries(fundedKeys(cfg, p).filter(key => Object.hasOwn(p.overrides, key)).map(key => [key, p.overrides[key]])),
    conversations: fundedKeys(cfg, p).map(key => guard.status(key)),
    estimationBoundary: '按已确认价格估算，并保守保留在途与未知费用；不是供应商账单。' };
}
/** Called only behind the authenticated management gateway; no platform policy is client-writable. */
export function updateProductionBudgetLimits(patch) {
  const invalid = message => Object.assign(error(message), { statusCode: 400 });
  if (!plain(patch) || Object.keys(patch).some(key => !['version', 'defaultDailyLimitCny', 'overrides'].includes(key)) || typeof patch.version !== 'string') throw invalid('只允许修改默认每日额度和已授权聊天的独立额度');
  const cfg = getConfig(), p = policy(cfg), scopes = new Set(fundedKeys(cfg, p));
  if (patch.version !== limitsVersion(cfg, p)) throw Object.assign(error('额度设置已变化，请刷新后再保存'), { statusCode: 409 });
  const validAmount = amount => money(amount) && Math.abs(amount * MICRO - Math.round(amount * MICRO)) < 0.00001;
  if (Object.hasOwn(patch, 'defaultDailyLimitCny') && !validAmount(patch.defaultDailyLimitCny)) throw invalid('每日额度须为非负数，最多六位小数');
  if (Object.hasOwn(patch, 'overrides') && (!plain(patch.overrides) || Object.entries(patch.overrides).some(([key, amount]) => !scopes.has(key) || amount !== null && !validAmount(amount)))) throw invalid('只能设置已有授权聊天的每日额度');
  const overrides = { ...p.overrides };
  for (const [key, amount] of Object.entries(patch.overrides || {})) { if (amount === null) delete overrides[key]; else overrides[key] = amount; }
  const dailyLimit = patch.defaultDailyLimitCny ?? p.defaultDailyLimitCny;
  validateProductionBudgetConfig({ ...cfg, productionBudget: { ...p, defaultDailyLimitCny: dailyLimit, overrides } });
  // __replace__ is generated here, never accepted from the browser.
  updateConfig({ productionBudget: { defaultDailyLimitCny: dailyLimit, overrides: { __replace__: overrides } } });
  return productionBudgetOverview();
}
export function runWithPaidConversation(key, work) {
  const config = getConfig(); if (!Object.hasOwn(config, 'productionBudget') && !production && process.env.QQ_AGENT_REQUIRE_BUDGET !== '1') return work();
  const existing = currentConversationContext();
  if (existing) { if (existing.conversationKey !== key) throw error('会话物理归属发生变化'); authorize(config, existing); return work(); }
  const context = { botId: 'primary', conversationKey: key, actorId: 'server', fundingRef: { id: 'platform', version: 1 }, personaRef: { id: 'server-selected', version: 1 } };
  authorize(config, context); return runWithConversationContext(context, work);
}
