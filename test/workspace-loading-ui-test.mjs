import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

const CACHE_KEY='qq-agent-public-voice-catalogue-v1';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const tick=()=>new Promise(setImmediate);

test('workspace loading separates first settings, authenticated state and public voice caching',async t=>{
 const f=await createWorkspaceFixture();t.after(()=>f.close());
 const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8');
 const windows=[],errors=[];t.after(()=>windows.forEach(w=>w.close()));
 async function mount({view='speech',hook=null,stored=null,crypto=true,quota=false,fastTimeout=false,cookie=f.cookie,inspectEditors=false}={}){
  const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(html,{url:f.origin+'/workspace.html#'+view,runScripts:'outside-only',virtualConsole:console}),w=dom.window;windows.push(w);
  w.matchMedia=()=>({matches:false});w.AbortController=globalThis.AbortController;
  if(crypto){Object.defineProperty(w.crypto,'subtle',{value:webcrypto.subtle});w.TextEncoder=TextEncoder;}
  if(stored)w.localStorage.setItem(CACHE_KEY,stored);
  if(quota)Object.defineProperty(w.Storage.prototype,'setItem',{value(){throw Error('quota fixture');}});
  if(fastTimeout){const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...rest)=>timeout(fn,ms===12000?60:ms,...rest);}
  const wire={cookie,hook},trace=[];
  w.fetch=async(route,options={})=>{const url=new URL(route,f.origin);trace.push({path:url.pathname,search:url.search,method:options.method||'GET'});const forward=()=>fetch(url,{...options,headers:{...options.headers,cookie:wire.cookie,origin:f.origin}});return wire.hook?wire.hook(url,options,forward):forward();};
  w.eval(script+(inspectEditors?'\nglobalThis.__editorsForTest=()=>({credential:state.editCredential,account:state.editAccount});':''));return {w,d:w.document,wire,trace};
 }
 const ready=x=>waitFor(()=>x.d.querySelector('form[data-action="save-speech-settings"]'),5000,'speech settings shown');
 const go=async(x,view,selector)=>{x.w.location.hash=view;await waitFor(()=>x.d.querySelector(selector),5000,'view '+view);};
 let persisted;
 await t.test('slow usage never blocks settings and its completion preserves both draft and open picker',async()=>{
  const gate=deferred(),x=await mount({hook:async(url,options,forward)=>{if(url.pathname==='/api/platform/speech/usage')await gate.promise;return forward();}});await ready(x);
  assert.match(x.d.querySelector('#speech-usage-panel').textContent,/正在读取语音用量/);
  assert.ok(!x.trace.some(row=>row.path==='/api/platform/credentials'||row.path==='/api/platform/speech/platform'));
  assert.ok(x.trace.some(row=>row.path==='/api/platform/overview'&&row.search==='?summary=1'));
  assert.ok(x.trace.some(row=>row.path==='/api/platform/speech/settings'&&row.search.includes('compact=1')));
  const speed=x.d.getElementById('speech-chat-speed');speed.value='0.5';speed.dispatchEvent(new x.w.Event('input',{bubbles:true}));
  x.d.querySelector('form[data-action="save-speech-settings"] [data-action="choose-speech-voice"]').click();const picker=x.d.querySelector('[role="dialog"]');
  gate.resolve();await waitFor(()=>x.d.querySelector('.speech-usage-metrics'));assert.equal(x.d.getElementById('speech-chat-speed'),speed);assert.equal(speed.value,'0.5');assert.equal(x.d.querySelector('[role="dialog"]'),picker);
  x.d.querySelector('[data-voice-close]').click();persisted=x.w.localStorage.getItem(CACHE_KEY);assert.ok(persisted);
  const assets=x.trace.filter(row=>row.path.startsWith('/assets/speech-voices.')).length;
  await go(x,'home','.chat-list');await go(x,'speech','form[data-action="save-speech-settings"]');assert.equal(x.d.getElementById('speech-chat-speed').value,'0.5');
  assert.equal(x.trace.filter(row=>row.path.startsWith('/assets/speech-voices.')).length,assets);assert.equal(x.trace.filter(row=>row.path==='/api/platform/speech/settings').length,2);
 });
 await t.test('only a verified public catalogue persists; tampering, absent crypto and storage quota recover through HTTP',async()=>{
  const cached=await mount({stored:persisted});await ready(cached);assert.equal(cached.trace.filter(row=>row.path.startsWith('/assets/')).length,0);
  const poison=JSON.parse(persisted);poison.voices[0].rateCnyPer10k=.000001;poison.voices[0].name='poison-name';const tampered=JSON.stringify(poison);
  for(const options of [{stored:tampered},{stored:tampered,crypto:false},{quota:true}]){const x=await mount(options);await ready(x);assert.equal(x.trace.filter(row=>row.path.startsWith('/assets/')).length,1);assert.doesNotMatch(x.d.querySelector('[data-voice-summary]').textContent,/poison-name/);}
  const raw=cached.w.localStorage.getItem(CACHE_KEY);assert.doesNotMatch(raw,/fixture_user|fixture-admin|fixture-model-key|group:789|private:777|session|password/i);
 });
 await t.test('credentials are fetched only on relevant pages and their short cache is invalidated by explicit refresh',async()=>{
  const x=await mount({view:'home'});await waitFor(()=>x.d.querySelector('.chat-list'));assert.equal(x.trace.filter(row=>row.path==='/api/platform/credentials').length,0);
  await go(x,'keys','#credential-name');await go(x,'home','.chat-list');await go(x,'keys','#credential-name');assert.equal(x.trace.filter(row=>row.path==='/api/platform/credentials').length,1);
  x.d.querySelector('[data-action="refresh"]').click();await waitFor(()=>x.trace.filter(row=>row.path==='/api/platform/credentials').length===2);await waitFor(()=>!x.d.querySelector('[data-action="refresh"]').disabled);
  assert.ok(x.trace.filter(row=>row.path==='/api/platform/overview').length>=4);
 });
 await t.test('a hung GET has a finite error with explicit retry and a failed POST is never retried automatically',async()=>{
  let stalled=true,posts=0;const x=await mount({fastTimeout:true,hook:(url,options,forward)=>{if(stalled&&url.pathname==='/api/platform/overview')return new Promise(()=>{});if(options.method==='PUT'&&url.pathname==='/api/platform/speech/settings'){posts++;return Promise.resolve(json({error:'保存暂时失败'},503));}return forward();}});
  await waitFor(()=>x.d.querySelector('[data-retry-load]'));assert.match(x.d.getElementById('main').textContent,/读取超时/);assert.equal(x.trace.filter(row=>row.path==='/api/platform/overview').length,1);
  stalled=false;x.d.querySelector('[data-retry-load]').click();await ready(x);const form=x.d.querySelector('form[data-action="save-speech-settings"]');form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>x.d.getElementById('feedback').textContent.includes('保存暂时失败'));await tick();assert.equal(posts,1);assert.ok(form.isConnected);
 });
 await t.test('late permission failure from the old group cannot clear the newly selected private conversation',async()=>{
  const x=await mount();await ready(x);const gate=deferred();let held=false;
  x.wire.hook=async(url,options,forward)=>{if(url.pathname==='/api/platform/speech/settings'&&url.searchParams.get('chatKey')==='group:789'&&!held){held=true;await gate.promise;return json({error:'旧群权限已撤销'},403);}return forward();};
  x.d.querySelector('[data-action="refresh"]').click();await waitFor(()=>held);const selector=x.d.getElementById('chat-selector');selector.value='private:777';selector.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  assert.equal(x.d.querySelector('form[data-action="save-speech-settings"]'),null);await ready(x);const form=x.d.querySelector('form[data-action="save-speech-settings"]');assert.equal(x.d.getElementById('chat-selector').value,'private:777');
  gate.resolve();await waitFor(()=>!x.d.querySelector('[data-action="refresh"]').disabled);await tick();assert.equal(x.d.querySelector('form[data-action="save-speech-settings"]'),form);assert.equal(x.d.getElementById('chat-selector').value,'private:777');assert.equal(x.d.querySelector('[data-retry-load]'),null);
 });
 await t.test('a current permission failure clears private forms and account switching cannot reuse the old identity cache',async()=>{
  const x=await mount();await ready(x);x.wire.hook=(url,options,forward)=>url.pathname==='/api/platform/speech/settings'?Promise.resolve(json({error:'没有这个聊天的管理权限'},403)):forward();
  x.d.querySelector('[data-action="refresh"]').click();await waitFor(()=>x.d.querySelector('[data-retry-load]'));assert.equal(x.d.querySelector('form[data-action="save-speech-settings"]'),null);
  const second=await f.auth.register({username:'fixture_loading_second',password:'fixture-loading-second-pass'});x.wire.cookie=f.auth.cookie(second.token).split(';')[0];x.wire.hook=null;x.d.querySelector('[data-retry-load]').click();
  await waitFor(()=>x.d.querySelector('.empty-state h2')?.textContent==='先验证本人 QQ');assert.match(x.d.getElementById('user-label').textContent,/fixture_loading_second/);assert.equal(x.d.querySelector('#chat-selector'),null);
  assert.ok(x.trace.filter(row=>row.path==='/api/auth/status').length>=2);assert.doesNotMatch(x.w.localStorage.getItem(CACHE_KEY),/fixture_loading_second|fixture_user/);
 });
 await t.test('account switching clears credential and account editors before delayed identity confirmation',async()=>{
  const adminLogin=await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'}),adminCookie=f.auth.cookie(adminLogin.token).split(';')[0],admin=f.auth.authenticate(adminCookie);
  f.business.saveCredential(admin,{name:'Old administrator editor metadata',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-editor-isolation-key',enabled:true});
  const x=await mount({view:'accounts',cookie:adminCookie,inspectEditors:true});await waitFor(()=>x.d.querySelector('[data-action="edit-account"]'));x.d.querySelector('[data-action="edit-account"]').click();assert.ok(x.d.querySelector('form[data-action="save-account"]'));
  await go(x,'keys','#credential-name');x.d.querySelector('[data-action="edit-credential"]').click();assert.equal(x.d.getElementById('credential-name').value,'Old administrator editor metadata');assert.ok(x.w.__editorsForTest().account);
  const second=await f.auth.register({username:'fixture_editor_second',password:'fixture-editor-second-pass'}),gate=deferred();let checking=false;x.wire.cookie=f.auth.cookie(second.token).split(';')[0];
  x.wire.hook=async(url,options,forward)=>{if(url.pathname==='/api/auth/status'){checking=true;await gate.promise;}return forward();};x.d.querySelector('[data-action="refresh"]').click();await waitFor(()=>checking);
  assert.equal(x.d.querySelector('form[data-action="save-credential"]'),null);assert.equal(x.d.getElementById('main').getAttribute('aria-busy'),'true');assert.doesNotMatch(x.d.getElementById('main').textContent,/Old administrator editor metadata/);
  assert.equal(x.w.__editorsForTest().credential,null);assert.equal(x.w.__editorsForTest().account,null);
  gate.resolve();await waitFor(()=>x.d.getElementById('credential-name')&&x.d.getElementById('user-label').textContent.includes('fixture_editor_second'));assert.equal(x.d.getElementById('credential-name').value,'');assert.equal(x.d.getElementById('credential-key').required,true);assert.doesNotMatch(x.d.getElementById('main').textContent,/Old administrator editor metadata/);
  x.wire.hook=async(url,options,forward)=>url.pathname==='/api/platform/overview'?json({...await (await forward()).json(),accountId:'fixture-expired-identity'}):url.pathname==='/api/auth/status'?json({authenticated:false}):forward();
  x.d.querySelector('[data-action="refresh"]').click();await waitFor(()=>x.d.querySelector('[data-retry-load]'));assert.match(x.d.getElementById('main').textContent,/登录账号已变化/);assert.equal(x.d.getElementById('main').hasAttribute('aria-busy'),false);assert.equal(x.d.querySelector('form[data-action="save-credential"]'),null);
 });
 await t.test('a cleared cache cannot be repopulated by a credential request that started before the mutation',async()=>{
  const x=await mount({view:'home'});await waitFor(()=>x.d.querySelector('.chat-list'));const gate=deferred(),parsed=deferred();let held=false;
  x.wire.hook=async(url,options,forward)=>{if(url.pathname==='/api/platform/credentials'&&!held){held=true;const response=await forward();await gate.promise;const original=response.json.bind(response);response.json=async()=>{const body=await original();parsed.resolve();return body;};return response;}return forward();};
  x.w.location.hash='keys';await waitFor(()=>held);f.business.saveCredential(f.principal,{name:'New cache generation',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-new-generation-key',enabled:true});
  await go(x,'costs','#funding-mode');const form=x.d.querySelector('form[data-action="save-funding"]');form.elements.mode.value='disabled';form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>x.d.getElementById('feedback').textContent.includes('费用来源已保存'));
  gate.resolve();await parsed.promise;await tick();await go(x,'keys','#credential-name');assert.match(x.d.getElementById('main').textContent,/New cache generation/);
 });
 await t.test('an old group history response cannot write into an identically named node on the private page',async()=>{
  const persona=f.business.createPersona(f.principal,{chatKey:'group:789',name:'Loading archive fixture',content:'Synthetic context for loading tests.'}).persona;
  for(const key of ['group:789','private:777'])f.business.applyPersona(f.principal,{chatKey:key,personaId:persona.id,expectedSelectionVersion:f.archives.active(key)?.selectionVersion||0});
  const x=await mount({view:'chats'});await waitFor(()=>x.d.getElementById('recent-messages'));const gate=deferred();let held=false;
  x.wire.hook=async(url,options,forward)=>{if(url.pathname==='/api/platform/messages'&&url.searchParams.get('chatKey')==='group:789'){held=true;await gate.promise;return json({messages:[{text:'fixture old group transcript'}]});}return forward();};
  x.d.querySelector('[data-action="load-messages"]').click();await waitFor(()=>held);const selector=x.d.getElementById('chat-selector');selector.value='private:777';selector.dispatchEvent(new x.w.Event('change',{bubbles:true}));
  await waitFor(()=>x.d.getElementById('chat-selector')?.value==='private:777'&&x.d.getElementById('recent-messages'));const node=x.d.getElementById('recent-messages');node.textContent='private page marker';gate.resolve();await tick();await tick();assert.equal(node.textContent,'private page marker');
 });
 assert.deepEqual(errors,[]);
});
