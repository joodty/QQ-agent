// SQLite persona-specific archives. Imports are inert JSON; this module never executes history.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const APP_ID = 0x51414348, BUNDLE_VERSION = 1, DB_VERSION = 2, MAX_BYTES = 64 * 1024 * 1024;
const CONTINUATIONS = ['ready', 'blocked', 'missing', 'deleted-persona'];
const TABLES = ['archive_sources', 'archive_personas', 'conversation_archives', 'archive_selections', 'archive_imports'];
const problem = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const id = value => text(value, 200) && !/[\r\n\t]/.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const key = value => typeof value === 'string' && /^(group|private):[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value.split(':')[1]));
const bot = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const clone = value => structuredClone(value);
function jsonValue(value, depth = 0, parsed = false) {
  if (depth > 40) throw problem('历史 JSON 层级过深');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (value.length > 4 * 1024 * 1024) throw problem('历史文本过长'); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw problem('历史包含无效数字'); return; }
  if (!Array.isArray(value) && !plain(value)) throw problem('历史只接受惰性 JSON 数据');
  if (!parsed && (Object.getOwnPropertySymbols(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => d.get || d.set))) throw problem('历史不能包含访问器或 Symbol');
  if (Object.keys(value).length > 100000) throw problem('历史条目过多');
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw problem('历史数组不能包含空位或额外属性');
  for (const item of Object.values(value)) jsonValue(item, depth + 1, parsed);
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(name => JSON.stringify(name) + ':' + stable(value[name])).join(',') + '}';
  return JSON.stringify(value);
}
const fingerprint = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
function boundedJson(value) { jsonValue(value); const encoded = stable(value); if (Buffer.byteLength(encoded) > MAX_BYTES) throw problem('历史 JSON 超过大小上限'); return encoded; }
function decoded(value) { try { const result = JSON.parse(value); boundedJson(result); return result; } catch { throw problem('SQLite 档案 JSON 损坏，拒绝改写', 503); } }
// JSON.parse cannot produce getters/functions. Validate parsed JSON without re-serializing its entire history.
function decodedRead(value) { try { if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) throw Error(); const result = JSON.parse(value); jsonValue(result, 0, true); return result; } catch { throw problem('SQLite 档案 JSON 损坏，拒绝读取', 503); } }
function persona(value) {
  if (!exact(value, ['id', 'name', 'content', 'version', 'history']) || !id(value.id) || !text(value.name, 200, true) || !text(value.content, 1024 * 1024, true)
      || !Number.isSafeInteger(value.version) || value.version < 1 || !Array.isArray(value.history) || value.history.length > 10000) throw problem('人设档案格式无效');
  boundedJson(value.history); return value;
}
const ENTRY_REQUIRED = ['id', 'mid', 'ts', 'senderId', 'senderName', 'text', 'self', 'read', 'reply', 'media'];
const ENTRY_OPTIONAL = ['isPoke', 'atMe', 'atNames', 'recalled'];
function messages(values, imported = false, parsed = false) {
  if (!Array.isArray(values) || values.length > 100000) throw problem('消息列表无效');
  let previous = 0;
  for (const value of values) {
    if (!plain(value) || ENTRY_REQUIRED.some(name => !Object.hasOwn(value, name)) || Object.keys(value).some(name => ![...ENTRY_REQUIRED, ...ENTRY_OPTIONAL].includes(name))
      || !Number.isSafeInteger(value.id) || value.id <= previous || value.id >= Number.MAX_SAFE_INTEGER
      || !(value.mid === null || typeof value.mid === 'string' && value.mid.length <= 300 || Number.isSafeInteger(value.mid)) || !time(value.ts)
      || !text(value.senderId, 200, true) || !text(value.senderName, 1000, true) || !text(value.text, 1024 * 1024, true)
      || typeof value.self !== 'boolean' || typeof value.read !== 'boolean' || imported && value.read !== true
      || !(value.reply === null || plain(value.reply)) || !Array.isArray(value.media)
      || Object.hasOwn(value, 'isPoke') && typeof value.isPoke !== 'boolean' || Object.hasOwn(value, 'recalled') && typeof value.recalled !== 'boolean'
      || Object.hasOwn(value, 'atMe') && value.atMe !== null && typeof value.atMe !== 'boolean'
      || Object.hasOwn(value, 'atNames') && (!Array.isArray(value.atNames) || value.atNames.length > 100 || value.atNames.some(name => typeof name !== 'string' || name.length > 1000))) throw problem('消息条目无效或导入消息未标为已读');
    if (!parsed) boundedJson(value); previous = value.id;
  }
  return previous;
}
function archive(value) {
  const required = ['id', 'chatKey', 'personaId', 'legacySessionId', 'createdAt', 'lastUsedAt', 'messages', 'transcript'];
  if (!plain(value) || required.some(name => !Object.hasOwn(value, name)) || Object.keys(value).some(name => ![...required, 'continuation'].includes(name))
      || !id(value.id) || !key(value.chatKey) || !id(value.personaId) || !(value.legacySessionId === null || id(value.legacySessionId))
      || !time(value.createdAt) || !time(value.lastUsedAt) || value.lastUsedAt < value.createdAt || !Array.isArray(value.transcript)
      || Object.hasOwn(value, 'continuation') && !CONTINUATIONS.includes(value.continuation)) throw problem('会话档案格式无效');
  messages(value.messages, true); boundedJson(value.transcript); return value;
}
function selection(value) { if (!exact(value, ['chatKey', 'archiveId']) || !key(value.chatKey) || !id(value.archiveId)) throw problem('档案选择格式无效'); return value; }
function chatState(value, expectedKey, parsed = false) {
  if (!exact(value, ['chatKey', 'nextLocalId', 'messages']) || !key(value.chatKey) || expectedKey !== undefined && value.chatKey !== expectedKey
      || !Number.isSafeInteger(value.nextLocalId) || value.nextLocalId < 1 || value.nextLocalId <= messages(value.messages, false, parsed)) throw problem('运行消息存档无效');
  if (!parsed) boundedJson(value); return value;
}
export function validateArchiveBundle(value) {
  boundedJson(value);
  if (!exact(value, ['format', 'version', 'sourceId', 'personas', 'archives', 'selected', 'coverage']) || value.format !== 'qq-bridge-archives' || value.version !== BUNDLE_VERSION || !id(value.sourceId)
      || !Array.isArray(value.personas) || !Array.isArray(value.archives) || !Array.isArray(value.selected) || !plain(value.coverage)
      || value.personas.length > 10000 || value.archives.length > 10000 || value.selected.length > 10000) throw problem('档案导入格式或版本不受支持');
  const seen = [new Set(), new Set(), new Set()];
  for (const [index, rows, validate, field] of [[0, value.personas, persona, 'id'], [1, value.archives, archive, 'id'], [2, value.selected, selection, 'chatKey']]) {
    for (const row of rows) { validate(row); if (seen[index].has(row[field])) throw problem('导入档案标识重复'); seen[index].add(row[field]); }
  }
  const normalized = clone(value); for (const row of normalized.archives) row.continuation ??= 'ready'; return normalized;
}
export const validateConversationArchiveBundle = validateArchiveBundle;
const mapKey = (...parts) => JSON.stringify(parts);
const schema = `
CREATE TABLE archive_sources (bot_id TEXT NOT NULL, id TEXT NOT NULL, coverage_json TEXT NOT NULL, PRIMARY KEY(bot_id,id)) STRICT;
CREATE TABLE archive_personas (bot_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), history_json TEXT NOT NULL, PRIMARY KEY(bot_id,id), FOREIGN KEY(bot_id,source_id) REFERENCES archive_sources(bot_id,id)) STRICT;
CREATE TABLE conversation_archives (bot_id TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, chat_key TEXT NOT NULL, persona_id TEXT NOT NULL, continuation TEXT NOT NULL CHECK(continuation IN ('ready','blocked','missing','deleted-persona')), legacy_session_id TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), chat_json TEXT NOT NULL, transcript_json TEXT NOT NULL, PRIMARY KEY(bot_id,id), UNIQUE(bot_id,id,chat_key), FOREIGN KEY(bot_id,source_id) REFERENCES archive_sources(bot_id,id), FOREIGN KEY(bot_id,persona_id) REFERENCES archive_personas(bot_id,id)) STRICT;
CREATE TABLE archive_selections (bot_id TEXT NOT NULL, chat_key TEXT NOT NULL, archive_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), PRIMARY KEY(bot_id,chat_key), FOREIGN KEY(bot_id,archive_id,chat_key) REFERENCES conversation_archives(bot_id,id,chat_key)) STRICT;
CREATE TABLE archive_imports (bot_id TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('persona','archive','selection')), item_id TEXT NOT NULL, fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(bot_id,source_id,kind,item_id), FOREIGN KEY(bot_id,source_id) REFERENCES archive_sources(bot_id,id)) STRICT;
`;

