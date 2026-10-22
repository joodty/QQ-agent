import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { validatePlatformAccountBundle } from './platform-store.js';
import { platformBotScopes } from './platform-auth-core.js';

/** Read one consistent legacy SQLite snapshot; no imports of legacy code. */
export function readLegacyPlatformAccounts({ file, sourceId = 'legacy-bridge-accounts' } = {}) {
  if (!file || !fs.statSync(file).isFile()) throw new Error('Expected an existing private source SQLite file');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== 0x51514254 || db.prepare('PRAGMA user_version').get().user_version !== 1) throw new Error('Unsupported legacy account SQLite identity');
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    for (const name of ['accounts', 'auth_sessions', 'account_scopes']) if (!tables.has(name)) throw new Error('Required legacy account table missing');
    const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at,id').all();
    const documentPaths = new Set(rows.map(row => row.document_path));
    if (documentPaths.size !== 1) throw new Error('Expected exactly one authoritative account document');
    const users = rows.map(row => {
      const scopes = platformBotScopes({ botScopes: db.prepare('SELECT bot_id AS botId,conversation_key AS key FROM account_scopes WHERE account_id=?').all(row.id) });
      return { id: row.id, username: row.username, role: row.role, disabled: Boolean(row.disabled), conversationKeys: scopes.filter(scope => scope.botId === 'primary').map(scope => scope.key), botScopes: scopes,
        password: { algorithm: row.password_algorithm, salt: row.password_salt, key: row.password_hash }, passwordVersion: row.password_version, createdAt: row.created_at, updatedAt: row.updated_at };
    });
    const sessions = db.prepare('SELECT hash,account_id AS userId,password_version AS passwordVersion,created_at AS createdAt,expires_at AS expiresAt FROM auth_sessions ORDER BY created_at,hash').all();
    const bindings = tables.has('tenant_qq_bindings') ? db.prepare('SELECT qq,user_id AS userId,verified_at AS verifiedAt FROM tenant_qq_bindings ORDER BY user_id').all() : [];
    const challenges = tables.has('tenant_binding_challenges') ? db.prepare('SELECT id,user_id AS userId,qq,code_hash AS codeHash,created_at AS createdAt,expires_at AS expiresAt,attempts,consumed_at AS consumedAt FROM tenant_binding_challenges ORDER BY id').all() : [];
    const delegations = tables.has('tenant_delegations') ? db.prepare('SELECT user_id AS userId,bot_id AS botId,conversation_key AS key FROM tenant_delegations ORDER BY user_id,bot_id,conversation_key').all() : [];
    const conversations = [];
    for (const [table, column] of [['archive_records', 'conversation_key'], ['conversation_roles', 'conversation_key'], ['tenant_funding', 'conversation_key']]) {
      if (tables.has(table)) conversations.push(...db.prepare(`SELECT DISTINCT bot_id AS botId,${column} AS key FROM ${table} WHERE ${column} IS NOT NULL AND ${column}<>''`).all());
    }
    const uniqueConversations = [...new Map(conversations.map(row => [JSON.stringify([row.botId, row.key]), row])).values()];
    const bundle = validatePlatformAccountBundle({ format: 'qq-agent-platform-accounts', version: 1, sourceId, auth: { version: 1, users, sessions }, bindings, challenges, delegations, conversations: uniqueConversations });
    db.exec('COMMIT'); return bundle;
  } finally { db.close(); }
}

export function platformAccountImportCounts(bundle) {
  bundle = validatePlatformAccountBundle(bundle);
  return { accounts: bundle.auth.users.length, sessions: bundle.auth.sessions.length,
    scopes: bundle.auth.users.reduce((sum, user) => sum + platformBotScopes(user).length, 0),
    bindings: bundle.bindings.length, challenges: bundle.challenges.length, delegations: bundle.delegations.length, conversations: bundle.conversations.length };
}
