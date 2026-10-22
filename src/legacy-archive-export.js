// Read-only, offline export of QQ Bridge personas and conversation archives.
// No runtime startup, credential lookup, HTTP, QQ connection, or source repair.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateArchiveBundle } from './conversation-archives.js';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_DSH_FILES = 4096;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const chatKey = value => {
  if (typeof value !== 'string' || !/^(group|private):[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value.split(':')[1]))) throw fail('INVALID_CHAT_KEY', 'Invalid legacy conversation identity');
  return value;
};
const stamp = stat => [stat.size, stat.mtimeMs, stat.ino, stat.dev].join(':');
const safeRoot = value => {
  if (typeof value !== 'string' || !value || !path.isAbsolute(value)) throw fail('INVALID_PATH', 'An absolute source directory is required');
  const absolute = path.resolve(value), stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('UNSAFE_PATH', 'Source root must be a directory, not a symbolic link');
  return fs.realpathSync(absolute);
};

function sourceReader(root) {
  const evidence = new Map();
  function locate(relative, optional = true) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..') || path.isAbsolute(relative)) throw fail('UNSAFE_PATH', 'Invalid relative source path');
    let target = root;
    for (const part of relative.split('/')) {
      target = path.join(target, part);
      let stat;
      try { stat = fs.lstatSync(target); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
      if (stat.isSymbolicLink()) throw fail('UNSAFE_PATH', 'Symbolic links are not accepted in source paths');
    }
    const real = fs.realpathSync(target);
    const within = path.relative(root, real);
    if (!within || within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within)) throw fail('UNSAFE_PATH', 'Source path escapes its root');
    return target;
  }
  function read(relative, optional = true) {
    const target = locate(relative, optional); if (target === null) return null;
    const before = fs.lstatSync(target);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw fail('SOURCE_SIZE', 'Source file is not a regular file or exceeds the export bound');
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || stamp(opened) !== stamp(before)) throw fail('SOURCE_CHANGED', 'Source changed during export');
      bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    if (stamp(fs.lstatSync(target)) !== stamp(before)) throw fail('SOURCE_CHANGED', 'Source changed during export');
    evidence.set(relative, { path: relative, bytes: bytes.length, sha256: hash(bytes) });
    return bytes;
  }
  function text(relative, optional = true) {
    const bytes = read(relative, optional);
    if (bytes === null) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); }
    catch { throw fail('SOURCE_ENCODING', 'Source is not valid UTF-8'); }
  }
  function verify() {
    for (const [relative, row] of evidence) {
      const bytes = read(relative, false);
      if (hash(bytes) !== row.sha256) throw fail('SOURCE_CHANGED', 'Source changed while exporting the snapshot');
    }
  }
  return { root, locate, read, text, evidence, verify };
}

function json(text, label) {
  try { return JSON.parse(text); } catch { throw fail('SOURCE_JSON', 'Malformed legacy JSON: ' + label); }
}

const documentKinds = new Map([
  ['state/conversation-sessions.json', 'conversation-sessions'],
  ['state/conversation-roles.json', 'conversation-roles'],
  ['state/member-personas.json', 'member-personas'],
  ['state/current-role.json', 'global-role'],
  ['state/byok-conversations.json', 'json'],
  ['state/social-v2.json', 'json'],
  ['state/sessions.json', 'json'],
]);

