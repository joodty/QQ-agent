import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';

test('default platform subsidy uses the shared engine with exact authority and persistent daily budgets',async t=>{
 const f=await createWorkspaceFixture();t.after(()=>f.close());
 const {getConfig,updateConfig}=await import('../src/config.js'),paid=await import('../src/paid-call-guard.js'),{chatCompletion}=await import('../src/llm.js');
 const adminLogin=await f.auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'}),adminCookie=f.auth.cookie(adminLogin.token).split(';')[0],admin=f.auth.authenticate(adminCookie);
 const request=async(method,route,body,cookie=adminCookie)=>{const response=await fetch(f.origin+route,{method,headers:{cookie,origin:f.origin,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};
 const save=async(fields,cookie=adminCookie)=>{const current=await request('GET','/api/platform/budgets');return request('PUT','/api/platform/budgets',{version:current.body.version,...fields},cookie);};
 updateConfig({allow:{groups:['789','777'],private:['999']},productionBudget:{funding:{__replace__:{}}}});
 const calls=[],responses=[],model=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({authorization:req.headers.authorization,body:JSON.parse(raw)});const next=responses.shift()||{status:200};res.writeHead(next.status,{'content-type':'application/json'});res.end(JSON.stringify(next.status===200?{model:'deepseek-flash',choices:[{message:{role:'assistant',content:'Fixture reply'},finish_reason:'stop'}],usage:{prompt_tokens:16,completion_tokens:1,total_tokens:17}}:{error:{message:'fixture rejected personal key'}}));});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));const nativeFetch=globalThis.fetch;
 globalThis.fetch=(input,options)=>String(input).startsWith('https://api.deepseek.com/')?nativeFetch('http://127.0.0.1:'+model.address().port,options):nativeFetch(input,options);
 t.after(async()=>{globalThis.fetch=nativeFetch;model.closeAllConnections();await new Promise(resolve=>model.close(resolve));});
 const messages=[{role:'user',content:'Synthetic default-funding question'}],tools=[{type:'function',function:{name:'fixture_tool',description:'fixture',parameters:{type:'object',properties:{}}}}];
 const call=key=>paid.runWithPaidConversation(key,()=>chatCompletion({messages,tools,maxTokens:16}));
 await t.test('administrator enables once; existing and future authorized groups/private chats inherit 0.1 without per-chat writes',async()=>{
  assert.equal(f.business.runtimeAllowed('private:777'),false);
  const saved=await save({defaultPlatformFunding:true,defaultDailyLimitCny:.1});assert.equal(saved.status,200);assert.equal(saved.body.defaultPlatformFunding,true);
  for(const key of ['group:789','group:777','private:777','private:999']){
   assert.equal(f.business.runtimeAllowed(key),true,key);
   const source=await request('GET','/api/platform/funding?chatKey='+encodeURIComponent(key));assert.equal(source.status,200);assert.equal(source.body.mode,'platform');assert.equal(source.body.enabled,true);assert.equal(source.body.inherited,true);assert.equal(source.body.dailyLimitCny,.1);
  }
  assert.deepEqual(getConfig().productionBudget.funding,{});
  updateConfig({allow:{private:['999','881']}});assert.equal(f.business.runtimeAllowed('private:881'),true,'a later whitelist entry inherits without selecting payment');
  const resumed=await request('GET','/api/platform/overview?summary=1',null,f.cookie);assert.equal(resumed.body.scopes.find(s=>s.chatKey==='private:777').funding.inherited,true);
  assert.equal(paid.productionPaidCallGuard().records().length,0,'reading defaults does not invent a charge');
 });
 await t.test('ordinary accounts cannot change platform defaults; arbitrary histories, foreign bots and denied resources gain no funding',async()=>{
  assert.equal((await save({defaultPlatformFunding:false},f.cookie)).status,403);
  assert.equal((await save({defaultPlatformFunding:'yes'})).status,400);
  assert.equal(getConfig().productionBudget.defaultPlatformFunding,true);
  for(const bad of [{defaultPlatformFunding:'yes'},{defaultFundingVersion:0},{defaultFundingVersion:1.5}])assert.throws(()=>paid.validateProductionBudgetConfig({...getConfig(),productionBudget:{...getConfig().productionBudget,...bad}}),/默认平台资助策略无效/);
  f.store.appendIncoming('private:882',{senderId:'882',senderName:'Fixture history only',text:'No authority implied by history'});
  f.auth.store.grant(f.principal.id,'private:883','secondary');
  for(const key of ['private:882','private:883','private:884','group:884'])assert.throws(()=>paid.runWithPaidConversation(key,()=>assert.fail('Unfunded callback')),/未获明确授权/);
  updateConfig({deny:{private:['881'],groups:['777']}});
  for(const key of ['private:881','group:777']){assert.equal(f.business.runtimeAllowed(key),false);assert.throws(()=>paid.runWithPaidConversation(key,()=>assert.fail('Denied callback')),/未获明确授权/);}
  updateConfig({deny:{private:[],groups:[]}});assert.equal(calls.length,0);
 });
 await t.test('default platform key reaches the same model/tool pipeline and same-number group/private expenses stay separate',async()=>{
  await call('group:777');assert.equal(calls[0].authorization,'Bearer fixture-model-key');assert.deepEqual(calls[0].body.tools,tools);
  const guard=paid.productionPaidCallGuard();assert.equal(guard.status('group:777').spentCny,.00004);assert.equal(guard.status('private:777').spentCny,0);
  await call('private:777');assert.equal(guard.status('private:777').spentCny,.00004);assert.equal(calls[1].authorization,'Bearer fixture-model-key');
 });
 await t.test('explicit overrides, paused selections and invalid own keys always win over automatic platform subsidy',async()=>{
  assert.equal((await save({overrides:{'group:789':.3}})).status,200);assert.equal(paid.productionPaidCallGuard().status('group:789').dailyLimitCny,.3);
  f.business.setFunding(admin,{chatKey:'group:777',mode:'disabled'});assert.equal(f.business.runtimeAllowed('group:777'),false);assert.throws(()=>paid.runWithPaidConversation('group:777',()=>assert.fail('Paused callback')),/停用|撤销|尚未配置/);
  updateConfig({productionBudget:{funding:{'private:881':{mode:'platform',enabled:false}}}});assert.equal(f.business.runtimeAllowed('private:881'),false);assert.throws(()=>paid.runWithPaidConversation('private:881',()=>assert.fail('Explicitly disabled callback')),/未获明确授权/);
  const credential=f.business.saveCredential(f.principal,{name:'Fixture own key',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-own-model-key',enabled:true}).credential;
  f.business.setFunding(f.principal,{chatKey:'private:777',mode:'byok',credentialRef:credential.id});const before=calls.length;responses.push({status:401});await assert.rejects(call('private:777'));
  assert.equal(calls.length,before+1);assert.equal(calls.at(-1).authorization,'Bearer fixture-own-model-key');
  f.business.saveCredential(f.principal,{id:credential.id,expectedVersion:credential.version,name:credential.name,endpoint:credential.endpoint,model:credential.model,enabled:false});
  assert.equal(f.business.runtimeAllowed('private:777'),false);assert.throws(()=>paid.runWithPaidConversation('private:777',()=>assert.fail('Invalid key callback')),/停用|撤销|尚未配置/);
 });
 await t.test('verified new private chats activate automatically; disabling owner and grant revoke/regrant invalidate captured authority',async()=>{
  const created=await f.auth.register({username:'fixture_new_user',password:'fixture-new-pass-2026'}),cookie=f.auth.cookie(created.token).split(';')[0],person=f.auth.authenticate(cookie);
  const proof=f.auth.issueBinding(person,{qq:'885'});assert.equal(f.auth.consumeBinding({private:true,qq:'885',text:proof.command}).ok,true);
  assert.equal(f.business.runtimeAllowed('private:885'),true);const token=paid.capturePaidAuthority('private:885');
  await f.auth.updateAccount(admin,{id:person.id,disabled:true,expectedVersion:f.auth.store.version()});assert.equal(f.business.runtimeAllowed('private:885'),false);assert.throws(()=>paid.assertPaidAuthority('private:885',token));
  await f.auth.updateAccount(admin,{id:person.id,disabled:false,expectedVersion:f.auth.store.version()});assert.equal(f.business.runtimeAllowed('private:885'),true);assert.throws(()=>paid.assertPaidAuthority('private:885',token));
  f.auth.store.grant(person.id,'group:886');assert.equal(f.business.runtimeAllowed('group:886'),true);const groupToken=paid.capturePaidAuthority('group:886');
  await f.auth.updateAccount(admin,{id:person.id,conversationKeys:[],expectedVersion:f.auth.store.version()});assert.equal(f.business.runtimeAllowed('group:886'),false);
  f.auth.store.grant(person.id,'group:886');assert.equal(f.business.runtimeAllowed('group:886'),true);assert.throws(()=>paid.assertPaidAuthority('group:886',groupToken));
  f.auth.store.grant(person.id,'group:887','primary',{automatic:true,ttlMs:1});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(f.business.runtimeAllowed('group:887'),false);
 });
 await t.test('toggle off/on preserves explicit authorizations, old charges and pending unknown holds, without reviving old default tokens',async()=>{
  const token=paid.capturePaidAuthority('private:999'),before=paid.productionPaidCallGuard().records();
  updateConfig({productionBudget:{funding:{'private:888':{mode:'platform',enabled:true}}},allow:{private:['999','881','888']}});
  assert.equal((await save({defaultPlatformFunding:false})).status,200);assert.equal(f.business.runtimeAllowed('private:999'),false);assert.equal(f.business.runtimeAllowed('private:888'),true);assert.equal(f.business.runtimeAllowed('group:777'),false);
  assert.equal((await save({defaultPlatformFunding:true})).status,200);assert.equal(f.business.runtimeAllowed('private:999'),true);assert.throws(()=>paid.assertPaidAuthority('private:999',token));
  assert.deepEqual(paid.productionPaidCallGuard().records(),before);assert.equal(paid.productionPaidCallGuard().status('group:789').dailyLimitCny,.3);
 });
 await t.test('the 0.1 ceiling constrains concurrent reservations, survives restart and retains uncertain charges across Beijing midnight',async sub=>{
  const storage=paid.createPaidCallStorage(path.join(f.root,'fixture-small-default.sqlite'));let clock=Date.parse('2026-10-23T15:59:00Z');let guard=paid.createPaidCallGuard({storage,config:getConfig,now:()=>clock});
  sub.after(()=>storage.close());let hold;
  paid.runWithPaidConversation('private:999',()=>{hold=guard.prepare({api:getConfig().api,platformCredential:getConfig().api.apiKey,body:{model:'deepseek-flash',stream:false,messages,max_tokens:512}});guard.dispatch(hold);guard.unknown(hold,'fixture_uncertain_delivery');});
  const uncertain=guard.status('private:999').reservedCny;assert.ok(uncertain>0);assert.equal(guard.status('private:999').dailyLimitCny,.1);
  guard=paid.createPaidCallGuard({storage,config:getConfig,now:()=>clock});clock=Date.parse('2026-10-23T16:01:00Z');assert.equal(guard.status('private:999').reservedCny,uncertain);assert.equal(guard.status('private:999').unknownReservations,1);
  paid.runWithPaidConversation('private:999',()=>{
   let denied=false;for(let i=0;i<100;i++)try{guard.prepare({api:getConfig().api,platformCredential:getConfig().api.apiKey,body:{model:'deepseek-flash',stream:false,messages,max_tokens:512}});}catch{denied=true;break;}
   assert.equal(denied,true);assert.ok(guard.status('private:999').reservedCny<=.1);assert.equal(guard.status('private:999').dailyLimitCny,.1);
  });
 });
});