/** Lazy connection: construction and dry-run of a missing file never create a database. */
export class ConversationArchives {
  constructor({ file, botId = 'primary' } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !bot(botId)) throw problem('需要绝对 SQLite 路径和有效机器人标识');
    this.file = path.resolve(file); this.botId = botId; this.db = null; this.readDb = null; this.closed = false;
  }
  _schema(db) {
    if (db.prepare('PRAGMA application_id').get().application_id !== APP_ID || db.prepare('PRAGMA user_version').get().user_version !== DB_VERSION) throw problem('SQLite 档案身份或版本不受支持，拒绝改写', 503);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...TABLES].sort()) || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw problem('SQLite 档案结构损坏，拒绝改写', 503);
  }
  _connection(write) {
    if (this.closed) throw problem('档案存储已关闭', 503);
    if (this.db) return { db: this.db, temporary: false };
    if (this.readDb && !write) return { db: this.readDb, temporary: false };
    if (this.readDb) { this.readDb.close(); this.readDb = null; }
    if (!fs.existsSync(this.file)) {
      if (!write) return { db: null, temporary: false };
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const db = new DatabaseSync(this.file); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
      try { db.exec('BEGIN IMMEDIATE;' + schema + `PRAGMA application_id=${APP_ID}; PRAGMA user_version=${DB_VERSION}; COMMIT;`); } catch (error) { try { db.exec('ROLLBACK'); } catch {} db.close(); throw error; }
      this.db = db; return { db, temporary: false };
    }
    const db = new DatabaseSync(this.file, { readOnly: !write }); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
    try { this._schema(db); } catch (error) { db.close(); throw error; }
    if (write) this.db = db; else this.readDb = db;
    return { db, temporary: false };
  }
  _load(db) {
    const state = { sources: new Map(), personas: new Map(), archives: new Map(), selections: new Map(), imports: new Map() };
    if (!db) return state;
    this._schema(db);
    try {
      for (const row of db.prepare('SELECT * FROM archive_sources WHERE bot_id=?').all(this.botId)) { if (!id(row.id)) throw Error(); const coverage = decoded(row.coverage_json); if (!plain(coverage)) throw Error(); state.sources.set(row.id, coverage); }
      for (const row of db.prepare('SELECT * FROM archive_personas WHERE bot_id=?').all(this.botId)) {
        const value = persona({ id: row.id, name: row.name, content: row.content, version: row.version, history: decoded(row.history_json) });
        if (!state.sources.has(row.source_id)) throw Error(); state.personas.set(row.id, { ...value, sourceId: row.source_id });
      }
      for (const row of db.prepare('SELECT * FROM conversation_archives WHERE bot_id=?').all(this.botId)) {
        const chat = chatState(decoded(row.chat_json), row.chat_key), transcript = decoded(row.transcript_json);
        if (!id(row.id) || !key(row.chat_key) || !state.sources.has(row.source_id) || !state.personas.has(row.persona_id) || !CONTINUATIONS.includes(row.continuation) || !(row.legacy_session_id === null || id(row.legacy_session_id))
          || !time(row.created_at) || !time(row.last_used_at) || row.last_used_at < row.created_at || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Array.isArray(transcript)) throw Error();
        state.archives.set(row.id, { id: row.id, sourceId: row.source_id, chatKey: row.chat_key, personaId: row.persona_id, legacySessionId: row.legacy_session_id,
          continuation: row.continuation, createdAt: row.created_at, lastUsedAt: row.last_used_at, revision: row.revision, chat, transcript });
      }
      for (const row of db.prepare('SELECT * FROM archive_selections WHERE bot_id=?').all(this.botId)) {
        if (!key(row.chat_key) || !state.archives.has(row.archive_id) || state.archives.get(row.archive_id).chatKey !== row.chat_key || state.archives.get(row.archive_id).continuation !== 'ready' || !Number.isSafeInteger(row.version) || row.version < 1) throw Error();
        state.selections.set(row.chat_key, { archiveId: row.archive_id, version: row.version });
      }
      for (const row of db.prepare('SELECT * FROM archive_imports WHERE bot_id=?').all(this.botId)) {
        const payload = decoded(row.payload_json); if (!state.sources.has(row.source_id) || fingerprint(payload) !== row.fingerprint || !['persona', 'archive', 'selection'].includes(row.kind)) throw Error();
        (row.kind === 'persona' ? persona : row.kind === 'archive' ? archive : selection)(payload);
        if (row.item_id !== (row.kind === 'selection' ? payload.chatKey : payload.id)) throw Error();
        state.imports.set(mapKey(row.source_id, row.kind, row.item_id), { sourceId: row.source_id, kind: row.kind, id: row.item_id, fingerprint: row.fingerprint, payload });
      }
    } catch { throw problem('SQLite 档案内容损坏，拒绝改写', 503); }
    return state;
  }
  _transaction(write, work) {
    const connection = this._connection(write), db = connection.db;
    if (!db) return work(this._load(null), null);
    try { db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); const value = work(this._load(db), db); db.exec('COMMIT'); return value; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    finally { if (connection.temporary) db.close(); }
  }
  _fastRead(work) {
    const { db } = this._connection(false);
    if (!db) return work(null);
    try {
      db.exec('BEGIN');
      if (db.prepare('PRAGMA application_id').get().application_id !== APP_ID || db.prepare('PRAGMA user_version').get().user_version !== DB_VERSION) throw problem('SQLite 档案身份或版本不受支持', 503);
      const result = work(db); db.exec('COMMIT'); return result;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }
  _active(state, chatKey) {
    const selected = state.selections.get(chatKey); if (!selected) return null;
    const record = state.archives.get(selected.archiveId), p = state.personas.get(record.personaId);
    return { chatKey, sourceId: record.sourceId, archiveId: record.id, selectionVersion: selected.version, persona: { id: p.id, name: p.name, content: p.content, version: p.version } };
  }
  _record(state, chatKey, archiveId) {
    if (!key(chatKey)) throw problem('会话标识无效');
    if (archiveId === undefined) archiveId = state.selections.get(chatKey)?.archiveId;
    if (archiveId === undefined) return null;
    const row = state.archives.get(archiveId); if (!row || row.chatKey !== chatKey) throw problem('该会话没有指定档案', 404); return row;
  }
  _plan(bundle, state) {
    const result = { dryRun: true, botId: this.botId, sourceId: bundle.sourceId, personasAdded: 0, archivesAdded: 0, archivesUpdated: 0, messagesAdded: 0, transcriptAdded: 0, selectionsAdded: 0, selectionsPreserved: 0, selectionsBlocked: 0, unchanged: 0, coverage: clone(bundle.coverage) };
    const tasks = [], sourceId = bundle.sourceId;
    const imported = (kind, itemId) => state.imports.get(mapKey(sourceId, kind, itemId));
    const remember = (kind, itemId, payload) => {
      const row = { sourceId, kind, id: itemId, fingerprint: fingerprint(payload), payload: clone(payload) };
      state.imports.set(mapKey(sourceId, kind, itemId), row); tasks.push({ type: 'import', row });
    };
    state.sources.set(sourceId, clone(bundle.coverage)); tasks.push({ type: 'source', sourceId, coverage: clone(bundle.coverage) });
    for (const value of bundle.personas) {
      const previous = imported('persona', value.id), existing = state.personas.get(value.id), hash = fingerprint(value);
      if (previous && previous.fingerprint !== hash) throw problem('同来源人设已被改写，拒绝覆盖', 409);
      if (existing) { const { sourceId: _source, ...current } = existing; if (fingerprint(current) !== hash) throw problem('人设 ID 已存在且内容冲突', 409); result.unchanged++; }
      else { const row = { ...clone(value), sourceId }; state.personas.set(value.id, row); tasks.push({ type: 'persona', row }); result.personasAdded++; }
      if (!previous) remember('persona', value.id, value);
    }
    for (const value of bundle.archives) {
      if (!state.personas.has(value.personaId)) throw problem('档案引用了不存在的人设', 409);
      const existing = state.archives.get(value.id), previous = imported('archive', value.id), hash = fingerprint(value);
      if (!existing) {
        if (previous) throw problem('源索引与档案不一致', 503);
        const row = { id: value.id, sourceId, chatKey: value.chatKey, personaId: value.personaId, continuation: value.continuation, legacySessionId: value.legacySessionId, createdAt: value.createdAt, lastUsedAt: value.lastUsedAt,
          revision: 1, chat: { chatKey: value.chatKey, nextLocalId: (value.messages.at(-1)?.id ?? 0) + 1, messages: clone(value.messages) }, transcript: clone(value.transcript) };
        state.archives.set(value.id, row); tasks.push({ type: 'archive', row }); result.archivesAdded++; result.messagesAdded += value.messages.length; result.transcriptAdded += value.transcript.length;
      } else if (!previous) {
        const matching = [...state.imports.values()].some(row => row.kind === 'archive' && row.id === value.id && row.fingerprint === hash);
        if (!matching) throw problem('档案 ID 已存在且来源内容冲突', 409); result.unchanged++;
      } else if (previous.fingerprint === hash) result.unchanged++;
      else {
        const old = previous.payload;
        const fixed = item => ({ id: item.id, chatKey: item.chatKey, personaId: item.personaId, continuation: item.continuation, legacySessionId: item.legacySessionId, createdAt: item.createdAt });
        if (fingerprint(fixed(old)) !== fingerprint(fixed(value)) || value.lastUsedAt < old.lastUsedAt
          || value.messages.length < old.messages.length || value.transcript.length < old.transcript.length
          || old.messages.some((entry, index) => fingerprint(entry) !== fingerprint(value.messages[index]))
          || old.transcript.some((entry, index) => fingerprint(entry) !== fingerprint(value.transcript[index]))) throw problem('源档案被改写或截短，只允许严格前缀追加', 409);
        if (existing.sourceId !== sourceId) {
          const matching = [...state.imports.values()].some(row => row.kind === 'archive' && row.id === value.id && row.fingerprint === hash);
          if (!matching) throw problem('仅原始档案来源可追加消息，拒绝多来源重复追加', 409); result.unchanged++;
        } else {
          const row = clone(existing), tail = value.messages.slice(old.messages.length);
          for (const entry of tail) { if (!Number.isSafeInteger(row.chat.nextLocalId + 1)) throw problem('本地消息 ID 已超出安全范围', 503); row.chat.messages.push({ ...clone(entry), id: row.chat.nextLocalId++ }); }
          row.transcript.push(...clone(value.transcript.slice(old.transcript.length))); row.lastUsedAt = Math.max(row.lastUsedAt, value.lastUsedAt); row.revision++;
          if (!Number.isSafeInteger(row.revision)) throw problem('消息版本超出范围', 503);
          state.archives.set(value.id, row); tasks.push({ type: 'archive-update', row }); result.archivesUpdated++; result.messagesAdded += tail.length; result.transcriptAdded += value.transcript.length - old.transcript.length;
        }
      }
      if (!previous || previous.fingerprint !== hash) remember('archive', value.id, value);
    }
    for (const value of bundle.selected) {
      const record = state.archives.get(value.archiveId); if (!record || record.chatKey !== value.chatKey) throw problem('选中档案不属于该会话', 409);
      const previous = imported('selection', value.chatKey); if (previous && previous.fingerprint !== fingerprint(value)) throw problem('来源中的当前档案选择发生变化，请显式切换', 409);
      if (record.continuation !== 'ready') result.selectionsBlocked++;
      else if (!state.selections.has(value.chatKey)) { const row = { chatKey: value.chatKey, archiveId: value.archiveId, version: 1 }; state.selections.set(value.chatKey, row); tasks.push({ type: 'selection', row }); result.selectionsAdded++; }
      else result.selectionsPreserved++;
      if (!previous) remember('selection', value.chatKey, value);
    }
    return { result, tasks };
  }
  importBundle(input, { dryRun = true } = {}) {
    if (typeof dryRun !== 'boolean') throw problem('dryRun 必须是布尔值');
    const bundle = validateArchiveBundle(input);
    return this._transaction(!dryRun, (state, db) => {
      const { result, tasks } = this._plan(bundle, state);
      if (!dryRun) for (const task of tasks) {
        const row = task.row;
        if (task.type === 'source') db.prepare('INSERT INTO archive_sources VALUES(?,?,?) ON CONFLICT(bot_id,id) DO UPDATE SET coverage_json=excluded.coverage_json').run(this.botId, task.sourceId, stable(task.coverage));
        else if (task.type === 'persona') db.prepare('INSERT INTO archive_personas VALUES(?,?,?,?,?,?,?)').run(this.botId, row.id, row.sourceId, row.name, row.content, row.version, stable(row.history));
        else if (task.type === 'archive') db.prepare('INSERT INTO conversation_archives VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(this.botId, row.id, row.sourceId, row.chatKey, row.personaId, row.continuation, row.legacySessionId, row.createdAt, row.lastUsedAt, row.revision, stable(row.chat), stable(row.transcript));
        else if (task.type === 'archive-update') db.prepare('UPDATE conversation_archives SET last_used_at=?,revision=?,chat_json=?,transcript_json=? WHERE bot_id=? AND id=?').run(row.lastUsedAt, row.revision, stable(row.chat), stable(row.transcript), this.botId, row.id);
        else if (task.type === 'selection') db.prepare('INSERT INTO archive_selections VALUES(?,?,?,?)').run(this.botId, row.chatKey, row.archiveId, row.version);
        else if (task.type === 'import') db.prepare('INSERT INTO archive_imports VALUES(?,?,?,?,?,?) ON CONFLICT(bot_id,source_id,kind,item_id) DO UPDATE SET fingerprint=excluded.fingerprint,payload_json=excluded.payload_json').run(this.botId, row.sourceId, row.kind, row.id, row.fingerprint, stable(row.payload));
      }
      return { ...result, dryRun };
    });
  }
  list(chatKey) {
    if (chatKey !== undefined && !key(chatKey)) throw problem('会话标识无效');
    return this._transaction(false, state => [...state.archives.values()].filter(row => chatKey === undefined || row.chatKey === chatKey).map(row => ({
      id: row.id, archiveId: row.id, sourceId: row.sourceId, chatKey: row.chatKey, personaId: row.personaId, continuation: row.continuation, legacySessionId: row.legacySessionId,
      createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, revision: row.revision, persona: { id: row.personaId, name: state.personas.get(row.personaId).name, version: state.personas.get(row.personaId).version }, messageCount: row.chat.messages.length, transcriptCount: row.transcript.length,
      selected: state.selections.get(row.chatKey)?.archiveId === row.id, selectionVersion: state.selections.get(row.chatKey)?.version ?? 0,
    })));
  }
  personas() { return this._transaction(false, state => [...state.personas.values()].map(clone)); }
  active(chatKey) {
    if (!key(chatKey)) throw problem('会话标识无效');
    return this._fastRead(db => {
      if (!db) return null;
      const row = db.prepare('SELECT s.archive_id,s.version selection_version,a.source_id,a.persona_id,a.continuation,p.name,p.content,p.version persona_version FROM archive_selections s LEFT JOIN conversation_archives a ON a.bot_id=s.bot_id AND a.id=s.archive_id AND a.chat_key=s.chat_key LEFT JOIN archive_personas p ON p.bot_id=a.bot_id AND p.id=a.persona_id WHERE s.bot_id=? AND s.chat_key=?').get(this.botId, chatKey);
      if (!row) return null;
      if (!id(row.archive_id) || !id(row.source_id) || !id(row.persona_id) || row.continuation !== 'ready' || !text(row.name, 200, true) || !text(row.content, 1024*1024, true) || !Number.isSafeInteger(row.selection_version) || row.selection_version<1 || !Number.isSafeInteger(row.persona_version) || row.persona_version<1) throw problem('当前档案元数据损坏',503);
      return { chatKey, sourceId: row.source_id, archiveId: row.archive_id, selectionVersion: row.selection_version, persona: { id: row.persona_id, name: row.name, content: row.content, version: row.persona_version } };
    });
  }
  select(chatKey, archiveId, { expectedVersion } = {}) {
    if (!key(chatKey) || !id(archiveId) || expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) throw problem('档案选择或版本无效');
    return this._transaction(true, (state, db) => {
      const row = this._record(state, chatKey, archiveId), current = state.selections.get(chatKey);
      if (row.continuation !== 'ready') throw problem('该档案仅供查阅，不能继续聊天', 409);
      if (expectedVersion !== undefined && expectedVersion !== (current?.version ?? 0)) throw problem('当前档案已被其他操作切换', 409);
      if (current?.archiveId !== row.id) {
        const version = (current?.version ?? 0) + 1; if (!Number.isSafeInteger(version)) throw problem('选择版本超出范围', 503);
        db.prepare('INSERT INTO archive_selections VALUES(?,?,?,?) ON CONFLICT(bot_id,chat_key) DO UPDATE SET archive_id=excluded.archive_id,version=excluded.version').run(this.botId, chatKey, row.id, version);
        db.prepare('UPDATE conversation_archives SET last_used_at=? WHERE bot_id=? AND id=?').run(Math.max(Date.now(), row.lastUsedAt), this.botId, row.id); state.selections.set(chatKey, { archiveId: row.id, version });
      }
      return this._active(state, chatKey);
    });
  }
  readChat(chatKey, archiveId) {
    if (!key(chatKey) || archiveId !== undefined && !id(archiveId)) throw problem('会话或档案标识无效');
    const explicitArchive = archiveId !== undefined;
    return this._fastRead(db => {
      if (!db) { if (archiveId !== undefined) throw problem('该会话没有指定档案',404); return null; }
      let selectionVersion=0;
      const selected=db.prepare('SELECT archive_id,version FROM archive_selections WHERE bot_id=? AND chat_key=?').get(this.botId,chatKey);
      if(selected) { if(!id(selected.archive_id)||!Number.isSafeInteger(selected.version)||selected.version<1)throw problem('当前选择元数据损坏',503); selectionVersion=selected.version; }
      if(archiveId===undefined)archiveId=selected?.archive_id;
      if(archiveId===undefined)return null;
      const row=db.prepare('SELECT id,revision,continuation,chat_json FROM conversation_archives WHERE bot_id=? AND chat_key=? AND id=?').get(this.botId,chatKey,archiveId);
      if(!row)throw problem('该会话没有指定档案',404);
      if(!Number.isSafeInteger(row.revision)||row.revision<1||!CONTINUATIONS.includes(row.continuation)||!explicitArchive&&row.continuation!=='ready')throw problem('消息档案版本或状态损坏',503);
      let value;try { value=chatState(decodedRead(row.chat_json),chatKey,true); }catch {throw problem('消息档案内容损坏，拒绝读取',503);}
      Object.defineProperties(value,{revision:{value:row.revision,writable:true},botId:{value:this.botId},archiveId:{value:row.id},selectionVersion:{value:selectionVersion}});
      return value;
    });
  }
  writeChat(value) {
    chatState(value);
    const revision = Object.getOwnPropertyDescriptor(value, 'revision')?.value, archiveId = Object.getOwnPropertyDescriptor(value, 'archiveId')?.value;
    if (Object.getOwnPropertyDescriptor(value, 'botId')?.value !== this.botId || !Number.isSafeInteger(revision) || revision < 1 || !id(archiveId)) throw problem('写入档案必须携带原始读取版本', 409);
    return this._transaction(true, (state, db) => {
      const row = this._record(state, value.chatKey, archiveId); if (row.continuation !== 'ready') throw problem('该档案仅供查阅，不能继续聊天', 409);
      if (row.revision !== revision) throw problem('消息档案已被其他操作更新，请重新读取', 409);
      const next = revision + 1; if (!Number.isSafeInteger(next)) throw problem('消息版本超出范围', 503);
      const changed = db.prepare('UPDATE conversation_archives SET revision=?,chat_json=? WHERE bot_id=? AND id=? AND revision=?').run(next, stable(value), this.botId, archiveId, revision);
      if (changed.changes !== 1) throw problem('消息版本冲突，拒绝覆盖', 409);
      value.revision = next; return value;
    });
  }
  snapshot(chatKey, archiveId) {
    return this._transaction(false, state => { const row = this._record(state, chatKey, archiveId); if (!row) return null; return { id: row.id, archiveId: row.id, sourceId: row.sourceId, chatKey: row.chatKey, personaId: row.personaId, continuation: row.continuation,
      legacySessionId: row.legacySessionId, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, revision: row.revision, messages: clone(row.chat.messages), transcript: clone(row.transcript) }; });
  }
  transcript(chatKey, archiveId) {
    if(!key(chatKey)||archiveId!==undefined&&!id(archiveId))throw problem('会话或档案标识无效');
    return this._fastRead(db=>{
      if(!db)return [];
      if(archiveId===undefined)archiveId=db.prepare('SELECT archive_id FROM archive_selections WHERE bot_id=? AND chat_key=?').get(this.botId,chatKey)?.archive_id;
      if(archiveId===undefined)return [];
      const row=db.prepare('SELECT transcript_json FROM conversation_archives WHERE bot_id=? AND chat_key=? AND id=?').get(this.botId,chatKey,archiveId);
      if(!row)throw problem('该会话没有指定档案',404);
      const value=decodedRead(row.transcript_json);if(!Array.isArray(value))throw problem('历史原文格式损坏',503);return value;
    });
  }
  listChats() { return this._transaction(false, state => [...new Set([...state.archives.values()].map(row => row.chatKey))].sort()); }
  close() { if (this.db) this.db.close(); if(this.readDb)this.readDb.close(); this.db = null; this.readDb = null; this.closed = true; }
}
