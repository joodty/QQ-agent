import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

const chat=(key,tab)=>'#chat/'+encodeURIComponent(key)+'/'+tab;
test('current chat authorization is discoverable before long voice settings and preset budgets never enable funding',async t=>{
 const credentials={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixture-speech-identity',secretKey:'fixture-speech-secret-value'};
 const f=await createWorkspaceFixture({speechCredentials:()=>credentials});t.after(()=>f.close());const adminCookie=f.auth.cookie((await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'})).token).split(';')[0],admin=f.auth.authenticate(adminCookie);
 f.speech.updatePlatform(admin,{expectedVersion:f.speech.platformOverview(admin).version,enabled:true});
 const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8'),errors=[];
 async function mount(hash,cookie=adminCookie){const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));const dom=new JSDOM(html,{url:f.origin+'/workspace.html'+hash,runScripts:'outside-only',virtualConsole:console});t.after(()=>dom.window.close());const w=dom.window;w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});Object.defineProperty(w,'innerWidth',{value:1000});const scrolled=[];w.HTMLElement.prototype.scrollIntoView=function(){scrolled.push(this);};w.fetch=(route,options={})=>fetch(f.origin+route,{...options,headers:{...options.headers,cookie,origin:f.origin}});w.eval(script);return {w,d:w.document,scrolled};}
 const save=async(x,action,change)=>{const form=x.d.querySelector(`form[data-action="${action}"]`);change(form);form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>!form.isConnected&&x.d.querySelector(`form[data-action="${action}"]`),5000,'save followed by current scope reload');};
 await t.test('an unfunded private chat shows its explicit authorization first and the disabled control links directly to it',async()=>{
  assert.equal(f.business.funding(admin,'private:777').enabled,false);const x=await mount(chat('private:777','speech'));await waitFor(()=>x.d.querySelector('form[data-action="save-chat-speech-subsidy"]'));
  const panel=x.d.getElementById('chat-speech-authorization'),settings=x.d.querySelector('form[data-action="save-speech-settings"]');assert.equal(x.d.getElementById('main').querySelector('section.panel'),panel);assert.ok(panel.querySelector('details').open);assert.ok(settings.elements.enabled.disabled);assert.doesNotMatch(x.d.getElementById('main').textContent,/左侧|右侧/);
  x.d.querySelector('[data-action="locate-speech-authorization"]').click();assert.equal(x.d.activeElement,panel.querySelector('[name="enabled"]'));assert.equal(x.scrolled.at(-1),x.d.activeElement);
  await save(x,'save-chat-speech-subsidy',form=>{form.elements.enabled.checked=true;form.elements.dailyLimitCny.value='.15';});assert.equal(f.speech.settings(admin,'private:777').subsidy.dailyLimitCny,.15);assert.equal(f.business.funding(admin,'private:777').enabled,false);
  assert.equal(x.d.getElementById('main').querySelector('section.panel').id,'chat-speech-authorization');assert.equal(x.d.querySelector('form[data-action="save-speech-settings"]').elements.enabled.disabled,false);assert.equal(x.d.querySelector('form[data-action="save-speech-settings"]').elements.enabled.checked,false);
  await save(x,'save-speech-settings',form=>{form.elements.enabled.checked=true;});assert.equal(f.speech.settings(admin,'private:777').settings.enabled,true);assert.equal(f.speech.runtimePolicy('private:777').allowed,false);assert.equal(f.speech.settings(admin,'private:999').subsidy.enabled,false);
 });
 await t.test('administrator can save a preset limit for a known unfunded private chat while funding remains disabled',async()=>{
  const x=await mount(chat('private:777','costs'));await waitFor(()=>x.d.querySelector('form[data-action="save-budget"]'));const before=f.business.funding(admin,'private:777'),start=f.calls.length;
  assert.match(x.d.getElementById('chat-funding-guidance').textContent,/保存额度不会启用模型调用/);assert.match(x.d.querySelector('form[data-action="save-budget"] button').textContent,/保存预设额度/);x.d.querySelector('[data-action="locate-funding"]').click();assert.equal(x.d.activeElement.id,'funding-mode');
  await save(x,'save-budget',form=>form.elements.dailyLimitCny.value='.75');const after=f.business.funding(admin,'private:777');assert.equal(after.enabled,false);assert.equal(after.mode,before.mode);assert.equal(after.version,before.version);assert.equal(after.credentialRef,before.credentialRef);assert.equal(Number(x.d.getElementById('chat-limit').value),.75);assert.match(x.d.getElementById('feedback').textContent,/预设额度已保存.*尚未启用付费/);
  assert.ok(!f.calls.slice(start).some(call=>call.method==='PUT'&&call.path==='/api/platform/funding'));assert.equal(f.speech.runtimePolicy('private:777').allowed,false);
 });
 await t.test('ordinary users cannot see administrator authorization controls or change a foreign chat budget',async()=>{
  const x=await mount(chat('group:789','speech'),f.cookie);await waitFor(()=>x.d.querySelector('form[data-action="save-speech-settings"]'));assert.equal(x.d.getElementById('chat-speech-authorization'),null);assert.equal(x.d.querySelector('[data-action="locate-speech-authorization"]'),null);
  const denied=await fetch(f.origin+'/api/platform/budgets',{method:'PUT',headers:{cookie:f.cookie,origin:f.origin,'content-type':'application/json'},body:JSON.stringify({chatKey:'private:999',dailyLimitCny:99})});assert.equal(denied.status,403);assert.ok(!f.calls.some(call=>/preview|TextToVoice|send_msg|completions/.test(call.path)));
 });
 assert.deepEqual(errors,[]);
});