function readManagedSnapshot(reader, botId) {
  if (reader.locate('state/manager.sqlite') === null) return { sqlite: false, documents: new Map() };
  // Work on private byte copies, including WAL/SHM. Opening even a read-only WAL
  // database may otherwise create a sidecar beside the caller's source database.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-legacy-snapshot-'));
  const copies = [];
  let db;
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const bytes = reader.read('state/manager.sqlite' + suffix);
      if (bytes !== null) { const target = path.join(tempRoot, 'manager.sqlite' + suffix); fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); copies.push(target); }
    }
    reader.verify();
    db = new DatabaseSync(path.join(tempRoot, 'manager.sqlite'), { readOnly: true, allowExtension: false });
    db.exec('PRAGMA query_only=ON');
    if (db.prepare('PRAGMA application_id').get().application_id !== 0x51514254 || db.prepare('PRAGMA user_version').get().user_version !== 1) throw fail('SQLITE_FORMAT', 'Unsupported QQ Bridge management database');
    const placeholders = [...documentKinds].map(() => '?').join(',');
    const identities = db.prepare(`SELECT path,kind FROM state_documents WHERE bot_id=? AND (path IN (${placeholders}) OR kind='role-card')`).all(botId, ...documentKinds.keys());
    const documents = new Map();
    for (const row of identities) {
      if (row.kind === 'role-card') {
        if (!/^roles\/[\w\u4e00-\u9fff-]{1,80}\.md$/.test(row.path) || row.path === 'roles/README.md') throw fail('UNSAFE_PATH', 'Invalid role-card document path');
      } else if (documentKinds.get(row.path) !== row.kind) throw fail('SQLITE_FORMAT', 'Managed document kind does not match its path');
      const value = db.prepare('SELECT raw_text,revision FROM state_documents WHERE bot_id=? AND path=? AND kind=?').get(botId, row.path, row.kind);
      if (!(value.raw_text === null || typeof value.raw_text === 'string') || Buffer.byteLength(value.raw_text || '') > MAX_FILE_BYTES) throw fail('SQLITE_FORMAT', 'Invalid managed document value');
      documents.set(row.path, { raw: value.raw_text, revision: value.revision, kind: row.kind });
    }
    return { sqlite: true, documents };
  } finally {
    db?.close();
    // Remove only the exact files in this freshly created private directory.
    for (const name of ['manager.sqlite', 'manager.sqlite-wal', 'manager.sqlite-shm']) {
      const target = path.join(tempRoot, name); if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    fs.rmdirSync(tempRoot);
  }
}

function readSources(reader, managed) {
  const documents = new Map(), available = [];
  for (const relative of documentKinds.keys()) {
    const row = managed.documents.get(relative);
    let raw = row ? row.raw : null;
    // These two Bridge state files are still written directly to disk. Other
    // managed documents, including BYOK, must never fall back to frozen JSON.
    if (!row && (!managed.sqlite || relative === 'state/social-v2.json' || relative === 'state/sessions.json')) raw = reader.text(relative);
    if (raw !== null) { documents.set(relative, json(raw, relative)); available.push(relative); }
  }
  const roles = new Map();
  if (managed.sqlite) {
    for (const [relative, row] of managed.documents) if (row.kind === 'role-card' && row.raw !== null) roles.set(path.posix.basename(relative, '.md'), { content: row.raw, revision: row.revision, path: relative });
  } else {
    const directory = reader.locate('roles');
    if (directory !== null) {
      if (!fs.lstatSync(directory).isDirectory()) throw fail('UNSAFE_PATH', 'Roles source is not a directory');
      for (const name of fs.readdirSync(directory).sort()) {
        if (name === 'README.md' || !name.endsWith('.md')) continue;
        if (!/^[\w\u4e00-\u9fff-]{1,80}\.md$/.test(name)) throw fail('UNSAFE_PATH', 'Invalid legacy role filename');
        roles.set(name.slice(0, -3), { content: reader.text('roles/' + name, false), revision: 1, path: 'roles/' + name });
      }
    }
  }
  if (!available.length && !roles.size) throw fail('SOURCE_MISSING', 'No persona, archive or retained-message source was found');
  return { documents, roles, available };
}

function plainContent(event) {
  const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : null;
  if (!role) return null;
  const content = event.data?.message?.content ?? event.data?.content;
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const blocks = content.filter(block => object(block) && block.type === 'text' && typeof block.text === 'string');
    if (!blocks.length) return null;
    text = blocks.map(block => block.text).join('\n');
  } else return null;
  return { role, text };
}

