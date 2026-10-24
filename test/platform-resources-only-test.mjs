import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-platform-resources-'));
process.env.QQ_AGENT_DATA_DIR=root;
const {createPlatformBusiness}=await import('../src/platform-business.js');
const {ConversationArchives}=await import('../src/conversation-archives.js');
const {ChatStore}=await import('../src/store.js');
const {getConfig,setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js');
const {productionPaidCallGuard,closeProductionPaidCallGuard,runWithPaidConversation,capturePaidAuthority,assertPaidAuthority}=await import('../src/paid-call-guard.js');
const {chatCompletion}=await import('../src/llm.js');
const {currentConversationContext,runWithConversationContext}=await import('../src/conversation-context.js');
test.after(()=>{closeProductionPaidCallGuard();fs.rmSync(root,{recursive:true,force:true});});

function fixture(t){
  closeProductionPaidCallGuard();fs.rmSync(path.join(root,'paid-calls.sqlite'),{force:true});
  const cfg={...structuredClone(DEFAULT_CONFIG),platform:{resourcesOnly:false},
    api:{...structuredClone(DEFAULT_CONFIG.api),baseUrl:'https://resources.example.test/v1',model:'fixture-resources',apiKey:'fixture-platform-key',fallbackModels:[]},
    allow:{groups:['101','999'],private:[]},deny:{groups:[],private:[]},
    productionBudget:{enabled:true,endpoint:'https://resources.example.test/v1',model:'fixture-resources',
      prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},
      defaultDailyLimitCny:1,overrides:{},initialSpent:{},outputCap:128,
      funding:{'group:101':{mode:'platform',enabled:true},'group:999':{mode:'platform',enabled:true},'group:303':{mode:'platform',enabled:false}}}};
  setRuntimeConfig(cfg);
  const alice={id:'alice',role:'user',boundQQ:'101'},bob={id:'bob',role:'user',boundQQ:'102'},admin={id:'admin',role:'admin'};
  const people=new Map([alice,bob,admin].map(p=>[p.id,p])),epochs=new Map();
  const grants=new Map([['alice',new Set(['group:101','private:101'])],['bob',new Set(['group:202','group:303','private:102'])],['admin',new Set()]]);
  const auth={
    verifyPrincipal(p){if(people.get(p?.id)!==p)throw Object.assign(Error('invalid session'),{statusCode:401});return p;},
    canAccess(p,k){return people.get(p.id)===p&&(p.role==='admin'||grants.get(p.id)?.has(k));},
    canUseResourceOwner(id,k){return people.has(id)&&(people.get(id).role==='admin'||grants.get(id)?.has(k));},
    permissionVersion(id,k){return String(epochs.get(id+'|'+k)||0);},
    listScopes(p){this.verifyPrincipal(p);return p.role==='admin'?[...new Set([...grants.values()].flatMap(values=>[...values]))]:[...grants.get(p.id)];},
    resourceOwners(k){return [...people.values()].filter(p=>grants.get(p.id)?.has(k)).map(p=>({id:p.id,permissionVersion:this.permissionVersion(p.id,k)})).sort((a,b)=>a.id.localeCompare(b.id));},
    resourceKeys(){return [...new Set([...grants.entries()].filter(([id])=>people.has(id)).flatMap(([,values])=>[...values]))];}
  };
  const file=path.join(root,crypto.randomUUID()+'.sqlite'),archiveFile=path.join(root,crypto.randomUUID()+'.sqlite');
  const archives=new ConversationArchives({file:archiveFile}),store=new ChatStore(0,{archives});
  let service=createPlatformBusiness({file,archives,store,auth,config:getConfig});
  t.after(()=>{closeProductionPaidCallGuard();service.close();archives.close();});
  const sql=work=>{const db=new DatabaseSync(file);try{return work(db);}finally{db.close();}};
  return {alice,bob,admin,people,grants,epochs,auth,cfg,file,archives,store,sql,get service(){return service;},
    enable(){setRuntimeConfig({...getConfig(),platform:{...getConfig().platform,resourcesOnly:true}});},
    reopen(){service.close();service=createPlatformBusiness({file,archives,store,auth,config:getConfig});},
    credential(){return service.saveCredential(alice,{name:'Preserved personal profile',endpoint:cfg.api.baseUrl,model:cfg.api.model,apiKey:'fixture-personal-key'}).credential;},
    execute(k='group:101'){return runWithPaidConversation(k,()=>chatCompletion({messages:[{role:'user',content:'Synthetic fixture'}],maxTokens:16}));}
  };
}
function stubModel(t){
  const previous=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://resources.example.test/v1/chat/completions');requests.push({headers:options.headers,body:JSON.parse(options.body)});return new Response(JSON.stringify({model:'fixture-resources',choices:[{message:{role:'assistant',content:'Synthetic fixture result'}}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}}));};
  t.after(()=>{globalThis.fetch=previous;});return requests;
}

