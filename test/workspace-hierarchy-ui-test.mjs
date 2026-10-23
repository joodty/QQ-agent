import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

test('management hierarchy separates current chats from platform scope and fetches only entered features',async t=>{
 const f=await createWorkspaceFixture();t.after(()=>f.close());
 const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8');
 const windows=[],errors=[];t.after(()=>windows.forEach(w=>w.close()));
 const persona=f.business.createPersona(f.principal,{chatKey:'group:789',name:'Hierarchy fixture persona',content:'A synthetic role for both authorized conversations.'}).persona;
 for(const chatKey of ['group:789','private:777']){f.business.applyPersona(f.principal,{chatKey,personaId:persona.id,expectedSelectionVersion:0});f.store.appendIncoming(chatKey,{mid:chatKey,ts:Date.now(),senderId:'777',senderName:'Fixture user',text:chatKey.startsWith('group:')?'Group-only history fixture':'Private-only history fixture'});}
 async function mount({hash='workbench',cookie=f.cookie}={}){
  const virtual=new VirtualConsole();virtual.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(html,{url:f.origin+'/workspace.html#'+hash,runScripts:'outside-only',virtualConsole:virtual}),w=dom.window;windows.push(w);
  w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});const trace=[];
  w.fetch=(route,options={})=>{const url=new URL(route,f.origin);trace.push({path:url.pathname,search:url.search,method:options.method||'GET'});return fetch(url,{...options,headers:{...options.headers,cookie,origin:f.origin}});};
  w.eval(script);return {w,d:w.document,trace};
 }
 const go=async(x,hash,check)=>{x.w.location.hash=hash;await waitFor(check,6000,'route '+hash);};
 const chat=(key,tab)=>'chat/'+encodeURIComponent(key)+'/'+tab;
 const noPlatformForms=x=>{assert.equal(x.d.querySelector('form[data-action="save-speech-platform"]'),null);assert.equal(x.d.querySelector('form[data-action="save-default-budget"]'),null);assert.equal(x.d.querySelector('form[data-action="save-speech-subsidy"]'),null);};
 const administrative=row=>/\/management\/|\/model-service$|\/accounts$|\/speech-subsidies$|\/budgets$/.test(row.path);

 await t.test('ordinary landing page has three workbench entries and a keyboard-operated account menu',async()=>{
  const x=await mount();await waitFor(()=>x.d.querySelector('.chat-list'));
  assert.equal(x.d.body.dataset.area,'workbench');const nav=x.d.getElementById('context-navigation');
  for(const label of ['我的聊天','费用总览','我的 API 配置'])assert.match(nav.textContent,new RegExp(label));
  assert.doesNotMatch(nav.textContent,/账号设置|使用帮助|退出登录|平台模型/);
  assert.equal(x.d.querySelector('#area-switch a[href^="#admin/"]:not([hidden])'),null);
  assert.ok(!x.trace.some(row=>administrative(row)||/\/speech\/|\/personas$|\/messages$|\/credentials$/.test(row.path)));
  const toggle=x.d.getElementById('account-menu-toggle'),menu=x.d.getElementById('account-menu');assert.equal(menu.hidden,true);toggle.click();assert.equal(menu.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.ok(menu.querySelector('[href="#account"]'));assert.ok(menu.querySelector('[href="#help"]'));assert.ok(menu.querySelector('[data-action="logout"]'));
  menu.dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(menu.hidden,true);assert.equal(x.d.activeElement,toggle);
  toggle.click();x.d.getElementById('main').click();assert.equal(menu.hidden,true);
  await go(x,'account',()=>x.d.getElementById('binding-qq'));toggle.click();menu.querySelector('[href="#account"]').click();assert.equal(menu.hidden,true,'reselecting the current account page closes its menu');
 });
 await t.test('a chat opens its own overview, exposes five tabs and loads speech, persona and history only on entry',async()=>{
  const x=await mount();await waitFor(()=>x.d.querySelector('.chat-list'));x.d.querySelector('[data-action="open-chat"][data-chat="group:789"]').click();
  await waitFor(()=>x.w.location.hash===('#'+chat('group:789','overview'))&&x.d.querySelector('.chat-tabs'));
  for(const tab of ['overview','personas','speech','costs','messages'])assert.ok(x.d.querySelector('.chat-tabs a[href="#'+chat('group:789',tab)+'"]'),tab);
  assert.match(x.d.querySelector('.scope-note').textContent,/仅影响当前聊天/);noPlatformForms(x);
  assert.ok(!x.trace.some(row=>/\/personas$|\/messages$|\/speech\//.test(row.path)));
  await go(x,chat('group:789','personas'),()=>x.d.getElementById('persona-form'));assert.ok(x.trace.some(row=>row.path.endsWith('/personas')&&new URLSearchParams(row.search).get('chatKey')==='group:789'));
  assert.ok(!x.trace.some(row=>row.path.endsWith('/messages')));
  await go(x,chat('group:789','speech'),()=>x.d.querySelector('form[data-action="save-speech-settings"]'));noPlatformForms(x);assert.ok(!x.trace.some(administrative));
  assert.ok(x.trace.filter(row=>row.path.endsWith('/speech/settings')).every(row=>new URLSearchParams(row.search).get('chatKey')==='group:789'));
  await go(x,chat('group:789','messages'),()=>x.d.getElementById('recent-messages')?.textContent.includes('Group-only history fixture'));
  assert.doesNotMatch(x.d.getElementById('recent-messages').textContent,/Private-only/);
  const selector=x.d.getElementById('chat-selector');selector.value='private:777';selector.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  await waitFor(()=>x.w.location.hash===('#'+chat('private:777','messages'))&&x.d.getElementById('recent-messages')?.textContent.includes('Private-only history fixture'));
  assert.doesNotMatch(x.d.getElementById('recent-messages').textContent,/Group-only/);noPlatformForms(x);
 });
 await t.test('ordinary cost summary and personal API remain scoped and guessed platform URLs cannot fetch administration',async()=>{
  const x=await mount();await waitFor(()=>x.d.querySelector('.chat-list'));
  await go(x,'cost-overview',()=>x.d.getElementById('cost-overview-panel'));
  assert.match(x.d.getElementById('main').textContent,/费用总览/);assert.ok(!x.trace.some(administrative));
  await go(x,'keys',()=>x.d.getElementById('credential-name'));assert.match(x.d.getElementById('main').textContent,/我的 API 配置/);
  await go(x,'admin/models',()=>x.w.location.hash==='#workbench'&&x.d.querySelector('.chat-list'));
  assert.ok(!x.trace.some(administrative));assert.equal(x.d.querySelector('form[data-action="save-platform-model"]'),null);
  const denied=await fetch(f.origin+'/api/platform/model-service',{headers:{cookie:f.cookie,origin:f.origin}});assert.equal(denied.status,403);
  const foreign=await mount({hash:chat('private:999','messages')});await waitFor(()=>foreign.d.querySelector('[data-retry-load]')||foreign.w.location.hash==='#workbench');
  assert.ok(!foreign.trace.some(row=>row.path.endsWith('/messages')&&new URLSearchParams(row.search).get('chatKey')==='private:999'));
 });
 await t.test('administrators retain the same chat UI while platform services and authorizations load separately',async()=>{
  const login=await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'}),cookie=f.auth.cookie(login.token).split(';')[0],x=await mount({cookie,hash:chat('group:789','speech')});
  await waitFor(()=>x.d.querySelector('form[data-action="save-speech-settings"]'));noPlatformForms(x);assert.ok(!x.trace.some(administrative));
  await go(x,'admin/overview',()=>x.d.body.dataset.area==='platform'&&x.d.getElementById('platform-overview-panel'));
  assert.match(x.d.querySelector('.platform-warning').textContent,/影响整个平台/);assert.ok(!x.trace.some(row=>row.path.endsWith('/accounts')||row.path.endsWith('/model-service')));
  const before=x.trace.length;await go(x,'admin/speech',()=>x.d.querySelector('form[data-action="save-speech-platform"]'));
  assert.equal(x.d.querySelector('form[data-action="save-speech-settings"]'),null);assert.ok(!x.trace.slice(before).some(row=>row.path.endsWith('/speech/settings')));assert.ok(x.trace.slice(before).filter(row=>row.path.endsWith('/speech/usage')).every(row=>!new URLSearchParams(row.search).has('chatKey')));
  await go(x,'admin/models',()=>x.d.querySelector('form[data-action="save-platform-model"]'));assert.ok(x.trace.some(row=>row.path.endsWith('/model-service')));assert.equal(x.d.querySelector('[name="apiKey"]').value,'');
  await go(x,'admin/accounts',()=>x.d.querySelector('[data-action="edit-account"]'));assert.ok(x.trace.some(row=>row.path.endsWith('/accounts')));
  x.w.history.back();await waitFor(()=>x.w.location.hash==='#admin/models'&&x.d.querySelector('form[data-action="save-platform-model"]'));
  assert.ok(x.trace.every(row=>row.method==='GET'),'page visits must not perform writes or paid tests');
 });
 assert.deepEqual(errors,[]);
});
