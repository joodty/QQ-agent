// DOM interaction tests only. No real account, model call, QQ or payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {waitFor} from './_harness.mjs';
const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8');
const endpoint='https://api.commandcode.ai/alpha',deepseek='deepseek/deepseek-v4.1-flash',glm='z-ai/glm-5.3-flash';
const providers=[{endpoint,model:deepseek,thinkingEffortOptions:['','low','high','max']},{endpoint,model:glm,thinkingEffortOptions:['','low','high','max']},{endpoint:'https://approved.example.test/v1',model:'fixture-other-model',thinkingEffortOptions:['']}];
async function mount(t,{role='admin',legacy=false,failSave=false}={}){
  const errors=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));const dom=new JSDOM(html,{url:'https://example.test/workspace.html#admin/models',runScripts:'outside-only',virtualConsole:console});t.after(()=>dom.window.close());const w=dom.window,d=w.document,calls=[];
  let model={version:'fixture-version-1',endpoint,model:deepseek,hasKey:true,providers:structuredClone(providers),thinkingEffort:'',thinkingEffortOptions:['','low','high','max']};if(legacy){delete model.thinkingEffort;delete model.thinkingEffortOptions;model.providers.forEach(p=>delete p.thinkingEffortOptions);}
  w.matchMedia=()=>({matches:false});w.fetch=async(route,options={})=>{
    const path=new URL(route,w.location.origin).pathname,body=options.body?JSON.parse(options.body):undefined;calls.push({path,body,options});let data,status=200;
    if(path==='/api/auth/status')data={authenticated:true,user:{id:'fixture-account',username:'fixture_user',role}};
    else if(path==='/api/platform/overview')data={accountId:'fixture-account',role,scopes:[],providers:[]};
    else if(path==='/api/platform/model-service'){
      if(options.method==='PUT'){if(failSave){status=409;data={error:'模型服务已变化，请刷新后重新保存'};}else{model={...model,...body,version:'fixture-version-2'};data=model;}}
      else data=model;
    }else throw Error('Unexpected fixture request '+route);
    return {ok:status===200,status,json:async()=>structuredClone(data)};
  };w.eval(script);await waitFor(()=>role==='admin'?d.querySelector('[data-action="save-platform-model"]'):w.location.hash==='#workbench',5000,'model settings page');return {w,d,calls,errors};
}
function change(x,id,value){const control=x.d.getElementById(id);control.value=value;control.dispatchEvent(new x.w.Event('change',{bubbles:true}));return control;}

test('Go model switching sends selected model and thinking effort with saved same-endpoint key retained',async t=>{
  const x=await mount(t),{d,w,calls}=x;const form=d.querySelector('[data-action="save-platform-model"]');assert.match(d.querySelector('#platform-model-provider').textContent,/Command Code Go.*deepseek\/deepseek-v4\.1-flash/);assert.match(d.querySelector('#platform-model-provider').textContent,/z-ai\/glm-5\.3-flash/);assert.deepEqual([...form.elements.thinkingEffort.options].map(o=>o.value),['','low','high','max']);assert.equal(form.elements.thinkingEffort.options[0].textContent,'模型默认');
  change(x,'platform-model-provider','1');change(x,'platform-thinking-effort','max');assert.equal(form.elements.apiKey.required,false);assert.equal(form.elements.apiKey.value,'');
  form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>d.querySelector('[data-action="save-platform-model"]')!==form,5000,'model save/reload');const saved=calls.find(c=>c.options.method==='PUT');assert.deepEqual(saved.body,{expectedVersion:'fixture-version-1',endpoint,model:glm,thinkingEffort:'max'});assert.equal(d.querySelector('#platform-thinking-effort').value,'max');assert.equal(d.querySelector('#platform-model-provider').value,'1');assert.equal(d.querySelector('#platform-model-key').value,'');assert.ok(calls.every(c=>c.options.credentials==='same-origin'));assert.ok(!calls.some(c=>/generate|completions|send_msg|preview/.test(c.path)));assert.deepEqual(x.errors,[]);
});

test('provider changes follow backend effort options, require a new endpoint key, and expose context guidance',async t=>{
  const x=await mount(t),form=x.d.querySelector('[data-action="save-platform-model"]');change(x,'platform-thinking-effort','high');change(x,'platform-model-provider','2');assert.deepEqual([...form.elements.thinkingEffort.options].map(o=>o.value),['']);assert.equal(form.elements.thinkingEffort.value,'');assert.equal(form.elements.apiKey.required,true);change(x,'platform-model-provider','0');assert.equal(form.elements.apiKey.required,false);assert.equal(form.elements.thinkingEffort.options.length,4);
  assert.equal(x.d.querySelector('main a[href="/my-bots.html"]').textContent,'前往我的机器人调整上下文');assert.match(x.d.querySelector('main').textContent,/0～500 条/);assert.match(x.d.querySelector('main').textContent,/历史消息条数不等于模型的 token 窗口/);assert.match(x.d.querySelector('main').textContent,/上下文增大可能增加费用/);
});

test('legacy projections show only model default and failed saves preserve the current draft',async t=>{
  const legacy=await mount(t,{legacy:true});assert.deepEqual([...legacy.d.querySelector('#platform-thinking-effort').options].map(o=>o.value),['']);
  const x=await mount(t,{failSave:true}),form=x.d.querySelector('[data-action="save-platform-model"]');change(x,'platform-model-provider','1');change(x,'platform-thinking-effort','low');form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>x.d.querySelector('#feedback').textContent.includes('已变化'),5000,'CAS conflict');assert.ok(form.isConnected);assert.equal(form.elements.thinkingEffort.value,'low');assert.equal(form.elements.provider.value,'1');assert.equal(x.calls.filter(c=>c.options.method==='PUT').length,1);
});

test('ordinary account cannot render or fetch platform model administration',async t=>{
  const x=await mount(t,{role:'user'});assert.equal(x.d.querySelector('[data-action="save-platform-model"]'),null);assert.equal(x.d.querySelector('#platform-thinking-effort'),null);assert.ok(!x.calls.some(c=>c.path==='/api/platform/model-service'));assert.deepEqual(x.errors,[]);
});
