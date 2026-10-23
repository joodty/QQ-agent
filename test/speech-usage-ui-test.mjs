import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createWorkspaceFixture } from './_platform-workspace-fixture.mjs';
import { waitFor } from './_harness.mjs';

test('speech usage renders real authorized HTTP statistics without changing settings or sending a synthesis', async t => {
  const f = await createWorkspaceFixture(); let db;
  t.after(async () => { db?.close(); await f.close(); });
  const { productionPaidCallGuard } = await import('../src/paid-call-guard.js');
  const { beijingBudgetDate } = await import('../src/conversation-budget.js');
  const guard = productionPaidCallGuard(); guard.records();
  const file = path.join(f.root, 'paid-calls.sqlite'), now = Date.now(), today = beijingBudgetDate(now);
  db = new DatabaseSync(file);
  const state = JSON.parse(db.prepare("SELECT body FROM paid_documents WHERE name='conversation-budget'").get().body);
  const attrs = {};
  for (const [index, key, status, characters] of [[1,'group:789','settled',3],[2,'group:789','unknown',null],[3,'private:777','settled',4],[4,'group:999','unknown',5]]) {
    const id = index.toString().padStart(32, '0'), amount = (characters || 3) * 30;
    state.records.push({id,key,date:today,operationId:'service:speech:fixture-'+index,amountMicros:amount,actualMicros:status==='settled'?amount:null,createdAt:now,updatedAt:now,expiresAt:now+1800000,resolvedAt:status==='settled'?now:null,state:status,unknownReason:status==='unknown'?'provider_error':null});
    attrs[id] = {key,kind:'speech',...(characters===null?{}:{characters}),credentialRef:'fixture-must-stay-private',text:'fixture-private-voice-text'};
  }
  db.prepare("UPDATE paid_documents SET body=? WHERE name='conversation-budget'").run(JSON.stringify(state)+'\n');
  db.prepare("INSERT INTO paid_documents VALUES('call-attribution',?) ON CONFLICT(name) DO UPDATE SET body=excluded.body").run(JSON.stringify(attrs));
  const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM paid_documents ORDER BY name').all());
  const before = snapshot(), originalSettings = JSON.stringify(f.speech.settings(f.principal,'group:789'));
  const html = fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'), script = fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8');
  const errors = [], console = new VirtualConsole(); console.on('jsdomError',error=>errors.push(error.message));
  let usageFailure = false;
  async function mount(cookie,hash='speech') {
    const dom = new JSDOM(html,{url:f.origin+'/workspace.html#'+hash,runScripts:'outside-only',virtualConsole:console}); t.after(()=>dom.window.close());
    const w = dom.window; w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});
    w.fetch=(route,options={})=>usageFailure&&String(route).startsWith('/api/platform/speech/usage')
      ? Promise.resolve(new Response(JSON.stringify({error:'用量读取暂时失败'}),{status:503,headers:{'content-type':'application/json'}}))
      : fetch(f.origin+route,{...options,headers:{...options.headers,cookie,origin:f.origin}});
    w.eval(script); await waitFor(()=>w.document.querySelector('.speech-usage-metrics'),5000,'usage page ready'); return w;
  }
  const user = await mount(f.cookie);
  const panel = w => w.document.getElementById('speech-usage-panel');
  function submit(w,{days='7',range='chat'}={}) {const form=panel(w).querySelector('form');form.elements.days.value=days;form.elements.range.value=range;form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));}

  await t.test('ordinary page explains legacy character gaps and shows only the selected conversation', () => {
    const text=panel(user).textContent;
    assert.match(text,/成功合成/);assert.match(text,/已知 3/);assert.match(text,/1 条旧记录的字符数不可追溯/);
    assert.match(text,/0\.00009/);assert.match(text,/合成成功不代表已发送到 QQ/);assert.match(text,/免费资源包抵扣未同步/);
    assert.doesNotMatch(text,/fixture-private|fixture-must|group:999/);assert.equal(panel(user).querySelector('#speech-usage-range').options.length,1);assert.equal(panel(user).querySelector('#speech-usage-range').value,'chat');
    assert.equal(panel(user).querySelector('.speech-usage-table tbody tr').children[1].textContent,'2');
  });
  await t.test('current-chat filters preserve unsaved preferences while the authorized aggregate API still excludes a foreign group', async () => {
    user.document.querySelector('#speech-chat-speed').value='0.5';submit(user,{days:'1',range:'chat'});
    await waitFor(()=>panel(user).querySelector('#speech-usage-days')?.value==='1'&&panel(user).querySelector('.speech-usage-metrics'),5000,'current-chat date filter');
    assert.doesNotMatch(panel(user).textContent,/群聊 999/);
    const aggregate=await (await fetch(f.origin+'/api/platform/speech/usage?days=1',{headers:{cookie:f.cookie,origin:f.origin}})).json();assert.equal(aggregate.scope,'authorized');assert.equal(aggregate.conversationCount,2);assert.ok(aggregate.conversations.every(row=>row.chatKey!=='group:999'));
    assert.equal(user.document.querySelector('#speech-chat-speed').value,'0.5');assert.equal(panel(user).querySelector('#speech-usage-days').value,'1');
  });
  const adminCookie=f.auth.cookie((await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'})).token).split(';')[0], admin=await mount(adminCookie,'admin/speech');
  await t.test('administrator platform aggregate includes historical scopes and daily totals without changing speech switches', async () => {
    submit(admin,{days:'30',range:'all'});await waitFor(()=>panel(admin).querySelector('.speech-usage-conversations'),5000,'platform aggregate');
    assert.match(panel(admin).textContent,/按群聊与私聊查看（3 个聊天）/);assert.match(panel(admin).textContent,/群聊 999/);
    assert.match(panel(admin).querySelector('.speech-usage-conversations').textContent,/QQ 777/);
    assert.match(panel(admin).textContent,/0\.00021/);assert.equal(admin.document.querySelector('form[data-action="save-speech-platform"] [name="enabled"]').checked,false);
  });
  await t.test('report errors are visible instead of fabricated zero usage and retry does not write configuration', async () => {
    usageFailure=true;submit(user);await waitFor(()=>panel(user).querySelector('[role="alert"]'));
    assert.match(panel(user).textContent,/用量读取暂时失败/);assert.equal(panel(user).querySelector('.speech-usage-metrics'),null);
    usageFailure=false;submit(user);await waitFor(()=>panel(user).querySelector('.speech-usage-metrics'));
    assert.equal(snapshot(),before);assert.equal(JSON.stringify(f.speech.settings(f.principal,'group:789')),originalSettings);
    assert.ok(f.calls.every(call=>call.method==='GET'));assert.deepEqual(errors,[]);
  });
});
