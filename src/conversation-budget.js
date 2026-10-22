// Conversation spending admission. Independent of account roles, funding and model engines.
// The injected storage must provide synchronous rollback transactions and compare-and-swap writes.
import crypto from 'node:crypto';

const UNIT = 1_000_000, MAX_CNY = 1_000_000, DAY = 86_400_000, OFFSET = 8 * 3_600_000;
const MAX_TIME = Date.UTC(10000, 0, 1) - OFFSET - 1;
const OPEN = new Set(['reserved', 'dispatched', 'unknown']);
const STATES = new Set([...OPEN, 'settled', 'released']);
const own = (value, name) => Object.hasOwn(value, name);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const clone = value => structuredClone(value);
const fail = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
const validBot = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const validKey = value => typeof value === 'string' && /^(group|private):[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.split(':')[1]));
const validLabel = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const validMicros = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_CNY * UNIT;
const cny = value => value / UNIT;
function micros(value, { positive = false, precise = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_CNY || (positive && value === 0)) throw fail('金额必须是有效的人民币数值');
  if (precise && Math.abs(value * UNIT - Math.round(value * UNIT)) > 0.00001) throw fail('配置金额最多六位小数');
  return value > 0 ? Math.max(1, Math.ceil(value * UNIT - 0.0000001)) : 0;
}
function add(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw fail('预算累计金额超出安全范围，已停止准入', 503);
  return result;
}
export function beijingBudgetDate(at = Date.now()) {
  if (!validTime(at)) throw fail('预算时间无效');
  return new Date(at + OFFSET).toISOString().slice(0, 10);
}
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const validOverride = value => exact(value, ['enabled', 'dailyLimitMicros'])
  && (!own(value, 'enabled') || typeof value.enabled === 'boolean')
  && (!own(value, 'dailyLimitMicros') || validMicros(value.dailyLimitMicros));
