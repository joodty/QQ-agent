import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html=fs.readFileSync(new URL('../ui/my-bots.html',import.meta.url),'utf8');
const script=fs.readFileSync(new URL('../ui/my-bots.js',import.meta.url),'utf8');
const defaults={enabled:true,mentionOnly:false,replyPercent:10,privateReplies:true,groupReplies:true,groupIds:[],privateIds:[],personaText:'A friendly assistant',contextMessages:30,voiceEnabled:false,autoVoicePercent:0,voiceType:101001,speed:0,volume:0};
const request={id:'fixture-request',botId:'hosted-fixture-request',name:'My helper',expectedQQ:'123456',status:'ready',version:1};
async function waitFor(predicate){for(let n=0;n<100;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('UI condition timed out');}
async function mount(t,{admin=false,requests=[request],primaryBot=null,enabled=true,available=1,hook}={}){
  const dom=new JSDOM(html,{url:'https://example.test/my-bots.html',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,d=w.document,calls=[];
  w.matchMedia=()=>({matches:false});w.confirm=()=>true;
  const projection={botId:request.botId,version:1,defaultsVersion:1,platformDefaults:defaults,overrides:{},effective:{...defaults},application:{status:'applied'}};
  w.fetch=async(path,options={})=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({path,options,body});let data;
    if(hook){const result=await hook(path,body,options);if(result)return {ok:result.status<400,status:result.status,json:async()=>result.data};}
    if(path==='/api/auth/status')data={authenticated:true,user:{id:'fixture-owner',username:'fixture_user',role:admin?'admin':'user'}};
    else if(path==='/api/platform/hosted-bots')data=body?{request}:{requests,primaryBot,enabled,capacity:{max:2,used:1,available}};
    else if(path.startsWith('/api/platform/bot-preferences'))data=body?{...projection,version:2,overrides:body.overrides,effective:Object.fromEntries(Object.keys(defaults).map(k=>[k,body.overrides[k]??defaults[k]])),application:{status:'not_connected'}}:projection;
    else if(path==='/api/platform/bot-defaults')data={version:1,defaults,application:{status:'pending'}};
    else if(path.includes('/api/platform/hosted-bots/'))data={request:{...request,status:'waiting_scan',version:2},login:{state:'waiting_scan',qrImage:'data:image/png;base64,aGVsbG8=',expiresAt:Date.now()+60000}};
    else throw Error('Unexpected request '+path);
    return {ok:true,status:200,json:async()=>({ok:true,...data})};
  };
  w.eval(script);await waitFor(()=>!d.querySelector('#reload').disabled&&calls.some(c=>c.path==='/api/platform/hosted-bots'));return {w,d,calls};
}
function change(x,selector,value,event='change'){const el=x.d.querySelector(selector);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new x.w.Event(event,{bubbles:true}));return el;}

test('ordinary account sees own preferences, nullable inheritance and independent reply/voice percentages',async t=>{
  const x=await mount(t),{d,w,calls}=x;assert.equal(d.querySelector('[data-tab="defaults"]'),null);assert.ok(!calls.some(c=>c.path==='/api/platform/bot-defaults'));assert.equal(d.querySelector('#pref-replyPercent').disabled,true);assert.equal(d.querySelector('.preference-advanced').open,false);assert.ok(d.querySelector('.preference-advanced #pref-voiceType'));assert.ok(!d.querySelector('#pref-replyPercent').closest('details'));
  change(x,'[data-inherit="replyPercent"]',false);change(x,'#pref-replyPercent','37','input');assert.equal(d.querySelector('#pref-replyPercent-output').textContent,'37%');assert.equal(d.querySelector('#pref-replyPercent').getAttribute('aria-valuetext'),'37%');
  change(x,'[data-inherit="groupIds"]',false);change(x,'#pref-groupIds','123456\n234567','input');
  d.querySelector('[data-preferences="bot"]').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>calls.some(c=>c.options.method==='PUT'));
  const save=calls.find(c=>c.options.method==='PUT');assert.equal(save.body.botId,request.botId);assert.equal(save.body.expectedVersion,1);assert.equal(save.body.overrides.replyPercent,37);assert.equal(save.body.overrides.autoVoicePercent,null);assert.deepEqual(save.body.overrides.groupIds,['123456','234567']);
  await waitFor(()=>d.querySelector('#feedback').textContent.includes('尚未连接'));assert.equal(d.querySelector('#pref-replyPercent').value,'37');
  d.querySelector('[data-reset-preferences]').click();assert.equal(d.querySelector('#pref-replyPercent').disabled,true);assert.equal(d.querySelector('#pref-replyPercent').value,'10');assert.match(d.querySelector('[data-application]').textContent,/请保存后生效/);
  assert.ok(calls.every(c=>c.options.credentials==='same-origin'));assert.ok(!calls.some(c=>/send|preview|completions/.test(c.path)));
});

test('mention-only disables probability and admin defaults remain an additional authenticated tab',async t=>{
  const x=await mount(t,{admin:true});change(x,'[data-inherit="replyPercent"]',false);change(x,'[data-inherit="mentionOnly"]',false);change(x,'#pref-mentionOnly','true','input');assert.equal(x.d.querySelector('#pref-replyPercent').disabled,true);assert.match(x.d.querySelector('#pref-replyPercent-note').textContent,/不参与判断/);
  x.d.querySelector('[data-tab="defaults"]').click();await waitFor(()=>x.d.querySelector('[data-preferences="defaults"]'));assert.equal(x.d.querySelector('#mine-panel').hidden,true);assert.equal(x.d.querySelector('#defaults-panel [data-inherit]'),null);assert.equal(x.d.querySelector('#default-groupIds').value,'');
});

