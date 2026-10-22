import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createConversationBudget, validateConversationBudgetText, beijingBudgetDate } from '../src/conversation-budget.js';

const QUOTE = Object.freeze({ currency: 'CNY', complete: true });
function memoryStorage() {
  const docs = new Map();
  return { transaction(run) { const before = new Map(docs); try { return run(); } catch (error) { docs.clear(); for (const [key, value] of before) docs.set(key, value); throw error; } },
    readText(file) { return docs.get(file) ?? null; },
    writeText(file, text, expected) { assert.equal(docs.get(file) ?? null, expected); docs.set(file, text); },
    replace(file, text) { docs.set(file, text); } };
}
function sqliteStorage(file) {
  const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS documents (name TEXT PRIMARY KEY, body TEXT NOT NULL)'); let depth = 0;
  return { db, transaction(run) { const nested = depth++ > 0; if (!nested) db.exec('BEGIN IMMEDIATE'); try { const result = run(); if (!nested) db.exec('COMMIT'); return result; } catch (error) { if (!nested) db.exec('ROLLBACK'); throw error; } finally { depth--; } },
    readText(name) { return db.prepare('SELECT body FROM documents WHERE name=?').get(name)?.body ?? null; },
    writeText(name, text, expected) { const previous = db.prepare('SELECT body FROM documents WHERE name=?').get(name)?.body ?? null; assert.equal(previous, expected); db.prepare('INSERT INTO documents(name,body) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(name, text); } };
}
function fixture(t, storage = memoryStorage()) {
  let clock = Date.parse('2026-10-22T04:00:00Z');
  const create = extra => createConversationBudget({ storage, file: 'budget-fixture', now: () => clock, ...extra });
  return { storage, create, budget: create(), at: value => { clock = typeof value === 'string' ? Date.parse(value) : value; }, advance: value => { clock += value; }, now: () => clock };
}
function reserve(budget, key, operationId, amount = 0.1) { return budget.reserve(key, { operationId, estimatedMaxCost: amount, quote: QUOTE }); }
function charge(budget, key, operationId, amount) { const row = reserve(budget, key, operationId, amount); assert.equal(row.allowed, true); assert.equal(budget.dispatch(row.id).mayDispatch, true); budget.settle(row.id, { amount, currency: 'CNY' }); return row; }

if (process.argv[2] === '--reserve-worker') {
  const storage = sqliteStorage(process.argv[3]);
  const budget = createConversationBudget({ storage, file: 'shared-budget', now: () => Date.parse('2026-10-22T04:00:00Z') }); let accepted = 0;
  for (let n = 0; n < 6; n++) if (reserve(budget, 'private:999', 'worker-' + process.argv[4] + '-' + n).allowed) accepted++;
  storage.db.close(); process.stdout.write(JSON.stringify({ accepted })); process.exit(0);
}

test('group, private and instance identities have independent one-yuan daily budgets', t => {
  const { budget, create } = fixture(t), second = create({ storage: memoryStorage(), botId: 'secondary' });
  for (const key of ['group:1', 'private:1', 'private:2']) assert.equal(budget.status(key).dailyLimitCny, 1);
  charge(budget, 'group:1', 'whole-day', 1); assert.equal(reserve(budget, 'group:1', 'over').allowed, false);
  assert.equal(reserve(budget, 'private:1', 'private').allowed, true); assert.equal(reserve(second, 'group:1', 'whole-day').allowed, true);
  for (const key of [null, 1, ['group:1'], 'group:01', 'group:-1', 'group:9007199254740992', 'internal:1']) assert.throws(() => budget.status(key), { statusCode: 400 });
});

test('80 percent degrades and 100 percent rejects another reservation', t => {
  const { budget } = fixture(t); charge(budget, 'group:1', 'first', 0.79); assert.equal(budget.status('group:1').state, 'normal');
  charge(budget, 'group:1', 'threshold', 0.01); assert.equal(budget.status('group:1').action, 'degrade');
  const last = reserve(budget, 'group:1', 'last', 0.2); assert.equal(last.allowed, true); assert.equal(last.action, 'degrade');
  assert.equal(budget.status('group:1').state, 'exhausted'); assert.equal(reserve(budget, 'group:1', 'denied').allowed, false);
});

test('holds are shared by every caller of one conversation and are independent across conversations', t => {
  const f = fixture(t), otherBrowser = f.create();
  for (let n = 0; n < 10; n++) assert.equal(reserve(n % 2 ? otherBrowser : f.budget, 'group:1', 'hold-' + n).allowed, true);
  assert.equal(otherBrowser.status('group:1').reservedCny, 1); assert.equal(reserve(f.budget, 'group:1', 'extra').allowed, false);
  assert.equal(reserve(f.budget, 'private:1', 'same-number').allowed, true);
});

test('each operation admits one hold and dispatch permits one real provider attempt', t => {
  const { budget } = fixture(t), first = reserve(budget, 'group:1', 'operation');
  assert.equal(reserve(budget, 'group:1', 'operation').id, first.id); assert.equal(budget.active().length, 1);
  assert.throws(() => reserve(budget, 'private:1', 'operation'), { statusCode: 409 });
  assert.throws(() => reserve(budget, 'group:1', 'operation', 0.2), { statusCode: 409 });
  assert.throws(() => budget.reserve('group:1', { operationId: 'operation', estimatedMaxCost: 0.1, quote: { currency: 'USD', complete: true } }), { statusCode: 409 });
  assert.equal(budget.dispatch(first.id).mayDispatch, true); assert.equal(budget.dispatch(first.id).mayDispatch, false);
  assert.equal(reserve(budget, 'group:1', 'operation').allowed, false);
});

test('settlement is durable, idempotent, cannot be repriced, and actual overspend is never clipped', t => {
  const f = fixture(t), hold = reserve(f.budget, 'group:1', 'overage', 0.1); f.budget.dispatch(hold.id);
  assert.equal(f.budget.settle(hold.id, { amount: 1.4, currency: 'CNY' }).actualCny, 1.4);
  assert.equal(f.budget.settle(hold.id, { amount: 1.4, currency: 'CNY' }).actualCny, 1.4);
  assert.throws(() => f.budget.settle(hold.id, { amount: 0.1, currency: 'CNY' }), { statusCode: 409 });
  assert.equal(f.create().status('group:1').spentCny, 1.4); assert.equal(f.budget.status('group:1').reservedCny, 0);
  assert.equal(reserve(f.budget, 'group:1', 'overage', 0.1).allowed, false); assert.equal(reserve(f.budget, 'group:1', 'new').allowed, false);
  assert.equal(f.budget.release(hold.id).state, 'settled');
});

test('released operation ids cannot be reused and only uncharged work can be released', t => {
  const { budget } = fixture(t), hold = reserve(budget, 'group:1', 'release');
  assert.equal(budget.release(hold.id).state, 'released'); assert.equal(budget.release(hold.id).state, 'released');
  assert.equal(reserve(budget, 'group:1', 'release').allowed, false); assert.equal(budget.dispatch(hold.id).mayDispatch, false);
  assert.throws(() => budget.settle(hold.id, { amount: 0.1, currency: 'CNY' }), { statusCode: 409 });
  const live = reserve(budget, 'group:1', 'sent'); budget.dispatch(live.id); assert.throws(() => budget.release(live.id), { statusCode: 409 });
  assert.equal(budget.release(live.id, { confirmedNotCharged: true }).state, 'released'); assert.equal(budget.status('group:1').remainingCny, 1);
});

test('unknown transport cost survives lease expiry and restart until explicit reconciliation', t => {
  const f = fixture(t), hold = reserve(f.budget, 'private:9', 'timeout', 0.6); f.budget.dispatch(hold.id); f.budget.markUnknown(hold.id, { reason: 'timeout' });
  f.advance(40 * 60_000); const restarted = f.create(); assert.equal(restarted.status('private:9').reservedCny, 0.6); assert.equal(restarted.status('private:9').staleReservations, 1);
  assert.equal(restarted.status('private:9').unknownReservations, 1); assert.equal(reserve(restarted, 'private:9', 'other', 0.5).allowed, false);
  assert.throws(() => restarted.release(hold.id), { statusCode: 409 }); restarted.settle(hold.id, { amount: 0.4, currency: 'CNY' });
  assert.equal(restarted.status('private:9').spentCny, 0.4); assert.equal(restarted.status('private:9').reservedCny, 0);
});

test('unsettled dispatched calls remain reserved after a crash even if no timeout marker was written', t => {
  const f = fixture(t), hold = reserve(f.budget, 'group:2', 'crash', 0.9); f.budget.dispatch(hold.id); f.advance(2 * 86_400_000);
  const restarted = f.create(); assert.equal(restarted.status('group:2').reservedCny, 0.9); assert.equal(restarted.status('group:2').activeReservations, 1);
  assert.equal(reserve(restarted, 'group:2', 'new', 0.2).allowed, false); restarted.release(hold.id, { confirmedNotCharged: true });
  assert.equal(restarted.status('group:2').remainingCny, 1);
});

test('Beijing midnight resets settled-day allowance while unresolved holds still protect the new day', t => {
  const f = fixture(t); f.at('2026-10-22T15:59:59Z'); charge(f.budget, 'group:1', 'before-midnight', 0.6);
  const hold = reserve(f.budget, 'group:1', 'crossing', 0.2); f.budget.dispatch(hold.id); f.at('2026-10-22T16:00:00Z');
  assert.equal(beijingBudgetDate(f.now()), '2026-10-23'); assert.equal(f.budget.status('group:1').spentCny, 0); assert.equal(f.budget.status('group:1').reservedCny, 0.2);
  f.budget.settle(hold.id, { amount: 0.15, currency: 'CNY' }); assert.equal(f.budget.status('group:1').spentCny, 0); assert.equal(f.budget.status('group:1').reservedCny, 0);
  assert.equal(f.budget.records({ key: 'group:1', date: '2026-10-22' }).reduce((sum, row) => sum + row.actualCny, 0), 0.75);
});

test('valid zero overrides block paid work and CAS edits cannot overwrite another administrator', t => {
  const f = fixture(t); f.budget.update({ configVersion: 1, overrides: { 'group:1': { dailyLimitCny: 0 }, 'private:1': { dailyLimitCny: 0.3 } } });
  assert.equal(reserve(f.budget, 'group:1', 'zero').allowed, false); assert.equal(f.budget.status('private:1').dailyLimitCny, 0.3);
  assert.throws(() => f.create().update({ configVersion: 1, defaultDailyLimitCny: 4 }), { statusCode: 409 });
  f.budget.update({ configVersion: 2, overrides: { 'group:1': null } }); assert.equal(f.budget.status('group:1').dailyLimitCny, 1); assert.equal(f.budget.status('private:1').dailyLimitCny, 0.3);
});

test('budget-disable is explicit per scope and does not create role-based exceptions', t => {
  const { budget } = fixture(t); budget.update({ configVersion: 1, enabled: false, overrides: { 'private:1': { enabled: true, dailyLimitCny: 0 } } });
  assert.equal(reserve(budget, 'group:1', 'unlimited', 2).allowed, true); assert.equal(budget.status('group:1').state, 'disabled');
  assert.equal(reserve(budget, 'private:1', 'limited').allowed, false);
});

test('currency and completeness must be explicitly valid, and malformed numeric quotes never create holds', t => {
  const f = fixture(t);
  for (const quote of [undefined, { currency: 'USD', complete: true }, { currency: 'CNY', complete: false }, { currency: 'CNY', complete: 1 }, { currency: 'CNY' }]) {
    const row = f.budget.reserve('group:1', { operationId: 'no-quote', estimatedMaxCost: 0.1, ...(quote ? { quote } : {}) }); assert.equal(row.allowed, false); assert.equal(row.state, 'unsupported');
  }
  for (const amount of ['0.1', NaN, Infinity, -1, 0, 1_000_001]) assert.throws(() => reserve(f.budget, 'group:1', 'bad-amount', amount), { statusCode: 400 });
  assert.throws(() => f.budget.reserve('group:1', { operationId: 'array-quote', quote: [] }), { statusCode: 400 }); assert.equal(f.budget.active().length, 0);
});

test('settlement accepts only CNY numeric usage and leaves the original hold intact on failure', t => {
  const f = fixture(t), hold = reserve(f.budget, 'group:1', 'settlement'); f.budget.dispatch(hold.id);
  for (const actual of [{ amount: '0.1', currency: 'CNY' }, { amount: NaN, currency: 'CNY' }, { amount: 0.1, currency: 'USD' }, { amount: -1, currency: 'CNY' }]) assert.throws(() => f.budget.settle(hold.id, actual), { statusCode: 400 });
  assert.equal(f.budget.status('group:1').reservedCny, 0.1); f.budget.settle(hold.id, { amount: 0, currency: 'CNY' }); assert.equal(f.budget.status('group:1').spentCny, 0);
});

test('micro-CNY arithmetic fills an exact yuan without floating point gaps and rounds tiny costs conservatively', t => {
  const { budget } = fixture(t); for (let i = 0; i < 10; i++) charge(budget, 'group:1', 'charge-' + i, 0.1);
  assert.equal(budget.status('group:1').spentCny, 1); assert.equal(reserve(budget, 'group:1', 'tiny', Number.MIN_VALUE).allowed, false);
  const tiny = reserve(budget, 'private:1', 'tiny', Number.MIN_VALUE); assert.equal(tiny.reservation.amountCny, 0.000001);
});

test('malformed and future documents fail closed without replacement or implicit repair', t => {
  const f = fixture(t), before = f.storage.readText('budget-fixture');
  for (const bad of ['{broken', '{"version":2}', JSON.stringify({ ...JSON.parse(before), hidden: true })]) {
    f.storage.replace('budget-fixture', bad); assert.throws(() => f.create(), { statusCode: 503 }); assert.equal(f.storage.readText('budget-fixture'), bad);
  }
  f.storage.replace('budget-fixture', before); const data = JSON.parse(before); data.config.overrides['group:01'] = {}; assert.throws(() => validateConversationBudgetText(JSON.stringify(data)), { statusCode: 503 });
  assert.equal(f.storage.readText('budget-fixture'), before);
});

test('invalid configuration never mutates the document and returned data cannot mutate live state', t => {
  const f = fixture(t), original = f.storage.readText('budget-fixture');
  for (const patch of [{ enabled: 'true' }, { leaseMs: 10 }, { defaultDailyLimitCny: '1' }, { defaultDailyLimitCny: NaN }, { defaultDailyLimitCny: 0.0000001 }, { overrides: [] }, { overrides: { 'private:1': { dailyLimitCny: -1 } } }, { overrides: { 'group:1': { roleBypass: true } } }]) {
    assert.throws(() => f.budget.update({ configVersion: 1, ...patch }), { statusCode: 400 }); assert.equal(f.storage.readText('budget-fixture'), original);
  }
  const cfg = f.budget.config(); cfg.overrides['group:1'] = { dailyLimitCny: 0 }; assert.equal(f.budget.status('group:1').dailyLimitCny, 1);
});

test('SQLite storage persists settled and unresolved records and outer rollback removes admissions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-budget-test-')), file = path.join(root, 'fixture.sqlite'), opened = [];
  t.after(() => { for (const s of opened) s.db.close(); assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-budget-test-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const storage = sqliteStorage(file); opened.push(storage); const f = fixture(t, storage); charge(f.budget, 'group:1', 'settled', 0.2); const hold = reserve(f.budget, 'group:1', 'pending', 0.3); f.budget.dispatch(hold.id);
  const reopened = sqliteStorage(file); opened.push(reopened); const next = createConversationBudget({ storage: reopened, file: 'budget-fixture', now: f.now }); assert.equal(next.status('group:1').spentCny, 0.2); assert.equal(next.status('group:1').reservedCny, 0.3);
  assert.throws(() => storage.transaction(() => { reserve(f.budget, 'private:1', 'rollback'); throw Error('rollback'); }), /rollback/); assert.equal(next.status('private:1').reservedCny, 0);
});

test('independent processes cannot over-admit a shared private conversation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-budget-test-')), file = path.join(root, 'shared.sqlite');
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'qq-agent-budget-test-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const initial = sqliteStorage(file); createConversationBudget({ storage: initial, file: 'shared-budget', now: () => Date.parse('2026-10-22T04:00:00Z') }); initial.db.close();
  const workers = Array.from({ length: 4 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--reserve-worker', file, String(i)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', diagnostic = '';
    child.stdout.on('data', part => output += part); child.stderr.on('data', part => diagnostic += part); child.on('error', reject); child.on('exit', code => { if (code) return reject(Error(diagnostic)); try { resolve(JSON.parse(output).accepted); } catch (error) { reject(error); } });
  }));
  assert.equal((await Promise.all(workers)).reduce((sum, value) => sum + value, 0), 10);
  const final = sqliteStorage(file); try { assert.equal(createConversationBudget({ storage: final, file: 'shared-budget', now: () => Date.parse('2026-10-22T04:00:00Z') }).status('private:999').reservedCny, 1); } finally { final.db.close(); }
});

