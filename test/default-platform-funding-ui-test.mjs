import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

test('default subsidy is visible without setup and only administrators control its platform rule',async t=>{
 const f=await createWorkspaceFixture();t.after(()=>f.close());
 const login=await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'}),cookie=f.auth.cookie(login.token).split(';')[0],admin=f.auth.authenticate(cookie);
 f.business.updateBudget(admin,{version:f.business.budgets(admin).version,defaultPlatformFunding:true,defaultDailyLimitCny:.1});
 const windows=[],errors=[];t.after(()=>windows.forEach(w=>w.close()));
 async function mount(hash,session){
  const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),{url:f.origin+'/workspace.html#'+hash,runScripts:'outside-only',virtualConsole:console}),w=dom.window;windows.push(w);
  w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});w.fetch=(route,options={})=>fetch(f.origin+route,{...options,headers:{...options.headers,cookie:session,origin:f.origin}});w.eval(fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8'));return {w,d:w.document};
 }
 await t.test('ordinary bound private chat immediately shows automatic platform payment and 0.1 quota, with no required funding save',async()=>{
  const x=await mount('chat/private%3A777/costs',f.cookie);await waitFor(()=>x.d.querySelector('form[data-action="save-funding"]'));
  const text=x.d.getElementById('chat-funding-settings').textContent;assert.match(text,/已自动使用平台额度/);assert.match(text,/0\.10/);assert.match(text,/无需再次配置/);assert.doesNotMatch(text,/请选择费用来源并另行保存/);
  assert.equal(x.d.getElementById('funding-mode').value,'platform');assert.equal(x.d.getElementById('chat-limit').value,'0.1');assert.equal(x.d.getElementById('chat-limit').form.querySelector('button[type="submit"]').disabled,true);
  assert.ok(!f.calls.some(row=>row.method!=='GET'&&row.path.includes('/funding')));
 });
 await t.test('administrator can change the default rule while an explicit pause remains paused',async()=>{
  f.business.setFunding(admin,{chatKey:'private:999',mode:'disabled'});
  const x=await mount('admin/budgets',cookie);await waitFor(()=>x.d.querySelector('[name="defaultPlatformFunding"]'));
  const toggle=x.d.querySelector('[name="defaultPlatformFunding"]');assert.equal(toggle.checked,true);assert.equal(x.d.getElementById('default-budget').value,'0.1');
  toggle.checked=false;toggle.form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>x.d.getElementById('feedback').textContent.includes('平台默认规则已保存'));
  assert.equal(f.business.budgets(admin).defaultPlatformFunding,false);assert.equal(f.business.runtimeAllowed('private:777'),false);
  const restored=x.d.querySelector('[name="defaultPlatformFunding"]');restored.checked=true;restored.form.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>f.business.budgets(admin).defaultPlatformFunding===true);
  assert.equal(f.business.runtimeAllowed('private:777'),true);assert.equal(f.business.runtimeAllowed('private:999'),false);
 });
 assert.deepEqual(errors,[]);
});