function fresh(botId) {
  return { version: 1, botId, configVersion: 1,
    config: { enabled: true, defaultDailyLimitMicros: UNIT, leaseMs: 30 * 60_000, overrides: {} },
    records: [] };
}
export function validateConversationBudgetText(text, botId) {
  const invalid = () => { throw fail('会话预算数据损坏或版本不支持，已停止改写', 503); };
  let data;
  try { if (typeof text !== 'string') invalid(); data = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { invalid(); }
  if (!exact(data, ['version', 'botId', 'configVersion', 'config', 'records']) || Object.keys(data).length !== 5
    || data.version !== 1 || !validBot(data.botId) || (botId !== undefined && data.botId !== botId)
    || !Number.isSafeInteger(data.configVersion) || data.configVersion < 1) invalid();
  const cfg = data.config;
  if (!exact(cfg, ['enabled', 'defaultDailyLimitMicros', 'leaseMs', 'overrides']) || Object.keys(cfg).length !== 4
    || typeof cfg.enabled !== 'boolean' || !validMicros(cfg.defaultDailyLimitMicros)
    || !Number.isSafeInteger(cfg.leaseMs) || cfg.leaseMs < 60_000 || cfg.leaseMs > DAY || !object(cfg.overrides) || Object.keys(cfg.overrides).length > 10000) invalid();
  for (const [key, value] of Object.entries(cfg.overrides)) if (!validKey(key) || !validOverride(value)) invalid();
  if (!Array.isArray(data.records) || data.records.length > 100000) invalid();
  const ids = new Set(), operations = new Set();
  for (const row of data.records) {
    if (!exact(row, ['id', 'key', 'date', 'operationId', 'amountMicros', 'actualMicros', 'createdAt', 'updatedAt', 'expiresAt', 'resolvedAt', 'state', 'unknownReason']) || Object.keys(row).length !== 12
      || typeof row.id !== 'string' || !/^[a-f0-9]{32}$/.test(row.id) || ids.has(row.id) || !validKey(row.key) || !validDate(row.date)
      || !validLabel(row.operationId) || operations.has(row.operationId) || !validMicros(row.amountMicros) || row.amountMicros === 0
      || !(row.actualMicros === null || validMicros(row.actualMicros)) || !validTime(row.createdAt) || !validTime(row.updatedAt)
      || row.updatedAt < row.createdAt || !validTime(row.expiresAt) || row.expiresAt <= row.createdAt || beijingBudgetDate(row.createdAt) !== row.date
      || !(row.resolvedAt === null || validTime(row.resolvedAt) && row.resolvedAt >= row.createdAt) || !STATES.has(row.state)
      || (OPEN.has(row.state) ? row.resolvedAt !== null : row.resolvedAt === null)
      || (row.state === 'settled' ? row.actualMicros === null : row.actualMicros !== null)
      || !(row.unknownReason === null || typeof row.unknownReason === 'string' && /^[a-z_]{1,40}$/.test(row.unknownReason))) invalid();
    ids.add(row.id); operations.add(row.operationId);
  }
  return data;
}

/** Ledger and holds are committed together; no network request or account privilege lives here. */
export function createConversationBudget({ storage, file, botId = 'primary', now = Date.now } = {}) {
  if (!storage || !['transaction', 'readText', 'writeText'].every(name => typeof storage[name] === 'function') || typeof file !== 'string' || !file || !validBot(botId) || typeof now !== 'function') throw fail('会话预算缺少事务存储、路径或实例身份', 503);
  function transact(run) {
    const result = storage.transaction(() => {
      let raw;
      try { raw = storage.readText(file); } catch (error) { if (error.code !== 'ENOENT') throw error; raw = null; }
      const data = raw === null ? fresh(botId) : validateConversationBudgetText(raw, botId), at = now();
      if (!validTime(at)) throw fail('预算时间无效', 503);
      const value = run(data, at);
      if (value?.then) throw fail('预算事务不能包含异步操作', 503);
      const next = JSON.stringify(data) + '\n';
      if (next !== raw) { validateConversationBudgetText(next, botId); const written = storage.writeText(file, next, raw); if (written?.then) throw fail('预算存储必须同步提交', 503); }
      return value;
    });
    if (result?.then) throw fail('预算存储必须使用同步事务', 503);
    return result;
  }
  function publicConfig(data) {
    return { botId, configVersion: data.configVersion, enabled: data.config.enabled,
      defaultDailyLimitCny: cny(data.config.defaultDailyLimitMicros), leaseMs: data.config.leaseMs,
      overrides: Object.fromEntries(Object.entries(data.config.overrides).map(([key, row]) => [key, { ...(own(row, 'enabled') ? { enabled: row.enabled } : {}), ...(own(row, 'dailyLimitMicros') ? { dailyLimitCny: cny(row.dailyLimitMicros) } : {}) }])) };
  }
  function publicRecord(row) {
    return { id: row.id, botId, key: row.key, date: row.date, operationId: row.operationId, state: row.state,
      amountCny: cny(row.amountMicros), actualCny: row.actualMicros === null ? null : cny(row.actualMicros), createdAt: row.createdAt,
      updatedAt: row.updatedAt, expiresAt: row.expiresAt, resolvedAt: row.resolvedAt, unknownReason: row.unknownReason };
  }
  function status(data, key, at) {
    if (!validKey(key)) throw fail('会话须为规范的 group:群号 或 private:QQ号');
    const date = beijingBudgetDate(at), override = data.config.overrides[key] || {}, enabled = override.enabled ?? data.config.enabled;
    const limit = override.dailyLimitMicros ?? data.config.defaultDailyLimitMicros;
    let spent = 0, held = 0, count = 0, uncertain = 0, stale = 0;
    for (const row of data.records) {
      if (row.key !== key) continue;
      if (row.state === 'settled' && row.date === date) spent = add(spent, row.actualMicros);
      // An unresolved request still consumes admission on a new day and after a lease expires.
      if (OPEN.has(row.state)) { held = add(held, row.amountMicros); count++; if (row.state === 'unknown') uncertain++; if (row.expiresAt <= at) stale++; }
    }
    const used = add(spent, held), state = !enabled ? 'disabled' : used >= limit ? 'exhausted' : used * 5 >= limit * 4 ? 'degraded' : 'normal';
    return { botId, key, date, currency: 'CNY', enabled, dailyLimitCny: cny(limit), spentCny: cny(spent), reservedCny: cny(held),
      remainingCny: cny(Math.max(0, limit - used)), ratio: limit === 0 ? 1 : used / limit, state,
      action: state === 'exhausted' ? 'reject' : state === 'degraded' ? 'degrade' : 'normal', configVersion: data.configVersion,
      activeReservations: count, unknownReservations: uncertain, staleReservations: stale, estimated: true,
      estimationBoundary: '平台人民币估算与在途预留；不是供应商账单硬上限。未知费用需核对，租约到期不会自动退回额度。' };
  }
  function find(data, id) { const row = data.records.find(row => row.id === id); if (!row) throw fail('预算预留不存在', 404); return row; }
  function touch(row, at) { row.updatedAt = Math.max(at, row.updatedAt); }
  transact(() => {});
  return {
    config: () => transact(publicConfig),
    status: key => transact((data, at) => status(data, key, at)),
    overview(keys = []) {
      if (!Array.isArray(keys) || keys.length > 10000 || keys.some(key => !validKey(key))) throw fail('预算会话列表无效');
      return transact((data, at) => ({ date: beijingBudgetDate(at), config: publicConfig(data), conversations: [...new Set(keys)].map(key => status(data, key, at)) }));
    },
    update(patch) {
      if (!exact(patch, ['configVersion', 'enabled', 'defaultDailyLimitCny', 'leaseMs', 'overrides']) || !Number.isSafeInteger(patch.configVersion)) throw fail('预算配置及版本无效');
      return transact(data => {
        if (patch.configVersion !== data.configVersion) throw fail('预算配置已变化，请刷新重试', 409);
        const next = clone(data.config);
        if (own(patch, 'enabled')) { if (typeof patch.enabled !== 'boolean') throw fail('预算启用值无效'); next.enabled = patch.enabled; }
        if (own(patch, 'defaultDailyLimitCny')) next.defaultDailyLimitMicros = micros(patch.defaultDailyLimitCny, { precise: true });
        if (own(patch, 'leaseMs')) next.leaseMs = patch.leaseMs;
        if (own(patch, 'overrides')) {
          if (!object(patch.overrides) || Object.keys(patch.overrides).length > 10000) throw fail('会话预算覆盖配置无效');
          for (const [key, value] of Object.entries(patch.overrides)) {
            if (!validKey(key)) throw fail('会话预算对象无效');
            if (value === null) { delete next.overrides[key]; continue; }
            if (!exact(value, ['enabled', 'dailyLimitCny'])) throw fail('会话预算覆盖字段无效');
            const row = {};
            if (own(value, 'enabled')) { if (typeof value.enabled !== 'boolean') throw fail('会话预算启用值无效'); row.enabled = value.enabled; }
            if (own(value, 'dailyLimitCny')) row.dailyLimitMicros = micros(value.dailyLimitCny, { precise: true });
            next.overrides[key] = row;
          }
        }
        try { validateConversationBudgetText(JSON.stringify({ ...data, config: next }), botId); } catch { throw fail('预算配置值无效'); }
        if (JSON.stringify(next) !== JSON.stringify(data.config)) { data.config = next; data.configVersion++; }
        return publicConfig(data);
      });
    },
    reserve(key, options = {}) {
      if (!validKey(key) || !exact(options, ['operationId', 'estimatedMaxCost', 'quote']) || !validLabel(options.operationId) || !own(options, 'estimatedMaxCost')) throw fail('预算预留对象或调用身份无效');
      micros(options.estimatedMaxCost, { positive: true });
      if (own(options, 'quote') && !exact(options.quote, ['currency', 'complete'])) throw fail('预算报价字段无效');
      return transact((data, at) => {
        const current = status(data, key, at), prior = data.records.find(row => row.operationId === options.operationId);
        if (prior) {
          if (prior.key !== key || own(options, 'estimatedMaxCost') && micros(options.estimatedMaxCost, { positive: true }) !== prior.amountMicros
            || own(options, 'quote') && (options.quote.currency !== 'CNY' || options.quote.complete !== true)) throw fail('预算操作ID已用于不同的调用', 409);
          return { ...current, allowed: prior.state === 'reserved', reused: true, id: prior.id, reservation: publicRecord(prior), reason: prior.state === 'reserved' ? null : '该次调用已发送或结束，不能重复消费' };
        }
        if (options.quote?.currency !== 'CNY' || options.quote?.complete !== true) return { ...current, state: 'unsupported', action: 'reject', allowed: false, reused: false, id: null, reservation: null, reason: '缺少完整人民币报价，已停止新的付费调用' };
        if (current.action === 'reject') return { ...current, allowed: false, reused: false, id: null, reservation: null, reason: '此会话今日预算已用尽' };
        const amount = micros(options.estimatedMaxCost, { positive: true });
        if (current.enabled && amount > micros(current.remainingCny)) return { ...current, allowed: false, reused: false, id: null, reservation: null, reason: '剩余额度不足以预留本次调用', action: 'reject' };
        if (data.records.length >= 100000) throw fail('预算审计记录已达上限，需要先归档，已停止准入', 503);
        if (!validTime(at + data.config.leaseMs)) throw fail('预算时间超出支持范围', 503);
        const row = { id: crypto.randomBytes(16).toString('hex'), key, date: current.date, operationId: options.operationId,
          amountMicros: amount, actualMicros: null, createdAt: at, updatedAt: at, expiresAt: at + data.config.leaseMs,
          resolvedAt: null, state: 'reserved', unknownReason: null };
        data.records.push(row); const after = status(data, key, at);
        return { ...after, allowed: true, reused: false, id: row.id, reservation: publicRecord(row), action: ['degraded', 'exhausted'].includes(after.state) ? 'degrade' : 'normal', reason: null };
      });
    },
    dispatch(id) {
      return transact((data, at) => {
        const row = find(data, id), current = status(data, row.key, at);
        const used = add(micros(current.spentCny), micros(current.reservedCny));
        const policyAllows = !current.enabled || used <= micros(current.dailyLimitCny);
        const mayDispatch = row.state === 'reserved' && policyAllows;
        if (mayDispatch) { row.state = 'dispatched'; touch(row, at); }
        return { mayDispatch, reservation: publicRecord(row), status: current,
          reason: policyAllows ? null : '预算配置或费用已变化，未发送的调用暂停' };
      });
    },
    markUnknown(id, options = {}) {
      if (!exact(options, ['reason'])) throw fail('未知费用原因字段无效');
      const reason = options.reason ?? 'uncertain';
      if (typeof reason !== 'string' || !/^[a-z_]{1,40}$/.test(reason)) throw fail('未知费用原因无效');
      return transact((data, at) => { const row = find(data, id); if (row.state === 'reserved') throw fail('尚未发送的调用不能标为未知费用', 409); if (['dispatched', 'unknown'].includes(row.state)) { row.state = 'unknown'; row.unknownReason = reason; touch(row, at); } return publicRecord(row); });
    },
    settle(id, actual) {
      if (!exact(actual, ['amount', 'currency']) || actual.currency !== 'CNY') throw fail('结算只接受有效人民币估算');
      const amount = micros(actual.amount);
      return transact((data, at) => {
        const row = find(data, id);
        if (row.state === 'released' || row.state === 'reserved') throw fail('尚未发送或已确认未计费的调用不能结算', 409);
        if (row.state === 'settled') { if (row.actualMicros !== amount) throw fail('该调用已按其他金额结算', 409); return publicRecord(row); }
        row.state = 'settled'; row.actualMicros = amount; row.resolvedAt = Math.max(at, row.updatedAt); touch(row, at);
        // Preserve actual cost even above its reservation or daily limit.
        status(data, row.key, at); return publicRecord(row);
      });
    },
    release(id, options = {}) {
      if (!exact(options, ['confirmedNotCharged']) || own(options, 'confirmedNotCharged') && typeof options.confirmedNotCharged !== 'boolean') throw fail('释放预算的确认参数无效');
      return transact((data, at) => { const row = find(data, id); if (row.state === 'settled' || row.state === 'released') return publicRecord(row);
        if (row.state !== 'reserved' && options.confirmedNotCharged !== true) throw fail('已发送或费用未知的调用必须确认未计费后才能释放', 409);
        row.state = 'released'; row.resolvedAt = Math.max(at, row.updatedAt); touch(row, at); return publicRecord(row); });
    },
    active: () => transact(data => data.records.filter(row => OPEN.has(row.state)).map(publicRecord)),
    records({ key, date } = {}) {
      if (key !== undefined && !validKey(key) || date !== undefined && !validDate(date)) throw fail('预算记录筛选无效');
      return transact(data => data.records.filter(row => (key === undefined || row.key === key) && (date === undefined || row.date === date)).map(publicRecord));
    },
  };
}
