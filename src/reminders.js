// 提醒（闹钟/计时）持久化存储。
// 文件：data/reminders.json
// 每条：{ id, chatKey, text, dueAt, createdAt, createdBy, fired }
//
// 设计：模型通过 set_reminder 工具设定 → 这里落盘 → ReminderScheduler 到点触发。
// 落盘是为了重启不丢：进程重启后调度器会重新加载所有未触发的提醒。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const REMINDER_FILE = path.join(DATA_DIR, 'reminders.json');

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REMINDER_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.reminders)) return parsed.reminders;
  } catch { /* 新文件 */ }
  return [];
}

function save(reminders) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${REMINDER_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ reminders }, null, 1), 'utf8');
  fs.renameSync(tmp, REMINDER_FILE);
}

export class ReminderStore {
  constructor() {
    this.reminders = load();
  }

  /** 新增一条提醒。返回该提醒。 */
  add({ chatKey, text, dueAt, createdBy = '', requestMessageId = null }) {
    if (requestMessageId != null) {
      const existing = this.reminders.find(r => r.chatKey === chatKey && r.createdBy === createdBy &&
        r.requestMessageId === requestMessageId && r.text === text);
      if (existing) return existing;
    }
    const entry = {
      id: `r_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      chatKey: String(chatKey),
      text: String(text ?? '').trim(),
      dueAt: Number(dueAt),
      createdAt: Date.now(),
      createdBy: String(createdBy ?? ''),
      requestMessageId,
      fired: false
    };
    this.reminders.push(entry);
    save(this.reminders);
    return entry;
  }

  /** 列出某会话未触发的提醒（按到期时间升序）。 */
  pending(chatKey = null) {
    return this.reminders
      .filter((r) => !r.fired && (!chatKey || r.chatKey === chatKey))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 取所有到点且未触发的提醒。 */
  due(now = Date.now()) {
    return this.reminders.filter((r) => !r.fired && r.dueAt <= now);
  }

  recentFired(chatKey) {
    return this.reminders.filter(r => r.chatKey === chatKey && r.fired)
      .sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0)).slice(0, 10);
  }

  reschedule(id, chatKey, requester, dueAt, requestMessageId) {
    const current = this.reminders.find(r => r.id === id && r.chatKey === chatKey &&
      r.requestMessageId != null && r.createdBy === requester);
    if (!current) return null;
    if (current.lastChangeMessageId === requestMessageId) return current;
    if (!Number.isFinite(new Date(dueAt).getTime()) || dueAt <= Date.now()) throw Error('请选择未来的提醒时间。');
    const changed = { ...current, dueAt, fired: false, firedAt: null, lastChangeMessageId: requestMessageId };
    const next = this.reminders.map(r => r === current ? changed : r);
    save(next);
    this.reminders = next;
    return changed;
  }

  /** 标记一条提醒已触发（落盘）。 */
  markFired(id, expected = null) {
    const r = this.reminders.find((x) => x.id === id);
    if (!r || (expected && r !== expected)) return false;
    r.fired = true;
    r.firedAt = Date.now();
    save(this.reminders);
    return true;
  }

  /** 取消一条提醒（按 id）。返回是否取消成功。 */
  cancel(id, chatKey, requester) {
    const entry = this.pending(chatKey).find(r => r.id === id && (r.requestMessageId == null || r.createdBy === requester));
    if (!entry) return false;
    this.reminders = this.reminders.filter(r => r !== entry);
    save(this.reminders);
    return true;
  }

  /** 清理已触发很久的旧提醒（保留最近 200 条已触发的，防文件无限增长）。 */
  prune() {
    const fired = this.reminders.filter((r) => r.fired).sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0));
    const pending = this.reminders.filter((r) => !r.fired);
    if (fired.length > 200) {
      this.reminders = [...pending, ...fired.slice(0, 200)];
      save(this.reminders);
    }
  }
}
