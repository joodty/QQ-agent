import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const X_NOTIFICATION_PATH = '/api/integrations/x-notification';
const digest = value => createHash('sha256').update(value).digest();
const handle = /^[a-z0-9_]{1,15}$/;

export function createXNotificationRelay({ settings, file, ownerChat, deliver, now = Date.now }) {
  const { token, author, accountId } = settings;
  if (!/^[a-f0-9]{64}$/.test(token) || !handle.test(author) || !/^[a-f0-9]{32}$/.test(accountId)) {
    throw Error('X notification relay configuration is invalid');
  }
  const secret = digest('Bearer ' + token);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS delivered (id TEXT PRIMARY KEY, dispatched_at INTEGER NOT NULL) STRICT');
  const claim = db.prepare('INSERT OR IGNORE INTO delivered VALUES (?, ?)');
  const prior = db.prepare('SELECT 1 FROM delivered WHERE id = ?');
  const prune = db.prepare('DELETE FROM delivered WHERE dispatched_at < ?');
  const pending = new Set();
  return {
    authorized(header) {
      return typeof header === 'string' && timingSafeEqual(digest(header), secret);
    },
    async accept(body) {
      if (!body || body.author !== author || !/^[a-f0-9]{64}$/.test(body.id) ||
          !Number.isSafeInteger(body.postedAt) || Math.abs(now() - body.postedAt) > 20 * 60_000 ||
          typeof body.preview !== 'string' || !body.preview.trim() || body.preview.length > 500 ||
          body.postId != null && !/^\d{10,24}$/.test(body.postId) ||
          body.test !== undefined && body.test !== true) return { status: 400 };
      const chatKey = ownerChat(accountId);
      if (!chatKey) return { status: 403 };
      const id = body.postId ? author + ':' + body.postId : body.id;
      if (pending.has(id) || prior.get(id)) return { status: 200, duplicate: true };
      if (pending.size >= 3) return { status: 429 };
      const preview = body.preview.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
      const link = 'https://x.com/' + author + (body.postId ? '/status/' + body.postId : '');
      const message = body.test ? '【测试】平板息屏通知转发已到达 QQ。' : `【X 通知】@${author}\n${preview}\n${link}`;
      let dispatched = false;
      pending.add(id);
      try {
        await deliver(chatKey, message, {
          guard: () => ownerChat(accountId) === chatKey,
          beforeDispatch: () => {
            prune.run(now() - 7 * 86400_000);
            dispatched = claim.run(id, now()).changes === 1;
            if (!dispatched) throw Error('already dispatched');
          }
        });
        return { status: 200 };
      } catch (error) {
        if (error?.messageId) return { status: 200 };
        return { status: dispatched ? 202 : 503 };
      } finally {
        pending.delete(id);
      }
    },
    close() { db.close(); }
  };
}

export function readXNotificationSettings(directory) {
  if (!directory) return null;
  try { return JSON.parse(readFileSync(join(directory, 'x-notification-relay'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
