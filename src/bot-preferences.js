// Account-owned AI preferences. This module never accepts credentials or grants
// bot ownership; the supplied synchronous authority callback owns that decision.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateSpeechVoiceOptions } from './speech-provider.js';

const APP_ID = 0x51504250, SCHEMA = 1;
const queues = new Map();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, allowed) => object(value) && Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
const botIdValid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const versionValid = value => Number.isSafeInteger(value) && value >= 0;
const percent = value => Number.isSafeInteger(value) && value >= 0 && value <= 100;
const fail = (code, statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const clone = value => structuredClone(value);

export const BOT_PREFERENCE_DEFAULTS = Object.freeze({
  enabled: true, mentionOnly: false, replyPercent: 10, privateReplies: true,
  groupReplies: true, contextMessages: 30, voiceEnabled: false, autoVoicePercent: 0,
  voiceType: 101001, speed: 0, volume: 0, groupIds: Object.freeze([]),
  privateIds: Object.freeze([]), personaText: '你是一个友善、可靠的智能助手。'
});
export const BOT_PREFERENCE_FIELDS = Object.freeze(Object.keys(BOT_PREFERENCE_DEFAULTS));
const booleanFields = new Set(['enabled', 'mentionOnly', 'privateReplies', 'groupReplies', 'voiceEnabled']);

function normalize(values, { nullable = false, complete = false, platform = false } = {}) {
  if (!exact(values, BOT_PREFERENCE_FIELDS) || complete && Object.keys(values).length !== BOT_PREFERENCE_FIELDS.length)
    throw fail('BOT_PREFERENCES_INVALID');
  const output = {};
  for (const field of BOT_PREFERENCE_FIELDS) {
    if (!Object.hasOwn(values, field)) { if (nullable) output[field] = null; continue; }
    const value = values[field];
    if (value === null && nullable) { output[field] = null; continue; }
    let valid;
    if (booleanFields.has(field)) valid = typeof value === 'boolean';
    else if (field === 'replyPercent' || field === 'autoVoicePercent') valid = percent(value);
    else if (field === 'contextMessages') valid = Number.isSafeInteger(value) && value >= 0 && value <= 500;
    else if (field === 'groupIds' || field === 'privateIds') {
      valid = Array.isArray(value) && value.length <= 100 && value.every(id => typeof id === 'string'
        && /^[1-9]\d{0,14}$/.test(id) && Number.isSafeInteger(Number(id))) && (!platform || value.length === 0);
      if (valid) { output[field] = [...new Set(value)]; continue; }
    } else if (field === 'personaText') valid = typeof value === 'string' && value.isWellFormed()
      && value.trim().length > 0 && value.length <= 12000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
    else {
      try { validateSpeechVoiceOptions({ [field]: value }); valid = value !== undefined; }
      catch { valid = false; }
    }
    if (!valid) throw fail('BOT_PREFERENCES_INVALID');
    output[field] = value;
  }
  return output;
}

// Runtime/worker boundary validation: concrete settings, no nullable inheritance.
export function validateBotPreferenceOverrides(values, { complete = false } = {}) {
  return normalize(values, { nullable: false, complete });
}

/**
 * update replaces all overrides: omitted/null fields inherit platform defaults.
 * updateDefaults patches the non-null platform defaults. Chat allowlists remain
 * bot-specific: platform lists must be empty, never copied from the primary bot.
 *
 * onChanged is awaited after persistence. It receives one event per bot with
 * effective settings and assertCurrent(); call that guard immediately before
 * applying settings after any asynchronous work. A failure leaves the saved
 * preferences intact and returns application.status='failed'; resave to retry.
 * This preference does not grant funding, speech subsidy or QQ membership.
 */
export function createBotPreferences({ file, auth, canManageBot, onChanged, initialBotOverrides = {} } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof auth?.verifyPrincipal !== 'function'
    || typeof canManageBot !== 'function' || onChanged !== undefined && typeof onChanged !== 'function')
    throw fail('BOT_PREFERENCES_DEPENDENCY_INVALID', 503);
  // Trusted one-time migration input. Never call this with browser-provided data.
  // Validate every seed before opening/writing storage; an existing bot row wins.
  if (!object(initialBotOverrides) || Reflect.ownKeys(initialBotOverrides).some(key => !botIdValid(key)))
    throw fail('BOT_PREFERENCES_INVALID');
  const seeds = Object.entries(initialBotOverrides).map(([botId, overrides]) => [botId, normalize(overrides, { nullable: true })]);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file), registeredBots = new Set(['primary']);
  let closed = false, pending = 0, transactionActive = false;
  const queueKey = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  function transaction(work, write = false) {
    if (closed) throw fail('BOT_PREFERENCES_CLOSED', 503);
    if (transactionActive) return work();
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN'); transactionActive = true;
    try { const result = work(); if (result?.then) throw fail('BOT_PREFERENCES_STORAGE_INVALID', 503); db.exec('COMMIT'); return result; }
    catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    finally { transactionActive = false; }
  }
  function parse(text) { try { return JSON.parse(text); } catch { throw fail('BOT_PREFERENCES_STORAGE_INVALID', 503); } }
  function platform() {
    const row = db.prepare("SELECT version,value_json FROM bot_preferences_meta WHERE name='defaults'").get();
    try {
      if (!row || !Number.isSafeInteger(row.version) || row.version < 1) throw Error();
      return { version: row.version, defaults: normalize(parse(row.value_json), { complete: true, platform: true }) };
    } catch { throw fail('BOT_PREFERENCES_STORAGE_INVALID', 503); }
  }
  function botRow(botId) {
    const row = db.prepare('SELECT version,overrides_json FROM bot_preferences WHERE bot_id=?').get(botId);
    if (!row) return { version: 0, overrides: normalize({}, { nullable: true }) };
    try {
      if (!Number.isSafeInteger(row.version) || row.version < 1) throw Error();
      return { version: row.version, overrides: normalize(parse(row.overrides_json), { nullable: true, complete: true }) };
    } catch { throw fail('BOT_PREFERENCES_STORAGE_INVALID', 503); }
  }
  try {
    db.exec('PRAGMA busy_timeout=5000');
    transaction(() => {
      const appId = db.prepare('PRAGMA application_id').get().application_id;
      const schema = db.prepare('PRAGMA user_version').get().user_version;
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (appId === 0 && schema === 0 && tables.length === 0) {
        db.exec(`CREATE TABLE bot_preferences_meta(name TEXT PRIMARY KEY,version INTEGER NOT NULL,value_json TEXT NOT NULL) STRICT;
          CREATE TABLE bot_preferences(bot_id TEXT PRIMARY KEY,version INTEGER NOT NULL,overrides_json TEXT NOT NULL) STRICT;
          CREATE TABLE bot_preferences_application(bot_id TEXT PRIMARY KEY,version INTEGER NOT NULL,defaults_version INTEGER NOT NULL,status TEXT NOT NULL) STRICT;
          PRAGMA application_id=${APP_ID}; PRAGMA user_version=${SCHEMA};`);
        db.prepare('INSERT INTO bot_preferences_meta VALUES(?,?,?)').run('defaults', 1, JSON.stringify(BOT_PREFERENCE_DEFAULTS));
      } else if (appId !== APP_ID || schema !== SCHEMA || tables.length !== 3) throw Error();
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error();
      platform();
      for (const row of db.prepare('SELECT bot_id FROM bot_preferences').all()) {
        if (!botIdValid(row.bot_id)) throw Error();
        botRow(row.bot_id);
      }
      for (const [botId, overrides] of seeds) {
        db.prepare('INSERT INTO bot_preferences VALUES(?,?,?) ON CONFLICT(bot_id) DO NOTHING').run(botId, 1, JSON.stringify(overrides));
      }
    }, true);
    db.exec('PRAGMA journal_mode=WAL');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } catch { db.close(); throw fail('BOT_PREFERENCES_STORAGE_INVALID', 503); }

  function fresh(principal) {
    try {
      const current = auth.verifyPrincipal(principal);
      if (!current || current.then || typeof current.id !== 'string') throw Error();
      return current;
    } catch { throw fail('BOT_PREFERENCES_UNAUTHENTICATED', 401); }
  }
  function admin(principal) {
    const current = fresh(principal);
    if (current.role !== 'admin') throw fail('BOT_PREFERENCES_ACCESS_DENIED', 403);
    return current;
  }
  function authorized(principal, botId, write = false) {
    const current = fresh(principal);
    if (!botIdValid(botId)) throw fail('BOT_PREFERENCES_INVALID');
    if (canManageBot(current, botId, { write }) !== true) throw fail('BOT_PREFERENCES_ACCESS_DENIED', 403);
    return current;
  }
  function application(botId, version, defaultsVersion) {
    const row = db.prepare('SELECT * FROM bot_preferences_application WHERE bot_id=?').get(botId);
    if (!row || row.version !== version || row.defaults_version !== defaultsVersion)
      return { status: onChanged ? 'pending' : 'not_connected' };
    if (!['pending', 'applied', 'failed', 'not_connected'].includes(row.status)) throw fail('BOT_PREFERENCES_STORAGE_INVALID', 503);
    return { status: row.status };
  }
  function projection(botId) {
    if (!botIdValid(botId)) throw fail('BOT_PREFERENCES_INVALID');
    const p = platform(), row = botRow(botId);
    const effective = Object.fromEntries(BOT_PREFERENCE_FIELDS.map(field => [field, row.overrides[field] ?? p.defaults[field]]));
    // mentionOnly controls trigger admission independently from replyPercent.
    // A zero ordinary probability still permits configured non-mention triggers.
    return { botId, version: row.version, defaultsVersion: p.version, platformDefaults: p.defaults,
      overrides: row.overrides, effective, application: application(botId, row.version, p.version) };
  }
  function saveApplication(view, status) {
    db.prepare(`INSERT INTO bot_preferences_application VALUES(?,?,?,?) ON CONFLICT(bot_id) DO UPDATE
      SET version=excluded.version,defaults_version=excluded.defaults_version,status=excluded.status`)
      .run(view.botId, view.version, view.defaultsVersion, status);
  }
  function enqueue(work) {
    if (closed) return Promise.reject(fail('BOT_PREFERENCES_CLOSED', 503));
    pending++;
    const previous = queues.get(queueKey) || Promise.resolve();
    const result = previous.catch(() => {}).then(work).finally(() => { pending--; });
    const settled = result.catch(() => {}).finally(() => { if (queues.get(queueKey) === settled) queues.delete(queueKey); });
    queues.set(queueKey, settled);
    return result;
  }
  async function apply(view, principal, reason) {
    const assertCurrent = () => transaction(() => {
      if (reason === 'defaults') admin(principal); else authorized(principal, view.botId, true);
      const current = projection(view.botId);
      if (current.version !== view.version || current.defaultsVersion !== view.defaultsVersion)
        throw fail('BOT_PREFERENCES_VERSION_CONFLICT', 409);
      return true;
    });
    let status = 'not_connected';
    if (onChanged) {
      try {
        assertCurrent();
        const result = await onChanged({ type: 'bot', reason, principal: fresh(principal), botId: view.botId, version: view.version,
          defaultsVersion: view.defaultsVersion, effective: clone(view.effective), assertCurrent });
        if (result?.status === 'not_connected' && result.applied === false) { status = 'not_connected'; }
        else {
          if (result === false || result?.applied === false) throw Error();
          assertCurrent(); status = 'applied';
        }
      } catch { status = 'failed'; }
    }
    transaction(() => {
      const current = projection(view.botId);
      // Another process may have committed during an awaited runtime apply.
      // A stale acknowledgement must never mark a newer policy as applied.
      if (current.version === view.version && current.defaultsVersion === view.defaultsVersion) saveApplication(view, status);
      else status = 'failed';
    }, true);
    return { botId: view.botId, status };
  }
  const service = {
    // Trusted integration acknowledgement after verified worker startup/recovery.
    // No HTTP route exposes this method or accepts an application status.
    markRuntimeApplied({botId,version,defaultsVersion}) {
      return transaction(()=>{const current=projection(botId);if(current.version!==version||current.defaultsVersion!==defaultsVersion)throw fail('BOT_PREFERENCES_VERSION_CONFLICT',409);saveApplication(current,'applied');return true;},true);
    },
    markRuntimeUnavailable(botId) {
      return transaction(()=>{const current=projection(botId);saveApplication(current,'failed');return true;},true);
    },
    whenIdle(){return queues.get(queueKey)||Promise.resolve();},
    overview(principal, fields) {
      if (!exact(fields, ['botId'])) throw fail('BOT_PREFERENCES_INVALID');
      authorized(principal, fields.botId); registeredBots.add(fields.botId);
      return transaction(() => clone(projection(fields.botId)));
    },
    defaults(principal) { fresh(principal); return transaction(() => clone(platform())); },
    update(principal, fields) {
      if (!exact(fields, ['botId', 'expectedVersion', 'overrides']) || !versionValid(fields.expectedVersion))
        return Promise.reject(fail('BOT_PREFERENCES_INVALID'));
      // Copy before queueing so the caller cannot mutate already validated input.
      let overrides;
      try { authorized(principal, fields.botId, true); overrides = normalize(fields.overrides, { nullable: true }); }
      catch (error) { return Promise.reject(error); }
      const botId = fields.botId, expectedVersion = fields.expectedVersion;
      return enqueue(async () => {
        const view = transaction(() => {
          authorized(principal, botId, true);
          const old = botRow(botId);
          if (old.version !== expectedVersion) throw fail('BOT_PREFERENCES_VERSION_CONFLICT', 409);
          db.prepare(`INSERT INTO bot_preferences VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE
            SET version=excluded.version,overrides_json=excluded.overrides_json`).run(botId, old.version + 1, JSON.stringify(overrides));
          const next = projection(botId); saveApplication(next, onChanged ? 'pending' : 'not_connected'); return next;
        }, true);
        registeredBots.add(botId);
        await apply(view, principal, 'override');
        authorized(principal, botId, true);
        return transaction(() => clone(projection(botId)));
      });
    },
    updateDefaults(principal, fields) {
      if (!exact(fields, ['expectedVersion', 'defaults']) || !versionValid(fields.expectedVersion))
        return Promise.reject(fail('BOT_PREFERENCES_INVALID'));
      let patch;
      try { admin(principal); patch = normalize(fields.defaults, { platform: true }); }
      catch (error) { return Promise.reject(error); }
      const expectedVersion = fields.expectedVersion;
      return enqueue(async () => {
        const views = transaction(() => {
          admin(principal);
          const old = platform();
          if (old.version !== expectedVersion) throw fail('BOT_PREFERENCES_VERSION_CONFLICT', 409);
          const defaults = normalize({ ...old.defaults, ...patch }, { complete: true, platform: true });
          db.prepare("UPDATE bot_preferences_meta SET version=?,value_json=? WHERE name='defaults'").run(old.version + 1, JSON.stringify(defaults));
          const ids = new Set([...registeredBots, ...db.prepare('SELECT bot_id FROM bot_preferences').all().map(row => row.bot_id)]);
          return [...ids].sort().map(botId => { const view = projection(botId); saveApplication(view, onChanged ? 'pending' : 'not_connected'); return view; });
        }, true);
        const results = await Promise.all(views.map(view => apply(view, principal, 'defaults')));
        admin(principal);
        const statuses = new Set(results.map(row => row.status));
        const status = statuses.size === 1 ? results[0].status : 'partial';
        return transaction(() => ({ ...clone(platform()), application: { status, bots: results } }));
      });
    },
    // Trusted runtime access only. Exposing this method through HTTP would bypass
    // ownership; management endpoints must use overview with a verified session.
    runtimePolicy(botId) { if (!botIdValid(botId)) throw fail('BOT_PREFERENCES_INVALID'); registeredBots.add(botId); return transaction(() => clone(projection(botId))); },
    close() { if (pending) throw fail('BOT_PREFERENCES_BUSY', 409); if (!closed) { db.close(); closed = true; } }
  };
  return service;
}
