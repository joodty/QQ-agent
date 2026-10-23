import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

const chat=(key,tab)=>'#chat/'+encodeURIComponent(key)+'/'+tab;
test('reply and voice controls stay separate while administrators can authorize the current private chat',async t=>{
 const credential={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixture-speech-identity',secretKey:'fixture-speech-secret-value'};
 const f=await createWorkspaceFixture({speechCredentials:()=>credential});t.after(()=>f.close());
 const adminCookie=f.auth.cookie((await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'})).token).split(';')[0],admin=f.auth.authenticate(adminCookie),platform=f.speech.platformOverview(admin);f.speech.updatePlatform(admin,{expectedVersion:platform.version,enabled:true});
 const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8'),errors=[];
 async function mount(hash,cookie=f.cookie){const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));const dom=new JSDOM(html,{url:f.origin+'/workspace.html'+hash,runScripts:'outside-only',virtualConsole:console});t.after(()=>dom.window.close());const w=dom.window;w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});w.fetch=(route,options={})=>fetch(f.origin+route,{...options,headers:{...options.headers,cookie,origin:f.origin}});w.eval(script);return {w,d:w.document};}
 const request=async(key,cookie=f.cookie)=>{const response=await fetch(f.origin+'/api/platform/reply-settings?chatKey='+encodeURIComponent(key),{headers:{cookie,origin:f.origin}});assert.equal(response.status,200);return response.json();};
 const save=async(x,action,change)=>{const form=x.d.querySelector(`form[data-action="${action}"]`);change(form);form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>!form.isConnected&&x.d.querySelector(`form[data-action="${action}"]`),5000,'save and scope reload');};
 await t.test('ordinary group and private reply probability can be saved and inherited without changing voice probability',async()=>{
  const voiceBefore=JSON.stringify(f.speech.settings(f.principal,'group:789').settings),x=await mount(chat('group:789','overview'));await waitFor(()=>x.d.getElementById('chat-reply-percent'));
  assert.match(x.d.getElementById('chat-reply-settings').textContent,/先决定是否回复.*语音概率/);assert.equal(x.d.querySelector('form[data-action="save-chat-speech-subsidy"]'),null);
  await save(x,'save-reply-settings',form=>form.elements.replyPercent.value='40');assert.equal((await request('group:789')).replyPercent,40);assert.equal((await request('private:777')).replyPercent,null);
  const old=x.d.querySelector('form[data-action="save-reply-settings"]');x.w.location.hash=chat('private:777','overview');await waitFor(()=>x.d.querySelector('form[data-action="save-reply-settings"]')&&x.d.querySelector('form[data-action="save-reply-settings"]')!==old);
  await save(x,'save-reply-settings',form=>form.elements.replyPercent.value='0');assert.equal((await request('private:777')).replyPercent,0);assert.equal((await request('group:789')).replyPercent,40);
  await save(x,'save-reply-settings',form=>form.elements.replyPercent.value='');const inherited=await request('private:777');assert.equal(inherited.replyPercent,null);assert.equal(inherited.effectiveReplyPercent,100);assert.equal(JSON.stringify(f.speech.settings(f.principal,'group:789').settings),voiceBefore);
 });
 await t.test('administrator private chat grants quota in context before separately enabling voice',async()=>{
  const x=await mount(chat('private:999','speech'),adminCookie);await waitFor(()=>x.d.querySelector('form[data-action="save-chat-speech-subsidy"]'));
  assert.ok(x.d.querySelector('form[data-action="save-speech-settings"]').elements.enabled.disabled);assert.doesNotMatch(x.d.getElementById('main').textContent,/请联系管理员为这个聊天开通/);assert.match(x.d.getElementById('main').textContent,/当前聊天语音授权与每日额度/);
  const modes=x.d.querySelectorAll('form[data-action="save-chat-speech-subsidy"] [name="allowedFundingModes"]:checked');assert.deepEqual([...modes].map(input=>input.value),['platform']);
  await save(x,'save-chat-speech-subsidy',form=>{form.elements.enabled.checked=true;form.elements.dailyLimitCny.value='.2';});const grant=f.speech.settings(admin,'private:999').subsidy;assert.equal(grant.enabled,true);assert.equal(grant.dailyLimitCny,.2);assert.deepEqual(grant.allowedFundingModes,['platform']);
  const settings=x.d.querySelector('form[data-action="save-speech-settings"]');assert.equal(settings.elements.enabled.disabled,false);assert.equal(settings.elements.enabled.checked,false);
  await save(x,'save-speech-settings',form=>{form.elements.enabled.checked=true;form.elements.autoVoicePercent.value='40';});assert.equal(f.speech.settings(admin,'private:999').settings.enabled,true);assert.equal(f.speech.settings(admin,'private:999').settings.autoVoicePercent,40);assert.equal(f.speech.settings(admin,'group:789').subsidy.enabled,false);
 });
 await t.test('ordinary users see the reply entry but cannot grant platform speech quota, and foreign scopes stay forbidden',async()=>{
  const x=await mount(chat('group:789','speech'));await waitFor(()=>x.d.querySelector('form[data-action="save-speech-settings"]'));assert.equal(x.d.querySelector('form[data-action="save-chat-speech-subsidy"]'),null);assert.ok(x.d.querySelector(`a[href="${chat('group:789','overview')}"]`));
  const speech=await fetch(f.origin+'/api/platform/speech/subsidy',{method:'PUT',headers:{cookie:f.cookie,origin:f.origin,'content-type':'application/json'},body:JSON.stringify({chatKey:'group:789',expectedVersion:0,enabled:true,dailyLimitCny:.1,allowedFundingModes:['platform']})});assert.equal(speech.status,403);
  const foreign=await fetch(f.origin+'/api/platform/reply-settings?chatKey=private%3A999',{headers:{cookie:f.cookie,origin:f.origin}});assert.equal(foreign.status,403);assert.ok(!f.calls.some(call=>/preview|TextToVoice|send_msg|completions/.test(call.path)));
 });
 assert.deepEqual(errors,[]);
});