test('shared-resource overview hides retained personal credentials and exposes only the safe platform model',t=>{
  const f=fixture(t),credential=f.credential();
  assert.equal(f.service.credentials(f.alice).credentials[0].id,credential.id);
  f.enable();
  assert.deepEqual(f.service.credentials(f.alice),{credentials:[],disabled:true});
  assert.deepEqual(f.service.credentials(f.admin),{credentials:[],disabled:true});
  const view=f.service.overview(f.alice,{summary:true});
  assert.equal(view.platformResourcesOnly,true);assert.equal(view.credentialCount,0);
  assert.deepEqual(view.platformModel,{model:'fixture-resources'});
  assert.equal(JSON.stringify(view).includes('fixture-platform-key'),false);
  assert.equal(JSON.stringify(view).includes('fixture-personal-key'),false);
  assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM business_credentials').get().n),1);
});

test('old credential/payer/quota mutation APIs cannot evade the shared-resource policy',t=>{
  const f=fixture(t),credential=f.credential();
  f.service.setFunding(f.alice,{chatKey:'group:101',mode:'byok',credentialRef:credential.id});
  const before=f.sql(db=>db.prepare('SELECT * FROM business_funding').all());
  f.enable();
  for(const actor of [f.alice,f.admin])assert.throws(()=>f.service.saveCredential(actor,{}),{statusCode:403});
  for(const mode of ['byok','disabled','platform'])assert.throws(()=>f.service.setFunding(f.alice,{chatKey:'group:101',mode,credentialRef:credential.id,dailyLimitCny:100}),{statusCode:403});
  assert.throws(()=>f.service.setFunding(f.admin,{chatKey:'group:101',mode:'byok',credentialRef:credential.id}),{statusCode:403});
  assert.throws(()=>f.service.updateBudget(f.alice,{chatKey:'group:101',dailyLimitCny:100}),{statusCode:403});
  assert.deepEqual(f.sql(db=>db.prepare('SELECT * FROM business_funding').all()),before);
  assert.equal(getConfig().productionBudget.overrides['group:101'],undefined);
  assert.throws(()=>f.service.credentials({id:'alice',role:'admin'}),{statusCode:401});
});

test('enabled legacy BYOK uses platform funding without decrypting or rewriting the old credential or funding rows',async t=>{
  const f=fixture(t),credential=f.credential(),requests=stubModel(t);
  f.service.setFunding(f.alice,{chatKey:'group:101',mode:'byok',credentialRef:credential.id,dailyLimitCny:.4});
  const oldAuthority=capturePaidAuthority('group:101');
  // Deliberately invalidate the old ciphertext. Shared mode must not attempt to
  // decrypt this profile, and the preserved bytes must survive the policy switch.
  f.sql(db=>db.prepare('UPDATE business_credentials SET tag=? WHERE id=?').run('invalid-fixture-tag',credential.id));
  const preserved=f.sql(db=>({credentials:db.prepare('SELECT * FROM business_credentials').all(),funding:db.prepare('SELECT * FROM business_funding').all()}));
  f.enable();
  assert.throws(()=>assertPaidAuthority('group:101',oldAuthority),{code:'PAID_CALL_DENIED'});
  await f.execute();
  assert.equal(requests[0].headers.authorization,'Bearer fixture-platform-key');
  assert.equal(f.service.funding(f.alice,'group:101').mode,'platform');
  assert.equal(f.service.funding(f.alice,'group:101').credentialRef,null);
  assert.equal(productionPaidCallGuard().status('group:101').dailyLimitCny,.4);
  assert.deepEqual(f.sql(db=>({credentials:db.prepare('SELECT * FROM business_credentials').all(),funding:db.prepare('SELECT * FROM business_funding').all()})),preserved);
  f.reopen();await f.execute();assert.equal(requests[1].headers.authorization,'Bearer fixture-platform-key');
  assert.equal(productionPaidCallGuard().records().filter(row=>row.state==='settled').length,2);
});

