// Read-only reporting from the primary paid ledger. Auxiliary quota holds are
// deliberately excluded. Reading a report never initializes or settles a ledger.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beijingBudgetDate } from './conversation-budget.js';

const DAY = 86400000;
const keyValid = value => typeof value === 'string' && /^(group|private):[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.split(':')[1]));
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const fail = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });
const numericFields = ['attempts', 'dispatched', 'succeeded', 'unknown', 'released', 'inflight', 'knownCharacters', 'charactersUnknownAttempts', 'knownSucceededCharacters', 'succeededCharactersUnknownAttempts', 'estimatedMicros', 'reservedMicros', 'unknownMicros'];
const empty = () => Object.fromEntries(numericFields.map(name => [name, 0]));
function add(target, row) {
  for (const name of numericFields) {
    const value = row[name];
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(target[name] + value)) throw fail('语音用量账本数据异常', 503);
    target[name] += value;
  }
}
function projection(value) {
  const { estimatedMicros, reservedMicros, unknownMicros, ...counts } = value;
  return { ...counts, characters: counts.charactersUnknownAttempts ? null : counts.knownCharacters,
    succeededCharacters: counts.succeededCharactersUnknownAttempts ? null : counts.knownSucceededCharacters,
    estimatedCny: estimatedMicros / 1e6, reservedCny: reservedMicros / 1e6, unknownCny: unknownMicros / 1e6 };
}

const aggregateSql = `
WITH attrs AS MATERIALIZED (
  SELECT a.key AS id, json_extract(a.value,'$.key') AS chatKey,
    CASE WHEN json_type(a.value,'$.characters')='integer'
      AND json_extract(a.value,'$.characters') BETWEEN 1 AND 150
      THEN json_extract(a.value,'$.characters') ELSE NULL END AS characters
  FROM paid_documents d, json_each(d.body) a
  WHERE d.name='call-attribution' AND json_extract(a.value,'$.kind')='speech'
), records AS MATERIALIZED (
  SELECT json_extract(r.value,'$.id') AS id, json_extract(r.value,'$.key') AS chatKey,
    json_extract(r.value,'$.date') AS date, json_extract(r.value,'$.state') AS state,
    json_extract(r.value,'$.amountMicros') AS amount, json_extract(r.value,'$.actualMicros') AS actual,
    json_type(r.value,'$.amountMicros') AS amountType,json_type(r.value,'$.actualMicros') AS actualType
  FROM paid_documents d, json_each(d.body,'$.records') r
  WHERE d.name='conversation-budget'
    AND json_extract(r.value,'$.operationId') LIKE 'service:speech:%'
    AND json_extract(r.value,'$.date') BETWEEN ? AND ?
    AND (? IS NULL OR json_extract(r.value,'$.key') IN (SELECT value FROM json_each(?)))
)
SELECT r.chatKey,r.date,COUNT(*) AS attempts,SUM(a.id IS NULL) AS unclassified,
  SUM(r.amountType!='integer' OR r.amount<1 OR (r.state='settled' AND (r.actualType!='integer' OR r.actual<0))) AS invalidAmounts,
  SUM(r.state IN ('dispatched','settled','unknown')) AS dispatched,
  SUM(r.state='settled') AS succeeded,SUM(r.state='unknown') AS unknown,
  SUM(r.state='released') AS released,SUM(r.state IN ('reserved','dispatched')) AS inflight,
  SUM(COALESCE(a.characters,0)) AS knownCharacters,SUM(a.characters IS NULL) AS charactersUnknownAttempts,
  SUM(CASE WHEN r.state='settled' THEN COALESCE(a.characters,0) ELSE 0 END) AS knownSucceededCharacters,
  SUM(r.state='settled' AND a.characters IS NULL) AS succeededCharactersUnknownAttempts,
  SUM(CASE WHEN r.state='settled' THEN r.actual ELSE 0 END) AS estimatedMicros,
  SUM(CASE WHEN r.state IN ('reserved','dispatched','unknown') THEN r.amount ELSE 0 END) AS reservedMicros,
  SUM(CASE WHEN r.state='unknown' THEN r.amount ELSE 0 END) AS unknownMicros
FROM records r LEFT JOIN attrs a ON a.id=r.id AND a.chatKey=r.chatKey
GROUP BY r.chatKey,r.date ORDER BY r.date DESC,r.chatKey`;

