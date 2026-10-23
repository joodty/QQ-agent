import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

test('voice browser shares one accessible draft workflow for ordinary and administrator accounts',async t=>{
 const f=await createWorkspaceFixture();t.after(()=>f.close());
 const voices=[
  {voiceType:101001,name:'智瑜',gender:'female',category:'premium',scenario:'聊天',style:'情感女声',rateCnyPer10k:.3,sampleUrl:'https://example.com/fixture-yu.wav'},
  {voiceType:101030,name:'智宁',gender:'male',category:'premium',scenario:'阅读',style:'温暖男声',rateCnyPer10k:.3,sampleUrl:'https://example.com/fixture-ning.wav'},
  {voiceType:501000,name:'智斌',gender:'male',category:'large-model',scenario:'聊天',style:'自然男声',rateCnyPer10k:1.2,sampleUrl:null},
  {voiceType:402000,name:'云晓芙',gender:'female',category:'supernatural',scenario:'阅读',style:'轻柔女声',rateCnyPer10k:6.5,sampleUrl:null},
  ...Array.from({length:125},(_,index)=>({voiceType:700000+index,name:'示例音色'+index,gender:'unknown',category:'premium',scenario:'资讯',style:'目录夹具',rateCnyPer10k:.3,sampleUrl:null}))
 ];
 const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8'),errors=[];
 const preview={allowed:false,deferred:false,error:null,pending:[],requests:[]};
 const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));
 async function mount(cookie){
  const dom=new JSDOM(html,{url:f.origin+'/workspace.html#speech',runScripts:'outside-only',virtualConsole:console});t.after(()=>dom.window.close());
  const w=dom.window;w.matchMedia=()=>({matches:false});const media=[],revoked=[];let blobId=0;
  w.URL.createObjectURL=()=>`blob:fixture-${++blobId}`;w.URL.revokeObjectURL=url=>revoked.push(url);
  w.Audio=class extends w.EventTarget{constructor(){super();this.paused=0;this.loads=0;this.plays=0;media.push(this);}pause(){this.paused++;}load(){this.loads++;}removeAttribute(name){if(name==='src')this.src='';}async play(){this.plays++;}};
  w.fetch=async(route,options={})=>{if(route==='/api/platform/speech/preview'){preview.requests.push(JSON.parse(options.body));if(preview.deferred)await new Promise(resolve=>preview.pending.push(resolve));return new Response(JSON.stringify(preview.error?{error:preview.error}:{audioBase64:'UklGRg==',mime:'audio/wav',characters:20,estimatedCostCny:.013,rateCnyPer10k:6.5,estimated:true}),{status:preview.error?403:200,headers:{'content-type':'application/json'}});}const response=await fetch(f.origin+route,{...options,headers:{...options.headers,cookie,origin:f.origin}});if(['/api/platform/speech/overview','/api/platform/speech/platform','/api/platform/speech/settings'].includes(String(route).split('?')[0])&&(!options.method||options.method==='GET')){const body=await response.json();if(body.platform)body.platform.voices=voices;else if(body.voices)body.voices=voices;body.previewCharacters=20;if(body.platform)body.platform.previewCharacters=20;if(String(route).startsWith('/api/platform/speech/settings')&&preview.allowed){body.allowed=true;body.configured=true;body.enabled=true;body.settings.maxChars=120;}return new Response(JSON.stringify(body),{status:response.status,headers:{'content-type':'application/json'}});}return response;};
  w.eval(script);await waitFor(()=>w.document.querySelector('form[data-action="save-speech-settings"]'),5000,'speech page ready');return {w,media,revoked};
 }
 const {w,media,revoked}=await mount(f.cookie),d=w.document;
 const open=(window=w,action='save-speech-settings')=>window.document.querySelector(`form[data-action="${action}"] [data-action="choose-speech-voice"]`).click();
 const dialog=(window=w)=>window.document.querySelector('[role="dialog"]');
 const filter=(field,value,window=w)=>{const input=window.document.getElementById('voice-picker-'+field);input.value=value;input.dispatchEvent(new window.Event(field==='search'?'input':'change',{bubbles:true}));};
 const reset=(window=w)=>{for(const field of ['search','category','gender','scenario'])filter(field,'',window);};

 await t.test('opening uses bounded card rendering with search, three categories, gender and scene filters',()=>{
  assert.equal(media.length,0);assert.equal(d.querySelectorAll('[data-voice-select]').length,0);open();
  assert.equal(d.activeElement.id,'voice-picker-search');assert.equal(d.querySelectorAll('[data-voice-select]').length,60);
  assert.match(dialog().querySelector('[data-voice-count]').textContent,/129/);
  d.querySelector('[data-voice-more]').click();assert.equal(d.querySelectorAll('[data-voice-select]').length,120);
  filter('category','large-model');assert.equal(d.querySelectorAll('[data-voice-select]').length,1);assert.match(dialog().textContent,/1\.20/);
  filter('gender','female');assert.equal(d.querySelectorAll('[data-voice-select]').length,0);assert.match(dialog().textContent,/没有符合条件/);
  reset();filter('scenario','阅读');assert.equal(d.querySelectorAll('[data-voice-select]').length,2);
  filter('search','402000');assert.equal(d.querySelectorAll('[data-voice-select]').length,1);assert.match(dialog().textContent,/超自然音色/);assert.match(dialog().textContent,/6\.50/);
  assert.equal(dialog().querySelector('[data-voice-preview]'),null);assert.match(dialog().textContent,/腾讯云免费试听/);
  assert.equal(dialog().querySelector('[data-voice-synthesize]').disabled,true);
  assert.equal(dialog().querySelector('a').href,'https://aivoice.cloud.tencent.com/tts-experience');assert.equal(media.length,0);
 });
 await t.test('keyboard focus stays inside the browser and arrow keys choose a voice without saving',()=>{
  reset();filter('scenario','阅读');const first=d.querySelector('[data-voice-select="101030"]');first.focus();first.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  assert.equal(d.activeElement.dataset.voiceSelect,'402000');assert.equal(d.activeElement.getAttribute('aria-checked'),'true');assert.equal(d.getElementById('speech-chat-voiceType').value,'');
  const firstFocusable=dialog().querySelector('[data-voice-close]'),last=dialog().querySelector('[data-voice-confirm]');last.focus();last.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(d.activeElement,firstFocusable);
  firstFocusable.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(d.activeElement,last);
  filter('search','402000');
 });
 await t.test('card selection is a cancellable draft, keyboard Escape restores focus and sends no writes',()=>{
  d.querySelector('[data-voice-select="402000"]').click();assert.equal(d.querySelector('[data-voice-select="402000"]').getAttribute('aria-checked'),'true');
  assert.equal(d.getElementById('speech-chat-voiceType').value,'');
  dialog().dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(dialog(),null);
  assert.equal(d.activeElement.dataset.action,'choose-speech-voice');assert.equal(d.querySelector('.workspace').hasAttribute('inert'),false);
  assert.ok(f.calls.every(call=>call.method==='GET'));
  open();assert.equal(d.getElementById('voice-picker-search').value,'402000');assert.equal(d.querySelector('[data-voice-select="402000"]').getAttribute('aria-checked'),'false');
  reset();filter('search','智瑜');d.querySelector('[data-voice-select="101001"]').click();d.querySelector('[data-voice-confirm]').click();
  assert.equal(d.getElementById('speech-chat-voiceType').value,'101001');assert.equal(f.speech.settings(f.principal,'group:789').settings.overrides.voiceType,null);
  assert.match(d.querySelector('[data-voice-summary]').textContent,/精品音色/);assert.match(d.querySelector('[data-voice-summary]').textContent,/0\.30/);
 });
 await t.test('official sample audio loads only on click and switching, closing, errors stop the previous sample',async()=>{
  open();reset();filter('category','premium');filter('gender','female');assert.equal(media.length,0);
  d.querySelector('[data-voice-preview="101001"]').click();await waitFor(()=>media[0]?.plays===1);assert.equal(media[0].preload,'none');assert.equal(media[0].src,'https://example.com/fixture-yu.wav');
  filter('gender','male');d.querySelector('[data-voice-preview="101030"]').click();await waitFor(()=>media[1]?.plays===1);assert.equal(media[0].paused,1);assert.equal(media[0].src,'');
  media[1].dispatchEvent(new w.Event('error'));assert.match(dialog().querySelector('[data-voice-sample-status]').textContent,/暂时无法播放/);assert.equal(media[1].src,'');
  d.querySelector('[data-voice-preview="101030"]').click();await waitFor(()=>media[2]?.plays===1);d.querySelector('[data-voice-close]').click();assert.equal(media[2].paused,1);assert.equal(media[2].src,'');
  assert.ok(f.calls.every(call=>call.method==='GET'));assert.ok(!f.calls.some(call=>/synthesize|TextToVoice|completions/.test(call.path)));
 });
 await t.test('only the settings save persists the chosen voice and inheritance keeps private chat separate',async()=>{
  const form=d.querySelector('form[data-action="save-speech-settings"]');form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>f.speech.settings(f.principal,'group:789').settings.voiceType===101001);
  await waitFor(()=>d.querySelector('form[data-action="save-speech-settings"] [data-action="choose-speech-voice"]')&&!d.querySelector('form[data-action="save-speech-settings"] [data-action="choose-speech-voice"]').disabled);
  open();d.querySelector('[data-voice-inherit]').click();d.querySelector('[data-voice-confirm]').click();assert.equal(d.getElementById('speech-chat-voiceType').value,'');
  assert.match(d.querySelector('[data-voice-summary]').textContent,/沿用平台/);assert.equal(f.speech.settings(f.principal,'group:789').settings.voiceType,101001);
  const selector=d.getElementById('chat-selector');selector.value='private:777';selector.dispatchEvent(new w.Event('change',{bubbles:true}));
  await waitFor(()=>d.getElementById('chat-selector')?.value==='private:777'&&d.getElementById('speech-chat-voiceType')?.value==='');
  assert.equal(f.speech.settings(f.principal,'private:777').settings.overrides.voiceType,null);
 });
 await t.test('paid preview states selected-chat cost before its explicit click and never changes settings or sends QQ',async()=>{
  preview.allowed=true;d.querySelector('[data-action="refresh"]').click();await waitFor(()=>!d.querySelector('[data-action="refresh"]').disabled);
  open();reset();filter('category','supernatural');assert.match(dialog().textContent,/占用.*本人私聊/);assert.match(dialog().textContent,/20 字符/);assert.match(dialog().textContent,/至少间隔 60 秒/);
  const button=d.querySelector('[data-voice-synthesize="402000"]');assert.match(button.textContent,/0\.013/);assert.equal(button.disabled,false);
  const before=JSON.stringify(f.speech.settings(f.principal,'private:777'));preview.deferred=true;button.click();assert.equal(preview.requests.length,1);assert.ok(d.querySelector('[data-voice-synthesize]').disabled);
  assert.equal(preview.requests[0].chatKey,'private:777');assert.equal(preview.requests[0].voiceType,402000);assert.equal(typeof preview.requests[0].expectedPolicyVersion,'string');
  preview.pending.shift()();await waitFor(()=>media.at(-1)?.src?.startsWith('blob:fixture-'));
  assert.match(dialog().querySelector('[data-voice-sample-status]').textContent,/0\.013/);assert.equal(media.at(-1).plays,1);
  d.querySelector('[data-voice-close]').click();assert.deepEqual(revoked,['blob:fixture-1']);assert.equal(media.at(-1).src,'');assert.equal(JSON.stringify(f.speech.settings(f.principal,'private:777')),before);
 });
 await t.test('closing or changing selected voice discards late preview playback and visible errors retain their reason',async()=>{
  const before=media.length;open();reset();filter('category','supernatural');d.querySelector('[data-voice-synthesize="402000"]').click();
  d.querySelector('[data-voice-close]').click();preview.pending.shift()();await waitFor(()=>!d.querySelector('form[data-action="save-speech-settings"] [data-action="choose-speech-voice"]').disabled);open();await waitFor(()=>!d.querySelector('[data-voice-synthesize]').disabled);assert.equal(media.length,before);
  reset();filter('category','supernatural');d.querySelector('[data-voice-synthesize="402000"]').click();reset();filter('search','101001');d.querySelector('[data-voice-select="101001"]').click();preview.pending.shift()();
  reset();filter('category','supernatural');await waitFor(()=>!d.querySelector('[data-voice-synthesize]').disabled);assert.equal(media.length,before);
  preview.deferred=false;preview.error='当前聊天的语音额度不足';d.querySelector('[data-voice-synthesize="402000"]').click();await waitFor(()=>dialog().querySelector('[data-voice-sample-status]').textContent.includes('额度不足'));assert.equal(media.length,before);preview.error=null;
  d.querySelector('[data-voice-close]').click();assert.ok(!f.calls.some(call=>/TextToVoice|completions|send_msg/.test(call.path)));
 });
 const adminCookie=f.auth.cookie((await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'})).token).split(';')[0],admin=await mount(adminCookie);
 await t.test('administrator shares the same picker while platform and chat drafts stay independent',()=>{
  open(admin.w,'save-speech-platform');reset(admin.w);filter('category','supernatural',admin.w);admin.w.document.querySelector('[data-voice-select="402000"]').click();
  assert.equal(dialog(admin.w).querySelector('[data-voice-inherit]'),null);admin.w.document.querySelector('[data-voice-confirm]').click();
  assert.equal(admin.w.document.getElementById('speech-platform-voiceType').value,'402000');assert.equal(admin.w.document.getElementById('speech-chat-voiceType').value,'101001');
  assert.match(admin.w.document.querySelector('form[data-action="save-speech-platform"] [data-voice-summary]').textContent,/6\.50/);
  assert.equal(f.speech.platformOverview(f.auth.authenticate(adminCookie)).voiceType,101001);assert.deepEqual(errors,[]);
 });
});
