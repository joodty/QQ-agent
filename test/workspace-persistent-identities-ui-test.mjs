import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

test('persisted names render immediately and cold group enrichment stays separate from editing',async t=>{
 const f=await createWorkspaceFixture();t.after(()=>f.close());
 const windows=[],errors=[];t.after(()=>windows.forEach(w=>w.close()));
 const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8');
 const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
 async function mount({view='workbench',hook}={}){
  const virtual=new VirtualConsole();virtual.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(html,{url:f.origin+'/workspace.html#'+view,runScripts:'outside-only',virtualConsole:virtual}),w=dom.window;windows.push(w);
  w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});const trace=[];
  w.fetch=(route,options={})=>{const url=new URL(route,f.origin);trace.push(url.pathname);const forward=()=>fetch(url,{...options,headers:{...options.headers,cookie:f.cookie,origin:f.origin}});return hook?hook(url,forward):forward();};
  w.eval(script);return {w,d:w.document,trace};
 }
 await t.test('a group-only page fetches its name without any chat and preserves the existing editor',async()=>{
  let release;const pending=new Promise(done=>release=done);
  const x=await mount({view:'chat/group%3A789/personas',hook:async(url,forward)=>{
   if(url.pathname==='/api/platform/overview'){const body=await (await forward()).json();body.scopes=body.scopes.filter(s=>s.chatKey==='group:789').map(s=>({...s,name:''}));return response(body);}
   if(url.pathname==='/api/platform/chat-identities')return pending;
   return forward();
  }});
  await waitFor(()=>x.d.getElementById('persona-content'));const field=x.d.getElementById('persona-content'),selector=x.d.getElementById('chat-selector');assert.match(selector.textContent,/群聊 789/);
  field.value='群名到达时保留这份草稿';field.dispatchEvent(new x.w.Event('input',{bubbles:true}));
  release(response({identities:[{chatKey:'group:789',name:'未聊天也能识别的群<img src=x>'},{chatKey:'private:999',name:'Unauthorized fixture nickname'}]}));
  await waitFor(()=>selector.textContent.includes('未聊天也能识别的群'));
  assert.equal(x.d.getElementById('persona-content'),field);assert.equal(field.value,'群名到达时保留这份草稿');assert.equal(selector.value,'group:789');assert.match(selector.textContent,/群 789/);
  assert.equal(x.d.querySelector('[data-chat-title] img'),null);assert.doesNotMatch(x.d.getElementById('main').textContent,/Unauthorized fixture/);
 });
 await t.test('names already returned by the persisted overview need no extra nickname request',async()=>{
  const x=await mount({hook:async(url,forward)=>{
   if(url.pathname==='/api/platform/overview'){const body=await (await forward()).json();body.scopes=body.scopes.map(s=>({...s,name:s.chatKey.startsWith('group:')?'保存过的群名':'保存过的昵称'}));return response(body);}
   if(url.pathname==='/api/platform/chat-identities')throw Error('Warm page must not wait on QQ');
   return forward();
  }});
  await waitFor(()=>x.d.querySelector('.chat-list'));assert.match(x.d.querySelector('[data-chat-title="group:789"]').textContent,/保存过的群名.*群 789/);assert.match(x.d.querySelector('[data-chat-title="private:777"]').textContent,/保存过的昵称.*QQ 777/);assert.ok(!x.trace.includes('/api/platform/chat-identities'));
 });
 await t.test('pending cold refresh retries are bounded and stop when navigating away',async()=>{
  let reads=0;const x=await mount({hook:async(url,forward)=>{
   if(url.pathname==='/api/platform/overview'){const body=await (await forward()).json();body.scopes=body.scopes.map(s=>({...s,name:''}));return response(body);}
   if(url.pathname==='/api/platform/chat-identities'){reads++;return response({identities:[],pending:true});}return forward();
  }});await waitFor(()=>reads===3,5000);await new Promise(resolve=>setTimeout(resolve,850));assert.equal(reads,3);
  x.w.location.hash='keys';await waitFor(()=>x.d.getElementById('credential-name'));await new Promise(resolve=>setTimeout(resolve,850));assert.equal(reads,3);
  let earlyReads=0;const early=await mount({hook:async(url,forward)=>{if(url.pathname==='/api/platform/overview'){const body=await (await forward()).json();body.scopes=body.scopes.map(s=>({...s,name:''}));return response(body);}if(url.pathname==='/api/platform/chat-identities'){earlyReads++;return response({identities:[],pending:true});}return forward();}});
  await waitFor(()=>earlyReads===1);early.w.location.hash='keys';await waitFor(()=>early.d.getElementById('credential-name'));await new Promise(resolve=>setTimeout(resolve,900));assert.equal(earlyReads,1,'leaving the page cancels follow-up name reads');
 });
 assert.deepEqual(errors,[]);
});
