import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

test('unified platform resources remove personal funding controls while preserving individual preferences and administrator services',async t=>{
  const f=await createWorkspaceFixture();t.after(()=>f.close());
  const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8'),errors=[];
  const adminCookie=f.auth.cookie((await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'})).token).split(';')[0];
  async function mount({admin=false,flag=true,hash='workbench'}={}){
    const virtual=new VirtualConsole();virtual.on('jsdomError',error=>errors.push(error.message));const dom=new JSDOM(html,{url:f.origin+'/workspace.html#'+hash,runScripts:'outside-only',virtualConsole:virtual});t.after(()=>dom.window.close());const w=dom.window,d=w.document,calls=[];w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});
    w.fetch=async(route,options={})=>{const url=new URL(route,f.origin);calls.push({path:url.pathname,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});const response=await fetch(url,{...options,headers:{...options.headers,cookie:admin?adminCookie:f.cookie,origin:f.origin}});if(url.pathname==='/api/platform/overview'&&response.ok){const data=await response.json();return new Response(JSON.stringify({...data,platformResourcesOnly:flag,platformModel:{model:'fixture/platform-default',name:'Fixture Platform Model'}}),{headers:{'content-type':'application/json'}});}return response;};w.eval(script);return {w,d,calls};
  }
  async function go(x,hash,check){x.w.location.hash=hash;await waitFor(check,6000,'route '+hash);}
  const chat=tab=>'chat/'+encodeURIComponent('group:789')+'/'+tab;
  await t.test('ordinary user has no personal Key entry and old bookmarks remain read-only without credential reads',async()=>{
    const x=await mount();await waitFor(()=>x.d.querySelector('.chat-list'));assert.equal(x.d.querySelector('#context-navigation [href="#keys"]'),null);assert.equal(x.d.querySelector('main [href="#keys"]'),null);assert.match(x.d.querySelector('[data-platform-resources]').textContent,/Fixture Platform Model/);
    await go(x,'keys',()=>x.d.querySelector('[data-platform-resources]')&&x.d.querySelector('#page-title').textContent==='平台资源');assert.equal(x.d.querySelector('input[type="password"]'),null);assert.equal(x.d.querySelector('[data-action="save-credential"]'),null);assert.match(x.d.querySelector('main').textContent,/平台统一提供模型与语音/);assert.match(x.d.querySelector('main').textContent,/Fixture Platform Model/);assert.ok(!x.calls.some(c=>c.path.endsWith('/credentials')||c.path.endsWith('/model-service')));
    await go(x,chat('costs'),()=>x.d.querySelector('#chat-limit'));assert.equal(x.d.querySelector('#chat-limit').readOnly,true);assert.equal(x.d.querySelector('[data-action="save-budget"]'),null);assert.equal(x.d.querySelector('[data-action="save-funding"]'),null);assert.equal(x.d.querySelector('#chat-funding-settings'),null);assert.ok(!x.calls.some(c=>c.path.endsWith('/credentials')));
    await go(x,chat('overview'),()=>x.d.querySelector('[data-action="save-reply-settings"]'));assert.ok(x.d.querySelector('#chat-reply-percent'));await go(x,chat('personas'),()=>x.d.querySelector('#persona-form'));assert.ok(x.d.querySelector('#persona-form'));
    await go(x,chat('speech'),()=>x.d.querySelector('[data-action="save-speech-settings"]'));assert.ok(x.d.querySelector('#speech-chat-probability'));assert.equal(x.d.querySelector('[data-action="save-chat-speech-subsidy"]'),null);assert.doesNotMatch(x.d.querySelector('main').textContent,/自己的模型 Key|用户自己的模型|允许的模型费用来源/);assert.ok(x.calls.every(c=>c.method==='GET'));
  });
  await t.test('administrators keep platform model and quota management, without personal API or voice payer choices',async()=>{
    const x=await mount({admin:true,hash:chat('costs')});await waitFor(()=>x.d.querySelector('#chat-limit'));assert.equal(x.d.querySelector('#chat-limit').readOnly,false);assert.ok(x.d.querySelector('[data-action="save-budget"]'));assert.equal(x.d.querySelector('[data-action="save-funding"]'),null);
    await go(x,'admin/models',()=>x.d.querySelector('[data-action="save-platform-model"]'));assert.ok(x.d.querySelector('#platform-model-provider'));assert.ok(x.d.querySelector('#platform-model-search'));assert.ok(x.d.querySelector('#platform-model-key'));
    await go(x,'admin/budgets',()=>x.d.querySelector('[data-action="save-default-budget"]'));assert.equal(x.d.querySelector('[name="trialEnabled"]'),null);const defaultsForm=x.d.querySelector('[data-action="save-default-budget"]');defaultsForm.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>!defaultsForm.isConnected);const defaultsWrite=x.calls.find(c=>c.path==='/api/platform/budgets'&&c.method==='PUT');assert.ok(defaultsWrite);assert.equal(defaultsWrite.body.trialEnabled,undefined);assert.ok(Object.hasOwn(defaultsWrite.body,'defaultDailyLimitCny'));
    await go(x,'admin/speech',()=>x.d.querySelector('[data-action="save-speech-platform"]'));assert.ok(x.d.querySelector('[data-action="save-speech-platform"]'));
    await go(x,chat('speech'),()=>x.d.querySelector('[data-action="save-chat-speech-subsidy"]'));const form=x.d.querySelector('[data-action="save-chat-speech-subsidy"]');assert.equal(form.querySelector('[name="allowedFundingModes"]'),null);assert.ok(form.elements.dailyLimitCny);form.elements.enabled.checked=true;form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>x.calls.some(c=>c.method==='PUT'&&c.path==='/api/platform/speech/subsidy'));assert.deepEqual(x.calls.find(c=>c.method==='PUT'&&c.path==='/api/platform/speech/subsidy').body.allowedFundingModes,['platform']);assert.ok(!x.calls.some(c=>c.path==='/api/platform/credentials'));
  });
  await t.test('flag false keeps legacy personal API and payer workflow',async()=>{
    const x=await mount({flag:false,hash:'keys'});await waitFor(()=>x.d.querySelector('[data-action="save-credential"]'));assert.ok(x.d.querySelector('#context-navigation [href="#keys"]'));assert.ok(x.calls.some(c=>c.path==='/api/platform/credentials'));await go(x,chat('costs'),()=>x.d.querySelector('[data-action="save-funding"]'));assert.ok(x.d.querySelector('#funding-credential'));assert.equal(x.d.querySelector('[data-platform-resources]'),null);
  });
  assert.deepEqual(errors,[]);
});
