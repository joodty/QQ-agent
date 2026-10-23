import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

test('speech workspace uses real account/settings HTTP, explicit platform quota and no synthesis on page load',async t=>{
 let configured=false;
 const credential={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixture-speech-identity',secretKey:'fixture-speech-secret-value'};
 const f=await createWorkspaceFixture({speechCredentials:()=>configured?credential:null});t.after(()=>f.close());
 const errors=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));
 const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8');
 async function mount(cookie,hash='speech'){
  const dom=new JSDOM(html,{url:f.origin+'/workspace.html#'+hash,runScripts:'outside-only',virtualConsole:console});t.after(()=>dom.window.close());
  const w=dom.window;w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});w.fetch=(route,options={})=>fetch(f.origin+route,{...options,headers:{...options.headers,cookie,origin:f.origin}});w.eval(script);
  await waitFor(()=>w.document.querySelector(`form[data-action="${hash==='admin/speech'?'save-speech-platform':'save-speech-settings'}"]`),5000,'voice page hydrated');return w;
 }
 const user=await mount(f.cookie);
 const chooseVoice=(window,voiceType)=>{const form=window.document.querySelector('form[data-action="save-speech-settings"]');form.querySelector('[data-action="choose-speech-voice"]').click();const search=window.document.getElementById('voice-picker-search');search.value=String(voiceType);search.dispatchEvent(new window.Event('input',{bubbles:true}));window.document.querySelector(`[data-voice-select="${voiceType}"]`).click();window.document.querySelector('[data-voice-confirm]').click();};
 await t.test('ordinary missing-key state gives an honest next step and no credential inputs',()=>{
  assert.equal(user.document.getElementById('page-title').textContent,'语音设置');
  assert.ok(user.document.querySelector('form[data-action="save-speech-settings"] [name="enabled"]').disabled);
  assert.match(user.document.getElementById('main').textContent,/尚未配置腾讯云语音凭据/);
  assert.equal(user.document.querySelector('form[data-action="save-speech-platform"]'),null);
  assert.equal(user.document.querySelector('form[data-action="save-speech-subsidy"]'),null);
  assert.equal(user.document.querySelector('[name="secretKey"],[name="secretId"]'),null);
  assert.equal(user.document.querySelectorAll('#speech-chat-voiceType option').length,1);
  assert.match(user.document.querySelector('[data-voice-summary]').textContent,/智瑜.*女声/);
  assert.ok(user.document.querySelector('[data-action="choose-speech-voice"]'));
  assert.doesNotMatch(user.document.getElementById('main').textContent,/SPEECH_|fixture-speech-secret/);
 });
 await t.test('missing-Key users may save voice preferences while enable remains off',async()=>{
  chooseVoice(user,101030);const form=user.document.querySelector('form[data-action="save-speech-settings"]');form.elements.speed.value='0.5';form.elements.volume.value='3';form.elements.autoVoicePercent.value='10';
  form.dispatchEvent(new user.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>f.speech.settings(f.principal,'group:789').settings.version===1);
  const row=f.speech.settings(f.principal,'group:789');assert.equal(row.settings.enabled,false);assert.equal(row.settings.voiceType,101030);assert.equal(row.settings.autoVoicePercent,10);
 });
 const adminCookie=f.auth.cookie((await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'})).token).split(';')[0],admin=await mount(adminCookie,'admin/speech');
 const submit=(window,action)=>window.document.querySelector(`form[data-action="${action}"]`).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
 await t.test('administrator cannot enable without credentials and saves only explicit platform and resource limits',async()=>{
  let form=admin.document.querySelector('form[data-action="save-speech-platform"]');assert.ok(form.elements.enabled.disabled);
  configured=true;admin.document.querySelector('[data-action="refresh"]').click();await waitFor(()=>!admin.document.querySelector('form[data-action="save-speech-platform"]').elements.enabled.disabled);
  form=admin.document.querySelector('form[data-action="save-speech-platform"]');form.elements.enabled.checked=true;form.elements.maxChars.value='100';form.elements.cooldownSec.value='1';form.elements.dailyLimitCny.value='.5';submit(admin,'save-speech-platform');
  await waitFor(()=>f.speech.platformOverview(f.auth.authenticate(adminCookie)).enabled,5000,'platform setting persisted');
  await waitFor(()=>!admin.document.querySelector('form[data-action="save-speech-platform"] button').disabled);
  admin.location.hash='admin/subsidies';await waitFor(()=>admin.document.getElementById('subsidy-chat-selector'),5000,'dedicated subsidy page');
  const target=admin.document.getElementById('subsidy-chat-selector');target.value='group:789';target.dispatchEvent(new admin.Event('change',{bubbles:true}));await waitFor(()=>admin.document.querySelector('form[data-action="save-speech-subsidy"]'));
  form=admin.document.querySelector('form[data-action="save-speech-subsidy"]');form.elements.enabled.checked=true;form.elements.dailyLimitCny.value='.1';form.querySelector('[value="platform"]').checked=true;submit(admin,'save-speech-subsidy');
  await waitFor(()=>f.speech.settings(f.principal,'group:789').subsidy.enabled,5000,'resource quota persisted');
  assert.deepEqual(f.speech.settings(f.principal,'group:789').subsidy.allowedFundingModes,['platform']);
 });
 await t.test('ordinary user saves stricter per-chat settings and private chat stays separate',async()=>{
  user.document.querySelector('[data-action="refresh"]').click();await waitFor(()=>!user.document.querySelector('form[data-action="save-speech-settings"]').elements.enabled.disabled);
  chooseVoice(user,101030);const form=user.document.querySelector('form[data-action="save-speech-settings"]');form.elements.enabled.checked=true;form.elements.maxChars.value='40';form.elements.cooldownSec.value='2';form.elements.speed.value='0.5';form.elements.volume.value='3';form.elements.autoVoicePercent.value='10';submit(user,'save-speech-settings');
  await waitFor(()=>f.speech.settings(f.principal,'group:789').settings.enabled,5000,'user voice setting persisted');
  assert.equal(f.speech.settings(f.principal,'group:789').settings.maxChars,40);assert.equal(f.speech.settings(f.principal,'group:789').settings.cooldownMs,2000);
  assert.equal(f.speech.settings(f.principal,'group:789').settings.voiceType,101030);assert.equal(f.speech.settings(f.principal,'group:789').settings.speed,.5);assert.equal(f.speech.settings(f.principal,'group:789').settings.volume,3);
  assert.equal(f.speech.settings(f.principal,'group:789').settings.autoVoicePercent,10);
  assert.equal(f.speech.settings(f.principal,'private:777').settings.enabled,false);
  const request=(route,body)=>fetch(f.origin+route,{method:'PUT',headers:{cookie:f.cookie,origin:f.origin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await request('/api/platform/speech/platform',{expectedVersion:2,enabled:true})).status,403);
  assert.equal((await request('/api/platform/speech/subsidy',{chatKey:'group:789',enabled:true})).status,403);
  assert.equal((await request('/api/platform/speech/settings',{chatKey:'private:789',expectedVersion:0,enabled:true})).status,403);
  const current=f.speech.settings(f.principal,'group:789').settings;
  for(const invalid of [{voiceType:999999},{speed:3},{volume:-6},{autoVoicePercent:101},{autoVoicePercent:9.5}])assert.equal((await request('/api/platform/speech/settings',{chatKey:'group:789',expectedVersion:current.version,enabled:true,...invalid})).status,400);
 });
 await t.test('billing explanation distinguishes estimated standard price from free-package balance',()=>{
  assert.match(user.document.getElementById('main').textContent,/免费资源包.*抵扣.*未同步/);
  assert.match(user.document.getElementById('main').textContent,/不表示.*余额扣款/);
  assert.ok(!f.calls.some(call=>/synthesize|test-chat|TextToVoice|completions/.test(call.path)));
  assert.deepEqual(errors,[]);
 });
 await t.test('valid custom style values survive page refresh and unrelated settings saves',async()=>{
  const before=f.speech.settings(f.principal,'group:789').settings;
  f.speech.updateSettings(f.principal,{chatKey:'group:789',expectedVersion:before.version,enabled:true,speed:.25,volume:2});
  user.document.querySelector('[data-action="refresh"]').click();
  await waitFor(()=>user.document.getElementById('speech-chat-speed')?.value==='0.25');
  assert.equal(user.document.getElementById('speech-chat-volume').value,'2');
  const savingForm=user.document.querySelector('form[data-action="save-speech-settings"]');
  submit(user,'save-speech-settings');
  await waitFor(()=>f.speech.settings(f.principal,'group:789').settings.version===before.version+2);
  await waitFor(()=>!savingForm.isConnected&&user.document.getElementById('feedback')?.textContent.includes('语音设置已保存'),5000,'browser save and reload completed before teardown');
  assert.equal(f.speech.settings(f.principal,'group:789').settings.speed,.25);
  assert.equal(f.speech.settings(f.principal,'group:789').settings.volume,2);
 });
});