export function createSpeechUsage({ file, auth, now = Date.now } = {}) {
  if (typeof file !== 'string' || !file || !auth) throw fail('语音用量服务未配置', 503);
  return {
    async usage(principal, input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => !['chatKey', 'days', 'from', 'to'].includes(name))) throw fail('语音用量查询参数无效');
      let user = auth.verifyPrincipal(principal);
      const today = beijingBudgetDate(now()), days = input.days ?? 7;
      if (!Number.isInteger(days) || ![1, 7, 30, 90].includes(days)) throw fail('请选择今天、7天、30天或90天');
      const to = input.to ?? today;
      const from = input.from ?? (dateValid(to) ? new Date(Date.parse(to + 'T00:00:00Z') - (days - 1) * DAY).toISOString().slice(0, 10) : '');
      if (!dateValid(from) || !dateValid(to) || from > to || to > today || Date.parse(to) - Date.parse(from) > 89 * DAY) throw fail('语音用量日期范围须在90天内且不能晚于今天');
      if (input.chatKey !== undefined) {
        if (!keyValid(input.chatKey)) throw fail('请选择有效的群聊或私聊');
        await auth.ensureAccess(user, input.chatKey, { botId: 'primary' });
      }
      // No await after the final principal/scope checks: revocation is observed
      // before the synchronous SQLite snapshot is read.
      user = auth.verifyPrincipal(user);
      const keys = input.chatKey ? [input.chatKey] : user.role === 'admin' ? null : auth.listScopes(user, { botId: 'primary' }).filter(key => auth.canAccess(user, key, { botId: 'primary' }));
      if (input.chatKey && !auth.canAccess(user, input.chatKey, { botId: 'primary' })) throw fail('没有此聊天权限', 403);
      if (keys && (keys.length > 10000 || keys.some(key => !keyValid(key)))) throw fail('语音用量资源范围无效', 503);
      let rows = [], db;
      try {
        if (fs.existsSync(file) && (!keys || keys.length)) {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw Error('invalid');
          db = new DatabaseSync(file, { readOnly: true });
          db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN');
          if (db.prepare('PRAGMA application_id').get().application_id !== 0x51425047 || db.prepare('PRAGMA user_version').get().user_version !== 1) throw Error('identity');
          const docs = db.prepare("SELECT name,json_valid(body) AS valid,json_type(body) AS type,json_extract(body,'$.version') AS version,json_extract(body,'$.botId') AS botId,json_type(body,'$.records') AS recordsType,json_array_length(body,'$.records') AS count FROM paid_documents WHERE name IN ('conversation-budget','call-attribution')").all();
          for (const doc of docs) if (!doc.valid || doc.type !== 'object' || doc.name === 'conversation-budget' && (doc.version !== 1 || doc.botId !== 'primary' || doc.recordsType !== 'array' || doc.count > 100000)) throw Error('documents');
          const scopeJson = keys === null ? null : JSON.stringify(keys);
          rows = db.prepare(aggregateSql).all(from, to, scopeJson, scopeJson);
          db.exec('COMMIT');
        }
      } catch { throw fail('暂时无法读取语音用量，请稍后再试', 503); }
      finally { db?.close(); }
      const total = empty(), daily = new Map(), chats = new Map();
      for (const row of rows) {
        if (row.unclassified || row.invalidAmounts || !keyValid(row.chatKey) || !dateValid(row.date) || row.attempts !== row.succeeded + row.unknown + row.released + row.inflight) throw fail('语音用量账本数据异常', 503);
        add(total, row);
        if (!daily.has(row.date)) daily.set(row.date, empty());
        if (!chats.has(row.chatKey)) chats.set(row.chatKey, empty());
        add(daily.get(row.date), row); add(chats.get(row.chatKey), row);
      }
      return { botId: 'primary', currency: 'CNY', estimated: true, timezone: 'Asia/Shanghai', from, to,
        scope: input.chatKey ? 'conversation' : user.role === 'admin' ? 'platform' : 'authorized', chatKey: input.chatKey ?? null,
        totals: projection(total), daily: [...daily].map(([date, value]) => ({ date, ...projection(value) })),
        conversations: [...chats].sort((a, b) => b[1].attempts - a[1].attempts || a[0].localeCompare(b[0])).slice(0, 200).map(([chatKey, value]) => ({ chatKey, ...projection(value) })),
        conversationsTruncated: chats.size > 200, conversationCount: chats.size,
        estimationBoundary: '仅汇总主账语音记录，辅助额度账不重复计入；按请求创建日（北京时间）统计。金额为标价估算与预留，腾讯免费资源包抵扣、余额和实际账单未同步。',
        characterBoundary: '字符按请求保存的报价数量统计，不等于腾讯已计费字符；旧记录未保存字符时显示不可追溯，不按金额倒推。成功合成不代表QQ已送达。' };
    }
  };
}