test('new scope-owned resources need no BYOK or payer selection; arbitrary keys and administrator-wide authority do not fund a resource',async t=>{
  const f=fixture(t),requests=stubModel(t);f.enable();
  assert.equal(f.service.runtimeAllowed('private:101'),true);
  assert.equal(f.service.runtimeAllowed('group:202'),true);
  assert.equal(f.service.runtimeAllowed('group:999'),true,'Explicit server funding plus allowlist is preserved');
  assert.equal(f.service.runtimeAllowed('private:777777'),false);
  assert.equal(f.service.runtimeAllowed('group:303'),false,'Explicit disabled platform grant is not resurrected');
  await f.execute('private:101');await f.execute('group:202');
  await assert.rejects(async()=>f.execute('private:777777'),{code:'PAID_CALL_DENIED'});
  assert.equal(requests.length,2);
  assert.equal(f.sql(db=>db.prepare('SELECT COUNT(*) n FROM business_funding').get().n),0,'No GET/runtime funding side effects');
  const authority=capturePaidAuthority('group:202');
  f.epochs.set('bob|group:202',1);
  assert.throws(()=>assertPaidAuthority('group:202',authority),{code:'PAID_CALL_DENIED'});
  const renewed=capturePaidAuthority('group:202');f.grants.get('bob').delete('group:202');
  assert.throws(()=>assertPaidAuthority('group:202',renewed),{code:'PAID_CALL_DENIED'});
  assert.equal(f.service.runtimeAllowed('group:202'),false);
});

test('disabled business resources and revoked historical owners remain blocked',async t=>{
  const f=fixture(t),credential=f.credential();stubModel(t);
  f.service.setFunding(f.alice,{chatKey:'group:101',mode:'byok',credentialRef:credential.id});
  f.service.setFunding(f.bob,{chatKey:'private:102',mode:'disabled'});
  f.enable();
  assert.equal(f.service.runtimeAllowed('private:102'),false);
  await assert.rejects(async()=>f.execute('private:102'),{code:'PAID_CALL_DENIED'});
  const authority=capturePaidAuthority('group:101');f.grants.get('alice').delete('group:101');
  assert.throws(()=>assertPaidAuthority('group:101',authority),{code:'PAID_CALL_DENIED'});
  assert.equal(f.service.runtimeAllowed('group:101'),false,'Old owner is not silently replaced by public config fallback');
});

test('switching to platform resources invalidates an already reserved BYOK request before dispatch',async t=>{
  const f=fixture(t),credential=f.credential();stubModel(t);
  f.service.setFunding(f.alice,{chatKey:'group:101',mode:'byok',credentialRef:credential.id});
  const guard=productionPaidCallGuard();let context,token;
  runWithPaidConversation('group:101',()=>{
    context=currentConversationContext();
    token=guard.prepare({api:{...getConfig().api,apiKey:'fixture-personal-key'},platformCredential:'fixture-platform-key',
      body:{model:'fixture-resources',stream:false,messages:[{role:'user',content:'Synthetic reserved fixture'}],max_tokens:16}});
  });
  assert.equal(guard.records()[0].state,'reserved');
  f.enable();
  assert.throws(()=>runWithConversationContext(context,()=>guard.dispatch(token)),{code:'PAID_CALL_DENIED'});
  assert.equal(guard.records()[0].state,'reserved');guard.release(token);
  await f.execute();
  assert.deepEqual(guard.records().map(row=>row.state),['released','settled']);
});

test('trial scope limit and historical bills are retained, while new requests use platform instead of trial',async t=>{
  const f=fixture(t),requests=stubModel(t);
  f.service.updateBudget(f.admin,{trialDailyLimitCny:.07,trialPlatformDailyLimitCny:.5});
  f.service.setFunding(f.alice,{chatKey:'private:101',mode:'platform'});
  await f.execute('private:101');
  const guard=productionPaidCallGuard(),before=guard.status('private:101'),trialBefore=guard.trialStatus();
  const rawRows=f.sql(db=>db.prepare('SELECT * FROM business_funding').all());
  f.enable();await f.execute('private:101');
  assert.equal(requests.at(-1).headers.authorization,'Bearer fixture-platform-key');
  assert.equal(guard.status('private:101').dailyLimitCny,before.dailyLimitCny);
  assert.equal(guard.status('private:101').dailyLimitCny,.07);
  assert.ok(guard.status('private:101').spentCny>before.spentCny);
  assert.equal(guard.trialStatus().spentCny,trialBefore.spentCny,'No new trial charge or historical reset');
  assert.equal(f.service.funding(f.alice,'private:101').mode,'platform');
  assert.deepEqual(f.sql(db=>db.prepare('SELECT * FROM business_funding').all()),rawRows);
});

test('the trusted flag defaults to historical credential and BYOK behavior when false',async t=>{
  const f=fixture(t),credential=f.credential(),requests=stubModel(t);
  f.service.setFunding(f.alice,{chatKey:'group:101',mode:'byok',credentialRef:credential.id});
  await f.execute();
  assert.equal(requests[0].headers.authorization,'Bearer fixture-personal-key');
  assert.equal(f.service.funding(f.alice,'group:101').mode,'byok');
  assert.equal(f.service.overview(f.alice,{summary:true}).platformResourcesOnly,undefined);
  assert.equal(f.service.credentials(f.alice).credentials.length,1);
});