test('hosted start shows only broker QR, correct account and expiry; no foreign image fetch',async t=>{
  const x=await mount(t,{requests:[{...request,status:'pending'}]});x.d.querySelector('[data-operation="start"]').click();await waitFor(()=>x.d.querySelector('.qr-image'));assert.equal(x.d.querySelector('.qr-image').src,'data:image/png;base64,aGVsbG8=');assert.match(x.d.querySelector('#login-content').textContent,/123456/);assert.match(x.d.querySelector('#login-content').textContent,/到期时间/);assert.deepEqual(x.calls.find(c=>c.path.endsWith('/start')).body,{version:1});
});

test('capacity, unavailable service and failures never claim successful login',async t=>{
  const disabled=await mount(t,{enabled:false,requests:[]});assert.equal(disabled.d.querySelector('#request-form button').disabled,true);assert.match(disabled.d.querySelector('#capacity').textContent,/暂未开启/);
  const full=await mount(t,{available:0});assert.equal(full.d.querySelector('#request-form button').disabled,true);assert.match(full.d.querySelector('#capacity').textContent,/容量已满/);
  const failed=await mount(t,{requests:[{...request,status:'pending'}],hook:path=>path.endsWith('/start')?{status:429,data:{error:'资源不足，请稍后重试'}}:null});failed.d.querySelector('[data-operation="start"]').click();await waitFor(()=>failed.d.querySelector('#feedback').classList.contains('error'));assert.match(failed.d.querySelector('#feedback').textContent,/资源不足/);assert.equal(failed.d.querySelector('.qr-image'),null);assert.equal(failed.d.querySelector('#login-panel').hidden,true);
});

test('request creation uses own expected QQ, and unsafe or expired QR is never rendered',async t=>{
  const x=await mount(t,{requests:[{...request,status:'pending'}],hook:path=>path.endsWith('/start')?{status:200,data:{ok:true,request:{...request,status:'expired',version:2},login:{state:'waiting_scan',qrImage:'https://foreign.test/qr.png',expiresAt:Date.now()-1000}}}:null});
  x.d.querySelector('#bot-name').value='My own helper';x.d.querySelector('#expected-qq').value='345678';x.d.querySelector('#request-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>x.d.querySelector('#feedback').textContent.includes('申请已创建'));assert.deepEqual(x.calls.find(c=>c.path==='/api/platform/hosted-bots'&&c.body).body,{name:'My own helper',expectedQQ:'345678'});
  x.d.querySelector('[data-operation="start"]').click();await waitFor(()=>!x.d.querySelector('#login-panel').hidden);assert.equal(x.d.querySelector('.qr-image'),null);assert.match(x.d.querySelector('#login-content').textContent,/已过期/);assert.ok(x.d.querySelector('[data-operation="refresh"]'));
});

test('save conflict keeps draft and saved-but-failed application is explicitly reported',async t=>{
  const x=await mount(t,{hook:(path,body,options)=>options.method==='PUT'?{status:409,data:{error:'偏好版本已变化，请刷新'}}:null});change(x,'[data-inherit="replyPercent"]',false);change(x,'#pref-replyPercent','46','input');const form=x.d.querySelector('[data-preferences="bot"]');form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>x.d.querySelector('#feedback').classList.contains('error'));assert.match(x.d.querySelector('#feedback').textContent,/版本已变化/);assert.equal(x.d.querySelector('#pref-replyPercent').value,'46');assert.ok(form.isConnected);
  const failed=await mount(t,{hook:(path,body,options)=>options.method==='PUT'?{status:200,data:{botId:request.botId,version:2,platformDefaults:defaults,effective:defaults,overrides:{},application:{status:'failed'}}}:null});failed.d.querySelector('[data-preferences="bot"]').dispatchEvent(new failed.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>failed.d.querySelector('#feedback').classList.contains('error'));assert.match(failed.d.querySelector('#feedback').textContent,/已保存，但应用失败/);assert.match(failed.d.querySelector('[data-application]').textContent,/应用失败/);
});

test('administrator can save existing primary preferences without broker actions while friends retain their own bot list',async t=>{
  const primary={id:'primary',botId:'primary',expectedQQ:'456789',name:'我的 QQ（现有实例）',status:'ready',version:0,primary:true};
  const x=await mount(t,{admin:true,primaryBot:primary});assert.equal(x.d.querySelector('#bot-select').value,'primary');assert.match(x.d.querySelector('#requests').textContent,/我的 QQ（现有实例）/);assert.equal(x.d.querySelector('[data-request="primary"]'),null);assert.ok(x.d.querySelector(`[data-request="${request.id}"]`));
  x.d.querySelector('[data-preferences="bot"]').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>x.calls.some(c=>c.options.method==='PUT'));assert.equal(x.calls.find(c=>c.options.method==='PUT').body.botId,'primary');assert.ok(!x.calls.some(c=>c.path.includes('/hosted-bots/primary/')));
  const friend=await mount(t);assert.equal(friend.d.querySelector('option[value="primary"]'),null);assert.equal(friend.d.querySelector('#bot-select').value,request.botId);assert.ok(friend.d.querySelector(`[data-request="${request.id}"]`));
});
