import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-business-test-'));
process.env.QQ_AGENT_DATA_DIR=root;
const {createPlatformBusiness}=await import('../src/platform-business.js');
const {ConversationArchives}=await import('../src/conversation-archives.js');
const {ChatStore}=await import('../src/store.js');
const {getConfig,setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js');
const {closeProductionPaidCallGuard,productionPaidCallGuard,runWithPaidConversation,resolvePaidConversationApi,createPaidCallStorage,createPaidCallGuard,capturePaidAuthority,assertPaidAuthority}=await import('../src/paid-call-guard.js');
const {chatCompletion,chatCompletionWithRetry}=await import('../src/llm.js');
const {DatabaseSync}=await import('node:sqlite');
const {SendQueue}=await import('../src/sender.js');
const {currentConversationContext,runWithConversationContext}=await import('../src/conversation-context.js');
test.after(()=>{closeProductionPaidCallGuard();assert.ok(root.startsWith(path.join(os.tmpdir(),'qq-agent-business-test-')));fs.rmSync(root,{recursive:true,force:true});});
function fixture(t){
  closeProductionPaidCallGuard();fs.rmSync(path.join(root,'paid-calls.sqlite'),{force:true});
  const cfg={...structuredClone(DEFAULT_CONFIG),ownerQQ:'999',api:{...structuredClone(DEFAULT_CONFIG.api),baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-platform-key',timeoutMs:5000},allow:{groups:['101'],private:['999']},deny:{groups:[],private:[]},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},outputCap:1024,imageTokensPerImage:1024,funding:{'group:101':{mode:'platform',enabled:true},'private:999':{mode:'platform',enabled:true}}}};
  setRuntimeConfig(cfg);
  const a={id:'user-a',role:'user',boundQQ:'101'},b={id:'user-b',role:'user',boundQQ:'102'},admin={id:'admin',role:'admin',boundQQ:'999'},people=new Map([a,b,admin].map(p=>[p.id,p]));
  const grants=new Map([[a.id,new Set(['group:101','private:101'])],[b.id,new Set(['private:102'])],[admin.id,new Set(['group:101','private:101','private:102','private:999'])]]),epochs=new Map();
  const auth={verifyPrincipal(p){if(people.get(p?.id)!==p)throw Object.assign(Error('fixture unauthorized'),{statusCode:401});return p;},canAccess(p,k){return people.get(p.id)===p&&(p.role==='admin'||grants.get(p.id)?.has(k));},listScopes(p){this.verifyPrincipal(p);return [...grants.get(p.id)];},canUseResourceOwner(id,k){return people.has(id)&&(people.get(id).role==='admin'||grants.get(id)?.has(k));},permissionVersion(id,k){return String(epochs.get(id+'|'+k)||0);}};
  const file=path.join(root,crypto.randomUUID()+'.sqlite'),archives=new ConversationArchives({file:path.join(root,crypto.randomUUID()+'.sqlite')}),store=new ChatStore(0,{archives}),changes=[];
  const service=createPlatformBusiness({file,archives,store,orchestrator:{archiveChanged:k=>changes.push(k)},auth,config:getConfig});
  t.after(()=>{closeProductionPaidCallGuard();service.close();archives.close();});
  return {cfg,a,b,admin,people,grants,epochs,auth,file,archives,store,service,changes};
}
const credential=(s,p,apiKey='fixture-user-key')=>s.saveCredential(p,{name:'Fixture key',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey}).credential;
const messages=[{role:'user',content:'fixture question'}];
const body=()=>({model:'deepseek-flash',stream:false,messages,max_tokens:16});
const raw=(message={role:'assistant',content:'fixture answer'})=>({model:'deepseek-flash',choices:[{message,finish_reason:'stop'}],usage:{prompt_tokens:16,completion_tokens:1,total_tokens:17}});

test('private personas require resource authority; edits save immutable versions before explicit CAS application',t=>{
  const f=fixture(t),s=f.service;
  assert.throws(()=>s.createPersona(f.b,{chatKey:'group:101',name:'Other',content:'private'}),e=>e.statusCode===403);
  const p=s.createPersona(f.a,{chatKey:'group:101',name:'A',content:'A version one'}).persona;
  const original=s.createArchive(f.a,{chatKey:'group:101',personaId:p.id,expectedSelectionVersion:0}).selected;
  const next=s.updatePersona(f.a,{chatKey:'group:101',id:p.id,expectedVersion:1,content:'A version two'}).persona;
  assert.equal(f.archives.active('group:101').archiveId,original.archiveId);
  assert.equal(f.archives.active('group:101').persona.content,'A version one');
  assert.equal(s.personas(f.b,'private:102').personas.length,0);
  const applied=s.createArchive(f.a,{chatKey:'group:101',personaId:next.id,expectedSelectionVersion:original.selectionVersion}).selected;
  assert.equal(applied.persona.version,2);assert.equal(applied.persona.content,'A version two');
  assert.throws(()=>s.createArchive(f.a,{chatKey:'group:101',personaId:next.id,expectedSelectionVersion:original.selectionVersion}),e=>e.statusCode===409);
  s.selectArchive(f.a,{chatKey:'group:101',archiveId:original.archiveId,expectedVersion:applied.selectionVersion});
  assert.equal(f.archives.active('group:101').persona.content,'A version one');
  assert.deepEqual(s.personaHistory(f.a,{chatKey:'group:101',id:next.id}).versions.map(p=>p.content),['A version two','A version one']);
});

test('API secrets are encrypted, owner scoped and bound to an approved provider without plaintext responses',t=>{
  const f=fixture(t),c=credential(f.service,f.a);
  assert.equal(c.hasKey,true);assert.equal(JSON.stringify(f.service.credentials(f.a)).includes('fixture-user-key'),false);
  assert.equal(f.service.credentials(f.b).credentials.length,0);
  const db=new DatabaseSync(f.file,{readOnly:true});const stored=db.prepare('SELECT * FROM business_credentials').get();db.close();
  assert.equal(JSON.stringify(stored).includes('fixture-user-key'),false);
  assert.throws(()=>f.service.saveCredential(f.a,{name:'bad',endpoint:'https://unapproved.example.test',model:'deepseek-flash',apiKey:'fixture-user-key'}));
  assert.throws(()=>f.service.saveCredential(f.b,{id:c.id,expectedVersion:c.version,name:'steal',endpoint:c.endpoint,model:c.model,apiKey:'fixture-other-key'}),e=>e.statusCode===404);
  f.service.setFunding(f.a,{chatKey:'group:101',mode:'byok',credentialRef:c.id,expectedVersion:0});
  assert.equal(f.service.runtimeAllowed('group:101'),true);
  assert.equal(f.service.runtimeAllowed('private:123456'),false);
  const token=capturePaidAuthority('group:101');f.epochs.set(f.a.id+'|group:101',1);
  assert.throws(()=>assertPaidAuthority('group:101',token),e=>e.code==='PAID_CALL_DENIED');
});

test('platform and BYOK share real HTTP tools/image/memory pipeline; invalid user keys never fall back',async t=>{
  const f=fixture(t),requests=[],scripts=[],server=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;requests.push({authorization:req.headers.authorization,body:JSON.parse(text)});const next=scripts.shift()||{data:raw()};res.writeHead(next.status||200,{'content-type':'application/json'});res.end(JSON.stringify(next.data));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const native=globalThis.fetch;
  globalThis.fetch=(url,opts)=>{assert.equal(String(url),'https://api.deepseek.com/chat/completions');return native('http://127.0.0.1:'+server.address().port,opts);};
  t.after(async()=>{globalThis.fetch=native;server.closeAllConnections();await new Promise(r=>server.close(r));});
  // A group participant need not possess any website account: the group itself has platform funding.
  await runWithPaidConversation('group:101',()=>chatCompletion({messages,maxTokens:16}));assert.equal(requests[0].authorization,'Bearer fixture-platform-key');
  const c=credential(f.service,f.a);f.service.setFunding(f.a,{chatKey:'group:101',mode:'byok',credentialRef:c.id});
  const tools=[{type:'function',function:{name:'fixture_tool',description:'fixture',parameters:{type:'object',properties:{}}}}];
  scripts.push({data:raw({role:'assistant',content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name:'fixture_tool',arguments:'{}'}}]})});
  await runWithPaidConversation('group:101',async()=>{const first=await chatCompletion({messages,tools,maxTokens:16});await chatCompletion({messages:[...messages,first.message,{role:'tool',tool_call_id:'fixture-call',content:'fixture result'}],tools,maxTokens:16});});
  await runWithPaidConversation('group:101',()=>chatCompletion({messages:[{role:'user',content:[{type:'text',text:'fixture image'},{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}],maxTokens:16}));
  await runWithPaidConversation('group:101',()=>chatCompletion({messages,purpose:'memory',maxTokens:16}));
  assert.deepEqual(requests[1].body.tools,tools);assert.equal(requests[3].body.messages[0].content[1].type,'image_url');
  assert.ok(requests.slice(1).every(row=>row.authorization==='Bearer fixture-user-key'));
  const calls=requests.length;scripts.push({status:401,data:{error:{message:'fixture invalid user key'}}});
  await assert.rejects(runWithPaidConversation('group:101',()=>chatCompletionWithRetry({messages,maxTokens:16},0)));
  assert.equal(requests.length,calls+1);assert.equal(requests.at(-1).authorization,'Bearer fixture-user-key');
  assert.equal(productionPaidCallGuard().records({key:'group:101'}).at(-1).state,'unknown');
  const privateKey=credential(f.service,f.b,'fixture-private-key');f.service.setFunding(f.b,{chatKey:'private:102',mode:'byok',credentialRef:privateKey.id});
  await runWithPaidConversation('private:102',()=>chatCompletion({messages,maxTokens:16}));assert.equal(requests.at(-1).authorization,'Bearer fixture-private-key');
  assert.equal(f.service.runtimeAllowed('private:102'),true);
});

test('trial admission reserves personal and platform aggregate atomically, denies raising subsidy and preserves unknown holds',async t=>{
  const f=fixture(t);f.service.updateBudget(f.admin,{trialDailyLimitCny:.006,trialPlatformDailyLimitCny:.007});
  f.service.setFunding(f.a,{chatKey:'private:101',mode:'platform'});f.service.setFunding(f.b,{chatKey:'private:102',mode:'platform'});
  assert.throws(()=>f.service.setFunding(f.a,{chatKey:'private:101',mode:'platform',dailyLimitCny:1}),e=>e.statusCode===403);
  const guard=productionPaidCallGuard(),prepare=()=>guard.prepare({api:getConfig().api,body:body(),platformCredential:getConfig().api.apiKey});
  let hold,context;
  await runWithPaidConversation('private:101',()=>{context=currentConversationContext();hold=prepare();});
  assert.equal(guard.status('private:101').activeReservations,1);assert.equal(guard.trialStatus().activeReservations,1);
  await assert.rejects(runWithPaidConversation('private:102',async()=>prepare()),e=>e.code==='PAID_CALL_DENIED');
  assert.equal(guard.status('private:102').activeReservations,0);
  runWithConversationContext(context,()=>{guard.dispatch(hold);guard.unknown(hold,'timeout');});
  assert.equal(guard.trialStatus().unknownReservations,1);assert.equal(guard.status('private:101').unknownReservations,1);
});

test('revocation and revoke-regrant ABA after HTTP still book usage and reject further tool effects',async t=>{
  const f=fixture(t),c=credential(f.service,f.a);f.service.setFunding(f.a,{chatKey:'group:101',mode:'byok',credentialRef:c.id});
  let started,finish;const began=new Promise(r=>started=r),gate=new Promise(r=>finish=r),native=globalThis.fetch;
  globalThis.fetch=async()=>{started();await gate;return new Response(JSON.stringify(raw()),{status:200,headers:{'content-type':'application/json'}});};t.after(()=>globalThis.fetch=native);
  const work=runWithPaidConversation('group:101',()=>chatCompletion({messages,maxTokens:16}));await began;
  f.epochs.set(f.a.id+'|group:101',2);finish();
  await assert.rejects(work,e=>e.code==='PAID_CALL_DENIED');
  const rows=productionPaidCallGuard().records({key:'group:101'});assert.equal(rows.length,1);assert.equal(rows[0].state,'settled');assert.equal(rows[0].actualCny,.00004);
});

test('apply controls continue matching persona archives across A B A and only explicit new conversation creates another',t=>{
  const f=fixture(t),s=f.service,a=s.createPersona(f.a,{chatKey:'group:101',name:'A',content:'A'}).persona,b=s.createPersona(f.a,{chatKey:'group:101',name:'B',content:'B'}).persona;
  const first=s.applyPersona(f.a,{chatKey:'group:101',personaId:a.id,expectedSelectionVersion:0});
  const chat=f.archives.readChat('group:101');chat.messages.push({id:chat.nextLocalId++,mid:null,ts:1,senderId:'fixture',senderName:'Fixture',text:'retained A conversation',self:false,read:true,reply:null,media:[]});f.archives.writeChat(chat);
  const other=s.applyPersona(f.a,{chatKey:'group:101',personaId:b.id,expectedSelectionVersion:first.selected.selectionVersion});
  const back=s.applyPersona(f.a,{chatKey:'group:101',personaId:a.id,expectedSelectionVersion:other.selected.selectionVersion});
  assert.equal(back.reused,true);assert.equal(back.selected.archiveId,first.selected.archiveId);assert.equal(s.messages(f.a,{chatKey:'group:101'}).messages[0].text,'retained A conversation');
  assert.equal(f.archives.list('group:101').length,2);
  const fresh=s.applyPersona(f.a,{chatKey:'group:101',personaId:a.id,expectedSelectionVersion:back.selected.selectionVersion,newConversation:true});assert.equal(fresh.reused,false);assert.equal(s.messages(f.a,{chatKey:'group:101'}).messages.length,0);
  assert.throws(()=>s.messages(f.a,{chatKey:'private:101',archiveId:first.selected.archiveId}),e=>e.statusCode===404);
});

test('legacy profiles, worker funding and usage import are idempotent and historical usage does not count seed twice',t=>{
  const f=fixture(t),date=new Date(Date.now()+8*3600000).toISOString().slice(0,10),cfg=getConfig();cfg.productionBudget.initialSpent={[date]:{'group:101':.5}};setRuntimeConfig(cfg);
  const input={format:'qq-bridge-business',version:1,sourceId:'fixture-legacy-business',credentials:[{id:'legacy-key',ownerId:f.a.id,name:'Legacy',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-legacy-key',enabled:true,version:1},{id:'legacy-pro',ownerId:f.a.id,name:'Legacy pro',endpoint:'https://api.deepseek.com',model:'unpriced-pro-model',apiKey:'fixture-pro-key',enabled:true,version:1}],funding:[{botId:'retired-worker',chatKey:null,ownerId:f.a.id,mode:'byok',credentialRef:'legacy-key',version:1,enabled:true}],usage:[{id:'legacy-day-group',chatKey:'group:101',date,amountCny:.5,model:'deepseek-flash'}],settings:{trialEnabled:true,trialDailyLimitCny:.1,trialPlatformDailyLimitCny:1,trialInitialSpent:{}}};
  assert.equal(f.service.importLegacyState(input).dryRun,true);assert.equal(f.service.credentials(f.a).credentials.length,0);
  const imported=f.service.importLegacyState(input,{dryRun:false});assert.equal(imported.profilesMapped,1);assert.equal(imported.profilesDisabled,1);assert.equal(imported.fundingDisabled,1);assert.equal(imported.disabledReasons.FOREIGN_BOT_DATA_ONLY,1);
  assert.equal(f.service.usage(f.a,{chatKey:'group:101'}).conversations[0].amountCny,.5);assert.equal(productionPaidCallGuard().status('group:101').spentCny,.5);
  f.service.importLegacyState(input,{dryRun:false});assert.equal(f.service.usage(f.a,{chatKey:'group:101'}).conversations[0].amountCny,.5);
  const changed=structuredClone(input);changed.usage[0].amountCny=.6;assert.throws(()=>f.service.importLegacyState(changed,{dryRun:false}),e=>e.statusCode===409);
  assert.equal(f.service.credentials(f.a).credentials.find(c=>c.id==='legacy-pro').enabled,false);
});

test('native and workspace limits share one effective override and changing provider cannot retain an old key',t=>{
  const f=fixture(t),c=credential(f.service,f.a);f.service.setFunding(f.a,{chatKey:'group:101',mode:'byok',credentialRef:c.id,dailyLimitCny:.5});
  assert.equal(productionPaidCallGuard().status('group:101').dailyLimitCny,.5);
  f.service.updateBudget(f.a,{chatKey:'group:101',dailyLimitCny:.2});assert.equal(productionPaidCallGuard().status('group:101').dailyLimitCny,.2);
  const view=f.service.budgets(f.admin);f.service.updateBudget(f.admin,{version:view.version,overrides:{'group:101':.3}});assert.equal(productionPaidCallGuard().status('group:101').dailyLimitCny,.3);
  const cfg=getConfig();cfg.productionBudget.approvedProviders=[{endpoint:'https://other.example.test',model:'deepseek-flash',prices:cfg.productionBudget.prices}];setRuntimeConfig(cfg);
  assert.throws(()=>f.service.saveCredential(f.a,{id:c.id,expectedVersion:c.version,name:c.name,endpoint:'https://other.example.test',model:c.model}));
  f.service.setFunding(f.admin,{chatKey:'group:202',mode:'platform',dailyLimitCny:.25});
  assert.equal(f.service.funding(f.admin,'group:202').dailyLimitCny,.25);
  assert.equal(productionPaidCallGuard().status('group:202').dailyLimitCny,.25);
  const after=f.service.budgets(f.admin);f.service.updateBudget(f.admin,{version:after.version,overrides:{'group:202':.75}});
  assert.equal(f.service.funding(f.admin,'group:202').dailyLimitCny,.75);
});

test('foreign bot usage with an identical typed chat key is retained but never billed to the primary bot',t=>{
  const f=fixture(t),input={format:'qq-bridge-business',version:1,sourceId:'fixture-cross-bot',credentials:[],funding:[],usage:[{id:'primary-row',chatKey:'group:101',date:'2026-10-22',amountCny:.1,botId:'primary'},{id:'foreign-row',chatKey:'group:101',date:'2026-10-22',amountCny:9,botId:'retired-worker'}]};
  const report=f.service.importLegacyState(input,{dryRun:false});assert.equal(report.usageAdded,2);assert.equal(report.foreignUsageRetained,1);
  assert.equal(f.service.usage(f.a,{chatKey:'group:101'}).conversations[0].amountCny,.1);
  const db=new DatabaseSync(f.file,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM business_usage').get().n,2);db.close();
});

test('multiple guarded QQ sends preserve one archive token and a permission epoch change prevents later delivery',async t=>{
  const f=fixture(t),c=credential(f.service,f.a),p=f.service.createPersona(f.a,{chatKey:'group:101',name:'Sender fixture',content:'Fixture persona'}).persona;
  f.service.applyPersona(f.a,{chatKey:'group:101',personaId:p.id,expectedSelectionVersion:0});f.service.setFunding(f.a,{chatKey:'group:101',mode:'byok',credentialRef:c.id});
  const sent=[],sender=new SendQueue({store:f.store,onebot:{sendText:async(kind,id,text)=>{sent.push({kind,id,text});return {message_id:sent.length};}}});
  await runWithPaidConversation('group:101',()=>f.store.withArchive('group:101',async()=>{
    await sender.sendTextBatch('group:101',['first fixture delivery']);await sender.sendTextBatch('group:101',['second fixture delivery']);
    f.epochs.set(f.a.id+'|group:101',1);
    await assert.rejects(sender.sendTextBatch('group:101',['revoked fixture delivery']),e=>e.code==='PAID_CALL_DENIED');
  }));
  assert.equal(sent.length,2);assert.equal(f.archives.readChat('group:101').messages.length,2);
});