test('a complete currency flag cannot substitute for an explicit numeric request cost estimate', t => {
  const { budget } = fixture(t);
  assert.throws(() => budget.reserve('group:1', { operationId: 'missing-cost', quote: QUOTE }), { statusCode: 400 });
  assert.equal(budget.active().length, 0);
});

test('dispatch rechecks lowered or zero limits without rejecting a legal hold that exactly fills its budget', t => {
  const { budget } = fixture(t), hold = reserve(budget, 'group:1', 'pending-policy', 0.8);
  budget.update({ configVersion: 1, overrides: { 'group:1': { dailyLimitCny: 0 } } });
  assert.equal(budget.dispatch(hold.id).mayDispatch, false); assert.equal(budget.records({ key: 'group:1' })[0].state, 'reserved');
  budget.update({ configVersion: 2, overrides: { 'group:1': { dailyLimitCny: 0.7 } } }); assert.equal(budget.dispatch(hold.id).mayDispatch, false);
  budget.update({ configVersion: 3, overrides: { 'group:1': { dailyLimitCny: 0.8 } } }); assert.equal(budget.dispatch(hold.id).mayDispatch, true);
});

test('an actual overrun pauses other reserved attempts before their network dispatch', t => {
  const { budget } = fixture(t), first = reserve(budget, 'private:1', 'provider-a', 0.6), second = reserve(budget, 'private:1', 'provider-b', 0.4);
  assert.equal(budget.dispatch(first.id).mayDispatch, true); budget.settle(first.id, { amount: 0.7, currency: 'CNY' });
  assert.equal(budget.dispatch(second.id).mayDispatch, false); assert.equal(budget.records({ key: 'private:1' }).find(row => row.id === second.id).state, 'reserved');
  budget.release(second.id); assert.equal(budget.status('private:1').spentCny, 0.7); assert.equal(budget.status('private:1').reservedCny, 0);
});
