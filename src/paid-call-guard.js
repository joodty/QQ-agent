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
const fundingFingerprint = (p, key) => hash({ endpoint: p.endpoint, model: p.model, prices: p.prices, funding: p.funding[key], outputCap: p.outputCap, totalDailyLimitCny: p.totalDailyLimitCny ?? null, imageTokensPerImage: p.imageTokensPerImage ?? null, responseModels: p.verifiedResponseModels || [] });
let fundingServices = null;
export function setPaidCallFundingServices(services) {
  if (services !== null && (typeof services?.resolve !== 'function' || typeof services?.policy !== 'function')) throw error('出资解析服务无效');
  fundingServices = services;
}
function effectivePolicy(config) {
  const p = policy(config), extra = fundingServices?.policy() || {};
  if (extra.overrides) for (const [key, amount] of Object.entries(extra.overrides)) { if (!chatKey(key) || !money(amount)) throw error('出资额度无效'); }
  return { ...p, overrides: { ...p.overrides, ...(extra.overrides || {}) }, trial: extra.trial || null };
}
function sourceFor(config, key) {
  const controls=config.botControls,controlledKind=String(key).split(':')[0];
  if(controls&&(controls.enabled===false||controlledKind==='group'&&controls.groupReplies===false||controlledKind==='private'&&controls.privateReplies===false))throw error('机器人或此类聊天的回复已停用');
  if(process.env.QQ_AGENT_HOSTED_BOT_ID&&(!Number.isSafeInteger(config.hostedLeaseUntil)||config.hostedLeaseUntil<=Date.now()))throw error('托管实例授权已过期，等待平台重新核验');
  const p = effectivePolicy(config), resolved = fundingServices?.resolve(key);
  if (resolved?.blocked) throw error('当前出资已停用、被撤销或尚未配置');
  const source = resolved || (p.funding[key]?.mode === 'platform' && p.funding[key]?.enabled === true ? { id:'platform',version:1,mode:'platform',endpoint:p.endpoint,model:p.model,prices:p.prices,responseModels:p.verifiedResponseModels || [],imageTokensPerImage:p.imageTokensPerImage,scopeAuthorized:false } : null);
  if(source?.mode!=='byok'&&p.platformSuspended===true)throw error('平台模型服务暂未开放调用，等待管理员恢复');
  const [kind,id] = String(key).split(':'), denied = config.deny?.[kind === 'group' ? 'groups' : 'private'];
  if (!source || !chatKey(key) || Array.isArray(denied) && denied.map(String).includes(id) || !allowed(config,key) && source.scopeAuthorized !== true) throw error('聊天或出资未获明确授权');
  if (!['platform','trial','byok'].includes(source.mode) || typeof source.id !== 'string' || !Number.isSafeInteger(source.version) || source.version < 1 || typeof source.model !== 'string'
    || !plain(source.prices) || !['inputCnyPerMillion','cacheHitCnyPerMillion','outputCnyPerMillion'].every(k => money(source.prices[k])) || source.prices.reasoningIncluded !== true) throw error('出资没有完整报价');
  return { ...source,endpoint:endpoint(source.endpoint) };
}
export function resolvePaidConversationApi(baseApi, { explicitOverride = false } = {}) {
  const context = currentConversationContext();
  if (!context || !fundingServices) return baseApi;
  const source = sourceFor(getConfig(),context.conversationKey);
  if (source.id !== context.fundingRef?.id || source.version !== context.fundingRef?.version) throw error('出资配置已变更');
  if (explicitOverride && (endpoint(baseApi.baseUrl) !== source.endpoint || baseApi.model !== source.model)) throw error('备选端点或模型未获得此出资授权');
  const targetChanged=endpoint(baseApi.baseUrl)!==source.endpoint||baseApi.model!==source.model;
  return { ...baseApi,...(targetChanged?{thinkingEffort:'',thinkingMode:'auto',thinkingBudget:0}:{}),baseUrl:source.endpoint,model:source.model,apiKey:source.mode === 'byok' ? source.apiKey : baseApi.apiKey };
}
export function capturePaidAuthority(key) {
  const cfg=getConfig();if(!Object.hasOwn(cfg,'productionBudget')&&!fundingServices&&process.env.QQ_AGENT_REQUIRE_BUDGET!=='1')return null;
  const source=sourceFor(cfg,key),ctx=currentConversationContext();
  if(ctx&&(ctx.conversationKey!==key||ctx.fundingRef.id!==source.id||ctx.fundingRef.version!==source.version))throw error('出资权限已变化');
  return {id:source.id,version:source.version};
}
export function assertPaidAuthority(key,token) {
  if(!token)return;
  const source=sourceFor(getConfig(),key);if(source.id!==token.id||source.version!==token.version)throw error('出资权限已撤销或变更');
}
export function capturePaidFunding(key) {
  const source=sourceFor(getConfig(),key),token=capturePaidAuthority(key);
  return {...token,mode:source.mode,ownerId:source.ownerId||null};
}
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
    || p.imageTokensPerImage !== undefined && p.imageTokensPerImage !== 1024
    || p.platformSuspended !== undefined && typeof p.platformSuspended!=='boolean'
    || p.totalDailyLimitCny !== undefined && !money(p.totalDailyLimitCny)) throw error('生产费用保护未就绪或缺少完整人民币报价');
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
  const p = effectivePolicy(config), key = context?.conversationKey;
  if (!context || context.botId !== 'primary') throw error('缺少可信聊天上下文');
  const source = sourceFor(config,key);
  if (context.fundingRef?.id !== source.id || context.fundingRef?.version !== source.version) throw error('出资授权已变化');
  return { ...p,endpoint:source.endpoint,model:source.model,prices:source.prices,verifiedResponseModels:source.responseModels || [],imageTokensPerImage:source.imageTokensPerImage,source };
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
  let trialBudget=null, totalBudget=null;
  // Optional per-instance ceiling, shared by every conversation, model retry,
  // tool round and speech synthesis. All reservations use this same transaction.
  function total(p) {
    if(p.totalDailyLimitCny===undefined){if(storage.readText('instance-total-enabled-marker')!==null)throw error('已经启用的机器人总额度不能直接移除','PAID_LEDGER_UNAVAILABLE');return null;}
    if(!totalBudget){
      const marker=storage.readText('instance-total-enabled-marker');
      if(marker===null&&budget.records().length)throw error('已有费用账本不能直接新增未衔接的机器人总额度','PAID_LEDGER_UNAVAILABLE');
      if(marker!==null){let parsed;try{parsed=JSON.parse(marker);}catch{}if(parsed?.version!==1)throw error('机器人总额度初始化标记损坏','PAID_LEDGER_UNAVAILABLE');}
      totalBudget=createConversationBudget({storage,file:'instance-total-budget',botId:'instance_total',now});
      if(marker===null)storage.writeText('instance-total-enabled-marker',JSON.stringify({version:1}),null);
    }
    const current=totalBudget.config();
    if(!current.enabled||current.defaultDailyLimitCny!==p.totalDailyLimitCny)totalBudget.update({configVersion:current.configVersion,enabled:true,defaultDailyLimitCny:p.totalDailyLimitCny});
    return totalBudget;
  }
  const serviceTokens = new WeakMap();
  const speechBudget = createConversationBudget({ storage, file:'speech-subsidy-budget', botId:'speech_subsidy', now });
  const speechTotal = createConversationBudget({ storage, file:'speech-platform-budget', botId:'speech_platform', now });
  function serviceAuthorization(check) {
    if(typeof check!=='function')throw error('缺少语音独立出资核验');
    const value=check();
    if(!plain(value)||typeof value.id!=='string'||!value.id||typeof value.version!=='string'||!value.version
      ||!money(value.scopeDailyLimitCny)||!money(value.platformDailyLimitCny)||!integer(value.cooldownMs)||value.cooldownMs<1000)throw error('语音出资或额度无效');
    return value;
  }
  function syncService(key, limits) {
    const scopeCfg=speechBudget.config();
    if(!scopeCfg.enabled||scopeCfg.overrides[key]?.dailyLimitCny!==limits.scopeDailyLimitCny)
      speechBudget.update({configVersion:scopeCfg.configVersion,enabled:true,defaultDailyLimitCny:0,overrides:{[key]:{enabled:true,dailyLimitCny:limits.scopeDailyLimitCny}}});
    const totalCfg=speechTotal.config();
    if(!totalCfg.enabled||totalCfg.defaultDailyLimitCny!==limits.platformDailyLimitCny)
      speechTotal.update({configVersion:totalCfg.configVersion,enabled:true,defaultDailyLimitCny:limits.platformDailyLimitCny});
  }
  function serviceState(token) { const state=serviceTokens.get(token);if(!state)throw error('语音预留句柄无效');return state; }
  function trial(p) {
    if(!p.trial||!money(p.trial.dailyLimitCny)||!plain(p.trial.initialSpent))throw error('平台体验总额保护未配置');
    if(!trialBudget)trialBudget=createConversationBudget({storage,file:'platform-trial-budget',botId:'platform_trial',now:()=>seedAt??now()});
    const raw=storage.readText('platform-trial-initial-marker'),seedHash=hash(p.trial.initialSpent);
    if(raw!==null){if(JSON.parse(raw).seedHash!==seedHash)throw error('体验初始余额已变更','PAID_LEDGER_UNAVAILABLE');}
    else {
      if(trialBudget.records().length)throw error('体验总账缺少初始化标记','PAID_LEDGER_UNAVAILABLE');
      trialBudget.update({configVersion:trialBudget.config().configVersion,enabled:false});
      try{for(const [date,amount]of Object.entries(p.trial.initialSpent)){if(!isDate(date)||!money(amount))throw error('体验初始费用无效');if(!amount)continue;seedAt=Date.parse(date+'T04:00:00Z');const hold=trialBudget.reserve('private:1',{operationId:'trial-seed:'+date,estimatedMaxCost:amount,quote:{currency:'CNY',complete:true}});if(!hold.allowed||!trialBudget.dispatch(hold.id).mayDispatch)throw error('体验初始费用入账失败');trialBudget.settle(hold.id,{amount,currency:'CNY'});}}finally{seedAt=null;}
      storage.writeText('platform-trial-initial-marker',JSON.stringify({version:1,seedHash}),null);
    }
    const cfg=trialBudget.config();if(!cfg.enabled||cfg.defaultDailyLimitCny!==p.trial.dailyLimitCny)trialBudget.update({configVersion:cfg.configVersion,enabled:true,defaultDailyLimitCny:p.trial.dailyLimitCny});
    return trialBudget;
  }
  function sync(p) {
    const current = budget.config(), target = { enabled: true, defaultDailyLimitCny: p.defaultDailyLimitCny,
      overrides: Object.fromEntries(Object.entries(p.overrides).map(([k, v]) => [k, { enabled: true, dailyLimitCny: v }])) };
    const removals = Object.fromEntries(Object.keys(current.overrides).filter(k => !Object.hasOwn(p.overrides, k)).map(k => [k, null]));
    if (current.enabled !== true || current.defaultDailyLimitCny !== target.defaultDailyLimitCny || stable(current.overrides) !== stable(target.overrides)) budget.update({ configVersion: current.configVersion, ...target, overrides: { ...removals, ...target.overrides } });
  }
  storage.transaction(() => {
    const p = effectivePolicy(config()), original = storage.readText('initial-spent-marker'), seedHash = hash(p.initialSpent);
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
    total(p);
  });
  return {
    status(key) { return storage.transaction(() => { sync(effectivePolicy(config())); return budget.status(key); }); },
    records: filters => budget.records(filters),
    trialStatus(){return storage.transaction(()=>trial(effectivePolicy(config())).status('private:1'));},
    totalStatus(){return storage.transaction(()=>total(effectivePolicy(config()))?.status('private:1')||null);},
    prepare({ api, body, purpose = 'chat', direct = true, platformCredential, operationId = crypto.randomUUID() }) {
      return storage.transaction(() => {
        const cfg = config(), context = currentConversationContext(), p = authorize(cfg, context); sync(p);
        const credential = p.source.mode === 'byok' ? p.source.apiKey : platformCredential;
        if (endpoint(api.baseUrl) !== p.endpoint || api.model !== p.model || !credential || api.apiKey !== credential) throw error('当前端点、模型或凭据不在出资授权内');
        if (!['chat', 'memory', 'proactive'].includes(purpose)) throw error('未知付费调用用途');
        const current = budget.status(context.conversationKey), first = constrainedBody(body, p, false), globalTrial=p.source.mode==='trial'?trial(p):null,globalTotal=total(p);
        const globalChecks=[globalTrial,globalTotal].filter(Boolean).map(ledger=>ledger.status('private:1'));
        const degraded = current.action !== 'normal' || current.enabled && current.spentCny + current.reservedCny + first.amount >= current.dailyLimitCny * 0.8 || globalChecks.some(s=>s.action!=='normal'||s.spentCny+s.reservedCny+first.amount>=s.dailyLimitCny*.8);
        if (degraded && (purpose !== 'chat' || !direct)) throw error('预算达到80%，已暂停主动参与和后台记忆整理');
        const quote = degraded ? constrainedBody(body, p, true) : first;
        const hold = budget.reserve(context.conversationKey, { operationId, estimatedMaxCost: quote.amount, quote: { currency: 'CNY', complete: true } });
        if (!hold.allowed) throw error(hold.reason || '今日会话预算不足');
        const trialHold=globalTrial?.reserve('private:1',{operationId:'trial:'+operationId,estimatedMaxCost:quote.amount,quote:{currency:'CNY',complete:true}});
        if(trialHold&&!trialHold.allowed)throw error('平台今日体验总额不足');
        const totalHold=globalTotal?.reserve('private:1',{operationId:'total:'+operationId,estimatedMaxCost:quote.amount,quote:{currency:'CNY',complete:true}});
        if(totalHold&&!totalHold.allowed)throw error('机器人今日总额度不足');
        const raw = storage.readText('call-attribution'), attribution = raw === null ? {} : JSON.parse(raw);
        attribution[hold.id] = { key:context.conversationKey,mode:p.source.mode,ownerId:p.source.ownerId || null,credentialRef:p.source.credentialRef || null,model:p.model };
        storage.writeText('call-attribution',JSON.stringify(attribution),raw);
        return { id: hold.id,trialHoldId:trialHold?.id||null,totalHoldId:totalHold?.id||null,key: context.conversationKey, requestId: context.requestId, model: p.model, endpoint: p.endpoint, sourceId:p.source.id,sourceVersion:p.source.version,
          prices: { ...p.prices }, responseModels: p.verifiedResponseModels || [], body: quote.body, degraded, purpose,
          configFingerprint: fundingFingerprint(p, context.conversationKey) };
      });
    },
    dispatch(token) {
      return storage.transaction(() => {
        const p = authorize(config(), currentConversationContext()); sync(p);
        if (currentConversationContext().conversationKey !== token.key || currentConversationContext().requestId !== token.requestId
          || token.sourceId !== p.source.id || token.sourceVersion !== p.source.version || token.configFingerprint !== fundingFingerprint(p, token.key)) throw error('付费来源或请求配置已变化');
        const current = budget.status(token.key),checks=[current,...[p.source.mode==='trial'?trial(p):null,total(p)].filter(Boolean).map(l=>l.status('private:1'))];
        if (checks.some(s=>s.action!=='normal') && !token.degraded) throw error('费用已达到节流阈值，请按新限制重新发起请求');
        const raw = storage.readText('interactive-cooldown'), prior = raw === null ? {} : JSON.parse(raw);
        if (!plain(prior) || Object.values(prior).some(x => !plain(x) || typeof x.requestId !== 'string' || !integer(x.at))) throw error('费用节流记录损坏', 'PAID_LEDGER_UNAVAILABLE');
        if (token.degraded && prior[token.key]?.requestId !== token.requestId && now() - (prior[token.key]?.at ?? -Infinity) < 60_000) throw error('预算节流中，请间隔至少60秒再发起回复');
        if (checks.some(s=>s.action!=='normal') && token.purpose !== 'chat') throw error('预算已达到80%，后台调用暂停');
        if (!budget.dispatch(token.id).mayDispatch) throw error('剩余额度或配置已变化，未发送调用暂停');
        if(token.trialHoldId&&!trial(p).dispatch(token.trialHoldId).mayDispatch)throw error('平台体验总额已变化');
        if(token.totalHoldId&&!total(p)?.dispatch(token.totalHoldId).mayDispatch)throw error('机器人今日总额度已变化');
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
      return storage.transaction(()=>{const value=budget.settle(token.id,{amount,currency:'CNY'});if(token.trialHoldId)trial(effectivePolicy(config())).settle(token.trialHoldId,{amount,currency:'CNY'});if(token.totalHoldId)totalBudget.settle(token.totalHoldId,{amount,currency:'CNY'});return value;});
    },
    unknown(token, reason = 'network_error') { return storage.transaction(()=>{const value=budget.markUnknown(token.id,{reason});if(token.trialHoldId)trial(effectivePolicy(config())).markUnknown(token.trialHoldId,{reason});if(token.totalHoldId)totalBudget.markUnknown(token.totalHoldId,{reason});return value;}); },
    release(token) { return storage.transaction(()=>{const value=budget.release(token.id);if(token.trialHoldId)trial(effectivePolicy(config())).release(token.trialHoldId);if(token.totalHoldId)totalBudget.release(token.totalHoldId);return value;}); },
    attributions() { const raw = storage.readText('call-attribution'); return raw === null ? {} : JSON.parse(raw); },
    serviceStatus(key, limits) { return storage.transaction(()=>{syncService(key,serviceAuthorization(()=>limits));return {scope:speechBudget.status(key),platform:speechTotal.status('private:1')};}); },
    prepareService({ service, operationId=crypto.randomUUID(), amountCny, assertAuthorized,purpose='requested',characters,voiceType }={}) {
      if(service!=='speech'||!['requested','automatic','preview'].includes(purpose)||typeof operationId!=='string'||!operationId||operationId.length>120||!money(amountCny)||amountCny<=0)throw error('语音调用报价或身份无效');
      if(characters!==undefined&&(!Number.isInteger(characters)||characters<1||characters>150)||voiceType!==undefined&&(!Number.isInteger(voiceType)||voiceType<=0))throw error('语音用量元数据无效');
      return storage.transaction(()=>{
        const context=currentConversationContext(),p=authorize(config(),context),limits=serviceAuthorization(assertAuthorized);sync(p);syncService(context.conversationKey,limits);
        const key=context.conversationKey,operation='service:speech:'+operationId;
        if(budget.records({key}).some(row=>row.operationId===operation))throw error('该语音操作已存在，禁止重复合成');
        const trialLedger=p.source.mode==='trial'?trial(p):null,totalLedger=total(p);
        const checks=[budget.status(key),speechBudget.status(key),speechTotal.status('private:1'),...[trialLedger,totalLedger].filter(Boolean).map(l=>l.status('private:1'))];
        if(checks.some(s=>s.action!=='normal'||s.spentCny+s.reservedCny+amountCny>=s.dailyLimitCny*.8))throw error('预算达到80%或语音补贴不足，已停止语音');
        const holds=[{ledger:budget,key},{ledger:speechBudget,key},{ledger:speechTotal,key:'private:1'},...[trialLedger,totalLedger].filter(Boolean).map(ledger=>({ledger,key:'private:1'}))].map((item,index)=>{
          const hold=item.ledger.reserve(item.key,{operationId:index===0?operation:operation+':'+index,estimatedMaxCost:amountCny,quote:{currency:'CNY',complete:true}});
          if(!hold.allowed)throw error('语音剩余额度不足');return {ledger:item.ledger,key:item.key,id:hold.id};
        });
        const token=Object.freeze({id:holds[0].id,key,operationId,amountCny});
        serviceTokens.set(token,{holds,assertAuthorized,authorization:hash(limits),totalLimit:p.totalDailyLimitCny??null,requestId:context.requestId,sourceId:p.source.id,sourceVersion:p.source.version,state:'reserved'});
        const raw=storage.readText('call-attribution'),rows=raw===null?{}:JSON.parse(raw);
        rows[token.id]={key,kind:'speech',provider:'tencent',mode:'platform-speech',ownerId:null,credentialRef:null,llmFundingMode:p.source.mode,llmOwnerId:p.source.ownerId||null,speechPurpose:purpose,model:'tencent-tts',estimated:true,basis:'list-price-free-package-unsynchronized',...(characters===undefined?{}:{characters}),...(voiceType===undefined?{}:{voiceType})};
        storage.writeText('call-attribution',JSON.stringify(rows),raw);return token;
      });
    },
    dispatchService(token) {
      return storage.transaction(()=>{
        const state=serviceState(token),context=currentConversationContext(),p=authorize(config(),context),limits=serviceAuthorization(state.assertAuthorized);sync(p);syncService(token.key,limits);total(p);
        if(state.state!=='reserved'||context.conversationKey!==token.key||context.requestId!==state.requestId||p.source.id!==state.sourceId||p.source.version!==state.sourceVersion||hash(limits)!==state.authorization||state.totalLimit!==(p.totalDailyLimitCny??null))throw error('语音权限或出资已变更');
        if(state.holds.some(h=>h.ledger.status(h.key).action!=='normal'))throw error('语音预算达到节流阈值');
        const raw=storage.readText('speech-cooldown'),rows=raw===null?{}:JSON.parse(raw);
        if(!plain(rows)||Object.values(rows).some(row=>!plain(row)||!integer(row.at)))throw error('语音冷却记录损坏','PAID_LEDGER_UNAVAILABLE');
        if(rows[token.key]&&now()-rows[token.key].at<limits.cooldownMs)throw error('语音冷却中');
        for(const hold of state.holds)if(!hold.ledger.dispatch(hold.id).mayDispatch)throw error('语音额度已变更');
        Object.defineProperty(rows,token.key,{value:{at:now()},enumerable:true,configurable:true,writable:true});storage.writeText('speech-cooldown',JSON.stringify(rows),raw);
        state.state='dispatched';
      });
    },
    settleService(token) { return storage.transaction(()=>{const state=serviceState(token);const values=state.holds.map(h=>h.ledger.settle(h.id,{amount:token.amountCny,currency:'CNY'}));state.state='settled';return values[0];}); },
    unknownService(token,reason='network_error') { return storage.transaction(()=>{const state=serviceState(token);const values=state.holds.map(h=>h.ledger.markUnknown(h.id,{reason}));state.state='unknown';return values[0];}); },
    releaseService(token) { return storage.transaction(()=>{const state=serviceState(token);if(state.state!=='reserved')throw error('已发送语音不能释放费用');const values=state.holds.map(h=>h.ledger.release(h.id));state.state='released';return values[0];}); },
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

const fundedKeys = (cfg, p) => [...new Set([...Object.keys(p.funding),...(fundingServices?.policy()?.scopeKeys||[])])].filter(key => {try{return Boolean(sourceFor(cfg,key));}catch{return false;}}).sort();
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
/** Called only behind authenticated management routes. authorizeScope is a
 * server-only authority check for resources that need not have funding yet;
 * native callers retain the existing funded-resource boundary. */
export function updateProductionBudgetLimits(patch,{authorizeScope}={}) {
  const invalid = message => Object.assign(error(message), { statusCode: 400 });
  if (!plain(patch) || Object.keys(patch).some(key => !['version', 'defaultDailyLimitCny', 'overrides'].includes(key)) || typeof patch.version !== 'string') throw invalid('只允许修改默认每日额度和已授权聊天的独立额度');
  const cfg = getConfig(), p = policy(cfg), scopes = new Set(fundedKeys(cfg, p));
  if (patch.version !== limitsVersion(cfg, p)) throw Object.assign(error('额度设置已变化，请刷新后再保存'), { statusCode: 409 });
  const validAmount = amount => money(amount) && Math.abs(amount * MICRO - Math.round(amount * MICRO)) < 0.00001;
  if (Object.hasOwn(patch, 'defaultDailyLimitCny') && !validAmount(patch.defaultDailyLimitCny)) throw invalid('每日额度须为非负数，最多六位小数');
  if (authorizeScope!==undefined&&typeof authorizeScope!=='function') throw invalid('聊天额度授权校验无效');
  if (Object.hasOwn(patch, 'overrides') && (!plain(patch.overrides) || Object.entries(patch.overrides).some(([key, amount]) => !chatKey(key) || !(scopes.has(key)||authorizeScope?.(key)===true) || amount !== null && !validAmount(amount)))) throw invalid('只能设置已有授权聊天的每日额度');
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
  const source = sourceFor(config,key);
  const context = { botId: 'primary', conversationKey: key, actorId: 'server', fundingRef: { id: source.id, version: source.version }, personaRef: { id: 'server-selected', version: 1 } };
  authorize(config, context); return runWithConversationContext(context, work);
}