function projectEvent(event, sessionId, redact) {
  if (!object(event)) return { kind: 'legacy-event', sessionId, raw: event };
  const message = plainContent(event);
  if (!message) return { kind: 'legacy-event', sessionId, raw: event };
  const internal = /【会话令牌】|【后台控制端提醒】|x-agent-token|\bagentToken\b/.test(message.text);
  return { kind: 'legacy-message', sessionId, role: message.role, text: redact(message.text), source: 'dsh-model-history', qqDeliveryProven: false, resumeEligible: !internal, containsInternalControl: internal, raw: event };
}

function readDshExports(dshExportsDir, redact) {
  if (dshExportsDir === undefined) return { reader: null, sessions: new Map(), issues: [] };
  const reader = sourceReader(safeRoot(dshExportsDir)), sessions = new Map(), issues = [];
  let count = 0, visited = 0;
  function walk(relative = '') {
    if (++visited > MAX_DSH_FILES * 4 || relative.split('/').length > 40) throw fail('SOURCE_SIZE', 'Offline DSH directory tree exceeds the export bound');
    const directory = relative ? reader.locate(relative, false) : reader.root;
    for (const name of fs.readdirSync(directory).sort()) {
      const child = relative ? relative + '/' + name : name;
      const target = reader.locate(child, false), stat = fs.lstatSync(target);
      if (stat.isDirectory()) { walk(child); continue; }
      if (!stat.isFile() || !(/\.jsonl$/i.test(name) || /\.artifact\.json$/i.test(name))) continue;
      if (++count > MAX_DSH_FILES) throw fail('SOURCE_SIZE', 'Too many offline DSH artifacts');
      let content = reader.text(child, false), suppliedMeta;
      if (/\.artifact\.json$/i.test(name)) {
        const artifact = json(content, child);
        if (!object(artifact.meta) || typeof artifact.content !== 'string' || typeof artifact.filename !== 'string') throw fail('DSH_FORMAT', 'Expected an offline SessionRawArtifact object');
        content = artifact.content; suppliedMeta = artifact.meta;
      }
      const lines = content.split(/\r?\n/), records = [], reasons = [], unparsed = [];
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        try { records.push(json(lines[index], child)); }
        catch { reasons.push('unparseable-record:' + (index + 1)); unparsed.push({ kind: 'legacy-unparsed-line', line: index + 1, rawText: lines[index] }); }
      }
      const header = records[0];
      // The SDK's raw artifact has its own SessionHeader on the first line.
      // Unknown physical provider envelopes are not guessed or reconstructed.
      if (!object(header) || !validId(header.id) || !Number.isInteger(header.version) || !Number.isSafeInteger(header.createdAt)) throw fail('DSH_FORMAT', 'Offline DSH artifact has no recognized SessionHeader');
      if (suppliedMeta && (suppliedMeta.id !== header.id || suppliedMeta.version !== header.version)) throw fail('DSH_FORMAT', 'SessionRawArtifact metadata conflicts with its header');
      const events = records.slice(1); let expected = 0;
      for (const event of events) {
        if (!object(event) || !Number.isSafeInteger(event.seq) || event.seq !== expected || typeof event.type !== 'string' || !object(event.data)) reasons.push('event-sequence-or-shape:' + expected);
        expected = Number.isSafeInteger(event?.seq) ? event.seq + 1 : expected + 1;
      }
      if (events.some(event => event?.type === 'turn/start') && events.at(-1)?.type !== 'turn/end') reasons.push('open-or-incomplete-final-turn');
      const digest = hash(content), prior = sessions.get(header.id);
      if (prior && prior.sha256 !== digest) throw fail('DSH_CONFLICT', 'Different offline artifacts claim the same DSH session');
      const projected = [{ kind: 'legacy-dsh-header', sessionId: header.id, raw: header }, ...events.map(event => projectEvent(event, header.id, redact)), ...unparsed];
      const hasReplacement = events.some(event => event?.surfaceOp?.op === 'replace');
      // Raw artifacts are not a folded model view. Retain replaced events, but
      // never silently feed both their original and replacement into a new turn.
      if (hasReplacement) for (const item of projected) if (item.kind === 'legacy-message') { item.resumeEligible = false; item.projectionGap = 'surface-replacement-not-folded'; }
      const row = { header, transcript: projected, status: reasons.length ? 'partial' : 'complete', reasons, path: child, sha256: digest, events: events.length };
      sessions.set(header.id, row);
      for (const reason of reasons) issues.push({ sessionId: header.id, source: child, reason });
    }
  }
  walk();
  return { reader, sessions, issues };
}

