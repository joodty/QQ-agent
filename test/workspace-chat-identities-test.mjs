import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

test('group and private chat names stay scoped, durable, optional and independent of settings',async t=>{
 let calls=[],fail=false,delay=null;
 const f=await createWorkspaceFixture({onebot:{selfId:'888',async call(action,params){
  calls.push({action,params});if(delay)await delay;if(fail)throw Error('Synthetic QQ unavailable');
  if(action==='get_friend_list')return [{user_id:777,nickname:'好友小明'},{user_id:999,nickname:'未授权好友的名字'}];
  if(action==='get_stranger_info')return {user_id:params.user_id,nickname:'非好友昵称'};
 }}});t.after(()=>f.close());
 const request=(suffix='',cookie=f.cookie)=>fetch(f.origin+'/api/platform/chat-identities'+suffix,{headers:{cookie,origin:f.origin}});
 const windows=[];t.after(()=>windows.forEach(w=>w.close()));
 async function mount({cookie=f.cookie,hash='workbench',hook}={}){
  const dom=new JSDOM(fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),{url:f.origin+'/workspace.html#'+hash,runScripts:'outside-only'}),w=dom.window;windows.push(w);
  w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});
  w.fetch=(route,options={})=>hook?.(route)||fetch(f.origin+route,{...options,headers:{...options.headers,cookie,origin:f.origin}});
  w.eval(fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8'));return {w,d:w.document};
 }
 await t.test('ordinary callers receive only authorized group and private names; guessing QQ numbers is denied before lookup',async()=>{
  assert.equal((await request('','')).status,401);
  const response=await request();assert.equal(response.status,200);
  assert.deepEqual((await response.json()).identities.map(({chatKey,name})=>({chatKey,name})).sort((a,b)=>a.chatKey.localeCompare(b.chatKey)),[{chatKey:'group:789',name:'朋友们的读书和日常闲聊群'},{chatKey:'private:777',name:'好友小明'}]);
  const before=calls.length;await request();assert.equal(calls.length,before,'cache avoids repeated QQ lookups');
  assert.equal((await request('?chatKey=private:999')).status,403);assert.equal(calls.length,before);
  assert.equal((await request('?chatKey=private:777&chatKey=private:999')).status,400);
 });
 await t.test('selected nonfriend is resolved separately, and unavailable QQ falls back to an empty name',async()=>{
  f.auth.store.grant(f.principal.id,'private:555');
  const value=await (await request('?chatKey=private:555')).json();assert.equal(value.identities.find(x=>x.chatKey==='private:555').name,'非好友昵称');
  fail=true;f.auth.store.grant(f.principal.id,'private:556');const unavailable=await request('?chatKey=private:556');assert.equal(unavailable.status,200);assert.equal((await unavailable.json()).identities.find(x=>x.chatKey==='private:556').name,'');fail=false;
 });
 await t.test('slow nickname enrichment keeps QQ fallback, selected chat, unsaved persona text and HTML escaping',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const x=await mount({hash:'chat/private%3A777/personas',hook:route=>route.startsWith('/api/platform/chat-identities')?pending:null});
  await waitFor(()=>x.d.getElementById('persona-content'));
  const selector=x.d.getElementById('chat-selector');assert.match(selector.selectedOptions[0].textContent,/QQ 777.*我的私聊/);
  const field=x.d.getElementById('persona-content');field.value='必须保留的未保存人设';field.dispatchEvent(new x.w.Event('input',{bubbles:true}));
  release(new Response(JSON.stringify({identities:[{chatKey:'private:777',name:'小明<img src=x onerror=alert(1)>'},{chatKey:'private:999',name:'伪造外部名字'}]}),{headers:{'content-type':'application/json'}}));
  await waitFor(()=>selector.selectedOptions[0].textContent.includes('小明'));
  assert.equal(x.d.getElementById('persona-content'),field);assert.equal(field.value,'必须保留的未保存人设');assert.equal(selector.value,'private:777');
  assert.match(x.d.getElementById('page-kicker').textContent,/小明.*QQ 777/);assert.equal(x.d.querySelector('[data-chat-title] img'),null);assert.doesNotMatch(x.d.getElementById('main').textContent,/伪造外部名字/);
 });
 await t.test('administrators see other private partners by name and QQ, without mislabeling them as themselves',async()=>{
  const login=await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'}),cookie=f.auth.cookie(login.token).split(';')[0],x=await mount({cookie});
  await waitFor(()=>x.d.querySelector('[data-chat-title="private:999"]')?.textContent.includes('未授权好友的名字'));
  const label=x.d.querySelector('[data-chat-title="private:999"]').textContent;assert.match(label,/QQ 999/);assert.doesNotMatch(label,/我的私聊|本人私聊/);
 });
 await t.test('permissions are rechecked after a delayed QQ lookup, including session revocation',async()=>{
  f.auth.store.grant(f.principal.id,'private:557');let release;delay=new Promise(resolve=>{release=resolve;});
  const pending=request('?chatKey=private:557');await waitFor(()=>calls.some(row=>row.params?.user_id===557));
  const old=f.auth.authenticate(f.cookie);await f.auth.logout(old);
  release();delay=null;const response=await pending;assert.ok([401,403].includes(response.status));
 });
});