function nativeMessages(values, redact, issues, key) {
  const seen = new Set(), messages = [];
  for (const item of values) {
    if (!object(item) || typeof item.isSelf !== 'boolean' || !Number.isSafeInteger(item.time) || item.time < 0 || typeof (item.plain ?? item.text) !== 'string') { issues.push({ chatKey: key, reason: 'unrecognized-qq-message-record' }); continue; }
    const mid = item.messageId === undefined || item.messageId === null ? null : String(item.messageId);
    const identity = mid !== null ? 'mid:' + mid : JSON.stringify([item.time, item.isSelf, item.userId ?? null, item.seq ?? null, item.plain ?? item.text]);
    if (seen.has(identity)) continue; seen.add(identity);
    messages.push({ id: 0, mid, ts: item.time, senderId: item.isSelf ? 'self' : String(item.userId ?? ''), senderName: String(item.sender ?? ''), text: redact(item.plain ?? item.text), self: item.isSelf, read: true, reply: null, media: Array.isArray(item.media) ? item.media : [], ...(item.kind === 'poke' ? { isPoke: true } : {}) });
  }
  messages.sort((a, b) => a.ts - b.ts);
  return messages.map((row, index) => ({ ...row, id: index + 1 }));
}

/** Export only explicit persona/archive/history sources; never read config or keys. */
export function exportLegacyArchives({ bridgeRoot, sourceId, botId = 'primary', dshExportsDir } = {}) {
  if (!validId(sourceId, 200) || !/^[A-Za-z0-9_-]{1,64}$/.test(botId)) throw fail('INVALID_SOURCE', 'A stable source id and valid bot id are required');
  const reader = sourceReader(safeRoot(bridgeRoot)), managed = readManagedSnapshot(reader, botId), source = readSources(reader, managed), docs = source.documents;
  const issues = [], personaRows = new Map(), nameIds = new Map(), personaCoverage = new Map(), missingPersonas = new Set();
  const membersDoc = docs.get('state/member-personas.json');
  if (membersDoc && (membersDoc.version !== 1 || !Array.isArray(membersDoc.cards))) throw fail('SOURCE_FORMAT', 'Unsupported member persona document');
  const members = new Map((membersDoc?.cards || []).map(card => {
    if (!object(card) || card.botId !== botId || !validId(card.id) || !validId(card.internalRoleName) || typeof card.content !== 'string' || typeof card.name !== 'string' || !Number.isInteger(card.version) || card.version < 1 || !Array.isArray(card.history)) throw fail('SOURCE_FORMAT', 'Invalid member persona');
    return [card.internalRoleName, card];
  }));
  function addPersona(id, name, deleted = false) {
    if (!validId(id) || !(name === null || typeof name === 'string')) throw fail('SOURCE_FORMAT', 'Invalid legacy persona identity');
    const role = name === null ? null : source.roles.get(name), member = members.get(name);
    const history = member ? [{ kind: 'legacy-member-card-source', id: member.id, internalRoleName: member.internalRoleName, ownerUserId: member.ownerUserId ?? null, createdAt: member.createdAt ?? null, updatedAt: member.updatedAt ?? null }, ...member.history] : [];
    if (deleted) history.unshift({ kind: 'legacy-persona-state', deleted: true });
    const content = member?.content ?? role?.content ?? '';
    const missing = !content.trim();
    if (missing) {
      missingPersonas.add(id);
      issues.push({ personaId: id, reason: name === null ? 'default-dsh-preset-content-not-exported' : 'persona-content-missing' });
    }
    personaCoverage.set(id, { personaId: id, status: missing ? 'missing' : 'complete', source: member ? 'member-persona-card' : role ? 'role-card' : name === null ? 'dsh-default-preset-unavailable' : 'unavailable' });
    personaRows.set(id, { id, name: member?.name ?? name ?? '', content, version: member?.version ?? 1, history });
    if (!deleted && !nameIds.has(name)) nameIds.set(name, id);
    return id;
  }
  const index = docs.get('state/conversation-sessions.json');
  if (index && (index.version !== 1 || !object(index.personas) || !object(index.records) || !object(index.selected))) throw fail('SOURCE_FORMAT', 'Unsupported conversation archive index');
  for (const [id, value] of Object.entries(index?.personas || {})) {
    if (!object(value) || typeof value.deleted !== 'boolean') throw fail('SOURCE_FORMAT', 'Invalid legacy persona record');
    addPersona(id, value.name, value.deleted);
  }
  for (const [name, member] of members) if (!nameIds.has(name)) addPersona(member.id, name);
  for (const name of source.roles.keys()) if (!nameIds.has(name)) addPersona('p_' + hash(JSON.stringify(name)).slice(0, 32), name);
  const current = docs.get('state/current-role.json');
  if (current && !(current.role === null || typeof current.role === 'string')) throw fail('SOURCE_FORMAT', 'Invalid global persona binding');
  const bindings = docs.get('state/conversation-roles.json');
  if (bindings && (bindings.version !== 1 || !object(bindings.roles))) throw fail('SOURCE_FORMAT', 'Invalid conversation persona binding');
  function personaFor(key) {
    const name = bindings?.roles?.[key] ?? current?.role ?? null;
    return nameIds.get(name) ?? addPersona('p_' + hash(JSON.stringify(name)).slice(0, 32), name);
  }
  const archives = [], selected = [], byId = new Map();
  for (const [id, value] of Object.entries(index?.records || {})) {
    if (!validId(id) || !object(value) || !personaRows.has(value.personaId) || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.lastUsedAt) || value.createdAt < 0 || value.lastUsedAt < 0 || !(value.sessionId === null || validId(value.sessionId))) throw fail('SOURCE_FORMAT', 'Invalid legacy archive record');
    if (value.sessionId && archives.some(row => row.legacySessionId === value.sessionId)) throw fail('CROSS_CONVERSATION', 'A legacy DSH session cannot belong to multiple archives');
    const continuation = index.personas[value.personaId].deleted ? 'deleted-persona' : value.missing || missingPersonas.has(value.personaId) ? 'missing' : value.blocked ? 'blocked' : 'ready';
    const row = { id, chatKey: chatKey(value.key), personaId: value.personaId, legacySessionId: value.sessionId, createdAt: value.createdAt, lastUsedAt: value.lastUsedAt, messages: [], transcript: [{ kind: 'legacy-archive-state', raw: { blocked: value.blocked === true, missing: value.missing === true, policy: value.policy ?? null } }], ...(continuation !== 'ready' ? { continuation } : {}) };
    archives.push(row); byId.set(id, row);
    if (value.blocked || value.missing || index.personas[value.personaId].deleted) issues.push({ archiveId: id, reason: 'legacy-archive-inactive-or-missing' });
  }
  for (const [key, id] of Object.entries(index?.selected || {})) {
    if (!byId.has(id) || byId.get(id).chatKey !== chatKey(key)) throw fail('SOURCE_FORMAT', 'Selected archive does not belong to its conversation');
    selected.push({ chatKey: key, archiveId: id });
  }
  const live = docs.get('state/sessions.json');
  if (live && !object(live.sessions)) throw fail('SOURCE_FORMAT', 'Invalid active session mapping');
  for (const [key, sessionId] of Object.entries(live?.sessions || {})) {
    chatKey(key); if (!validId(sessionId)) throw fail('SOURCE_FORMAT', 'Invalid active DSH session identity');
    const existing = archives.find(row => row.legacySessionId === sessionId);
    if (existing) { if (existing.chatKey !== key) throw fail('CROSS_CONVERSATION', 'Active session mapping crosses conversation boundaries'); continue; }
    const id = 'c_' + hash(JSON.stringify([key, sessionId])).slice(0, 32);
    const row = { id, chatKey: key, personaId: personaFor(key), legacySessionId: sessionId, createdAt: 0, lastUsedAt: 0, messages: [], transcript: [{ kind: 'legacy-index-reconstruction', reason: 'active-mapping-has-no-archive-record' }] };
    archives.push(row); byId.set(id, row);
    if (!selected.some(value => value.chatKey === key)) selected.push({ chatKey: key, archiveId: id });
    issues.push({ archiveId: id, reason: 'archive-timestamps-unavailable' });
  }
  const social = docs.get('state/social-v2.json');
  if (social && !object(social.conversations)) throw fail('SOURCE_FORMAT', 'Invalid retained QQ-message document');
  const tokens = Object.values(social?.conversations || {}).map(value => value?.agentToken).filter(value => typeof value === 'string' && value.length >= 12);
  const redact = text => {
    let result = String(text).replace(/【会话令牌】[^\r\n]*/g, '[旧会话内部令牌行已隐藏]');
    for (const token of tokens) result = result.split(token).join('[旧会话令牌已隐藏]');
    return result;
  };
  for (const [key, value] of Object.entries(social?.conversations || {})) {
    chatKey(key); if (!object(value) || !Array.isArray(value.recentMessages) || (value.unread !== undefined && !Array.isArray(value.unread))) throw fail('SOURCE_FORMAT', 'Invalid retained QQ-message window');
    let chosen = selected.find(row => row.chatKey === key), archive = chosen && byId.get(chosen.archiveId);
    if (!archive) {
      const id = 'c_' + hash(JSON.stringify(['retained-qq-window', botId, key])).slice(0, 32);
      archive = { id, chatKey: key, personaId: personaFor(key), legacySessionId: null, createdAt: 0, lastUsedAt: 0, messages: [], transcript: [{ kind: 'legacy-index-reconstruction', reason: 'retained-qq-window-has-no-archive-record' }] };
      archives.push(archive); byId.set(id, archive); selected.push({ chatKey: key, archiveId: id });
    }
    archive.messages = nativeMessages([...value.recentMessages, ...(value.unread || [])], redact, issues, key);
    issues.push({ archiveId: archive.id, chatKey: key, reason: 'bounded-qq-window-and-original-200-character-text-truncation', attribution: 'selected-at-export-only; per-message-persona-is-not-known' });
  }
  const byok = docs.get('state/byok-conversations.json');
  if (byok && (byok.version !== 1 || !Array.isArray(byok.archives))) throw fail('SOURCE_FORMAT', 'Unsupported BYOK history document');
  for (const old of byok?.archives || []) {
    if (!object(old) || old.botId !== botId) continue;
    chatKey(old.key); if (!validId(old.id) || !validId(old.personaId) || !Array.isArray(old.messages) || !Number.isSafeInteger(old.updatedAt)) throw fail('SOURCE_FORMAT', 'Invalid BYOK conversation archive');
    let personaId = old.personaId;
    if (!personaRows.has(personaId)) { addPersona(personaId, null); issues.push({ personaId, reason: 'byok-persona-content-unmapped' }); }
    if (byId.has(old.id)) throw fail('SOURCE_FORMAT', 'BYOK archive identity collides with another archive');
    const transcript = [{ kind: 'legacy-byok-source', ownerUserId: old.ownerUserId ?? null, profileId: old.profileId ?? null, retention: { maxMessages: 20, maxBytes: 24000 } }];
    for (const message of old.messages) {
      if (!object(message) || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw fail('SOURCE_FORMAT', 'Invalid retained BYOK model message');
      transcript.push({ kind: 'legacy-message', source: 'byok-model-history', role: message.role, text: redact(message.content), resumeEligible: true, qqDeliveryProven: false, raw: message });
    }
    const row = { id: old.id, chatKey: old.key, personaId, legacySessionId: null, createdAt: 0, lastUsedAt: old.updatedAt, messages: [], transcript };
    archives.push(row); byId.set(row.id, row);
    issues.push({ archiveId: old.id, reason: 'bounded-byok-history-and-no-original-qq-delivery-record' });
  }
  const dsh = readDshExports(dshExportsDir, redact), dshCoverage = [];
  issues.push(...dsh.issues);
  for (const archive of archives) {
    if (missingPersonas.has(archive.personaId) && archive.continuation !== 'deleted-persona') archive.continuation = 'missing';
    if (!archive.legacySessionId) continue;
    const root = dsh.sessions.get(archive.legacySessionId);
    if (!root) { dshCoverage.push({ archiveId: archive.id, sessionId: archive.legacySessionId, status: 'missing', reason: 'offline-dsh-artifact-not-provided' }); continue; }
    archive.transcript.push(...root.transcript);
    const seen = new Set([root.header.id]);
    function descendants(id) {
      for (const child of dsh.sessions.values()) if (child.header.parentSession === id) {
        if (seen.has(child.header.id)) throw fail('DSH_CONFLICT', 'Cyclic DSH descendant lineage');
        seen.add(child.header.id); archive.transcript.push(...child.transcript); descendants(child.header.id);
      }
    }
    descendants(root.header.id);
    const descendantRows = [...seen].map(id => dsh.sessions.get(id));
    const textCount = archive.transcript.filter(row => row.kind === 'legacy-message' && row.resumeEligible).length;
    dshCoverage.push({ archiveId: archive.id, sessionId: archive.legacySessionId, status: descendantRows.some(row => row.status === 'partial') ? 'partial' : root.status, scope: 'provided root artifact and discovered descendants; absent descendants cannot be proven from the root alone', events: root.events, descendants: seen.size - 1, resumableTextMessages: textCount, reasons: descendantRows.flatMap(row => row.reasons), media: 'references-only; no media bytes copied to the bundle' });
    if (!textCount && root.events) issues.push({ archiveId: archive.id, reason: 'no-recognized-resumable-plain-text-projection' });
  }
  reader.verify(); dsh.reader?.verify();
  const missingDsh = dshCoverage.some(row => row.status === 'missing');
  const partial = issues.length > 0 || dshCoverage.some(row => row.status === 'partial');
  const coverage = {
    status: missingDsh ? 'missing' : partial ? 'partial' : 'complete',
    scope: 'retained offline source artifacts; never a claim to complete QQ platform history',
    authority: managed.sqlite ? 'sqlite-state-documents; direct-runtime-json-only-where-not-managed' : 'legacy-json-and-role-files',
    qqMessages: { status: social ? 'partial' : archives.length ? 'missing' : 'complete', source: social ? 'social-v2.recentMessages+unread' : 'none', persistedWindow: 200, persistedUnreadWindow: 100, originalTextLimit: 200, modelMessagesAreNotQqMessages: true },
    personas: [...personaCoverage.values()],
    dshTranscripts: dshCoverage,
    issues,
    sourceFiles: [...reader.evidence.values()],
    dshFiles: dsh.reader ? [...dsh.reader.evidence.values()] : [],
    credentialStoresRead: false,
    rawTranscriptsMayContainLegacyControlData: true,
    sourceWritten: false,
  };
  if (archives.length && !social && coverage.status === 'complete') coverage.status = 'partial';
  const bundle = { format: 'qq-bridge-archives', version: 1, sourceId, personas: [...personaRows.values()], archives, selected, coverage };
  validateArchiveBundle(bundle);
  return bundle;
}
