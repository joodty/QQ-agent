import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-platform-speech-'));
process.env.QQ_AGENT_DATA_DIR=root;
const {createSpeechService}=await import('../src/speech-service.js');
const {createPaidCallGuard,createPaidCallStorage,setPaidCallFundingServices,closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js');
const {getConfig,setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js');
const secret={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixturePlatformTencent',secretKey:'fixture-platform-speech-secret'};
test.after(()=>{setPaidCallFundingServices(null);closeProductionPaidCallGuard();fs.rmSync(root,{recursive:true,force:true});});

function fixture(t,{unified=true}={}){
  const folder=path.join(root,crypto.randomUUID());fs.mkdirSync(folder);
  const keys=['group:101','group:202','private:101','private:102','private:103'];
  const cfg={...structuredClone(DEFAULT_CONFIG),platform:{resourcesOnly:unified},api:{...structuredClone(DEFAULT_CONFIG.api),baseUrl:'https://api.deepseek.com',model:'fixture-model',apiKey:'fixture-platform-key'},allow:{groups:['101','202'],private:['101','102','103']},deny:{groups:[],private:[]},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'fixture-model',prices:{inputCnyPerMillion:2,outputCnyPerMillion:8,cacheHitCnyPerMillion:.04,reasoningIncluded:true},defaultDailyLimitCny:.4,overrides:{'private:101':.1},initialSpent:{},outputCap:1024,imageTokensPerImage:1024,funding:{}},speech:{timeoutMs:1000}};
  setRuntimeConfig(cfg);const blocked=new Set(),modes=new Map(),epochs=new Map();
  setPaidCallFundingServices({resolve(key){return blocked.has(key)||!keys.includes(key)?{blocked:true}:{id:'fixture:'+key+':'+(epochs.get(key)||0),version:1,mode:modes.get(key)||'platform',ownerId:'fixture-owner',scopeAuthorized:true,endpoint:cfg.productionBudget.endpoint,model:cfg.productionBudget.model,prices:cfg.productionBudget.prices,responseModels:[],imageTokensPerImage:1024,apiKey:'fixture-byok-key'};},policy(){return {scopeKeys:keys,overrides:{'group:202':.05}};}});
  const admin={id:'fixture-admin',role:'admin'},user={id:'fixture-user',role:'user'};
  const auth={verifyPrincipal(p){if(p!==admin&&p!==user)throw Error('invalid fixture session');return p;},canAccess(p,key){return (p===admin||p===user)&&keys.includes(key);},listScopes(){return keys;}};
  let now=Date.parse('2026-10-24T04:00:00Z'),credential=secret,providerHook=null,calls=0;
  const storage=createPaidCallStorage(path.join(folder,'paid.sqlite')),ledger=createPaidCallGuard({storage,config:getConfig,now:()=>now});
  const file=path.join(folder,'speech.sqlite');
  const provider={async synthesize(request){calls++;if(providerHook)await providerHook(request);else request.beforeRequest();return {audio:Buffer.from('fixture-audio'),mime:'audio/wav'};}};
  const build=()=>createSpeechService({file,auth,config:getConfig,credentials:()=>credential,guard:()=>ledger,provider});let service=build();
  t.after(()=>{service.close();storage.close();setPaidCallFundingServices(null);});
  const f={cfg,admin,user,blocked,modes,epochs,file,ledger,storage,get service(){return service;},get calls(){return calls;},commit(){setRuntimeConfig(cfg);},flag(value){cfg.platform.resourcesOnly=value;setRuntimeConfig(cfg);},setCredential(value){credential=value;},hook(value){providerHook=value;},advance(){now+=1001;},reopen(){service.close();service=build();},enablePlatform(){const p=service.platformOverview(admin);return service.updatePlatform(admin,{expectedVersion:p.version,enabled:true,dailyLimitCny:.3,cooldownMs:1000,autoVoicePercent:20});},enable(key='group:101'){const p=service.runtimePolicy(key);return service.updateSettings(user,{chatKey:key,expectedVersion:p.settings.version,enabled:true});},call(key='group:101'){return service.synthesize(key,{text:'你好，世界。',direct:true});},rows(){const db=new DatabaseSync(file);try{return {grants:db.prepare('SELECT * FROM speech_subsidies ORDER BY chat_key').all(),scopes:db.prepare('SELECT * FROM speech_scopes ORDER BY chat_key').all()};}finally{db.close();}}};
  return f;
}

test('authorized platform resources inherit bounded speech funding without creating subsidy rows or opting into voice',async t=>{
  const f=fixture(t);f.enablePlatform();
  const group=f.service.runtimePolicy('group:101'),privatePolicy=f.service.runtimePolicy('private:101'),overlay=f.service.runtimePolicy('group:202');
  assert.deepEqual(group.subsidy,{chatKey:'group:101',version:0,enabled:true,allowedFundingModes:['platform'],dailyLimitCny:.3,inherited:true});
  assert.equal(privatePolicy.subsidy.dailyLimitCny,.1);
  assert.equal(overlay.subsidy.dailyLimitCny,.05); // Trusted business policy overlay.
  assert.equal(group.allowed,false);assert.equal(group.reason,'SPEECH_CHAT_DISABLED');
  await assert.rejects(f.call(),{code:'SPEECH_CHAT_DISABLED',dispatched:false});
  assert.equal(f.calls,0);assert.equal(f.ledger.records().length,0);
  const enabled=f.enable();assert.equal(enabled.allowed,true);assert.equal(enabled.settings.autoVoicePercent,20);
  const result=await f.call();assert.ok(result.estimatedCostCny>0);assert.match(result.estimationBoundary,/免费资源包实际抵扣未同步/);
  assert.equal(f.ledger.records().at(-1).state,'settled');assert.equal(f.rows().grants.length,0);
});

test('unknown, revoked, BYOK, zero budget and unavailable limits cannot obtain inherited platform subsidy',async t=>{
  const f=fixture(t);f.enablePlatform();
  for(const mode of ['byok','trial']){f.modes.set('group:101',mode);assert.equal(f.service.runtimePolicy('group:101').subsidy.enabled,false);assert.throws(()=>f.enable(),{code:'SPEECH_SUBSIDY_REQUIRED'});}
  f.modes.delete('group:101');f.blocked.add('group:101');assert.equal(f.service.runtimePolicy('group:101').subsidy.enabled,false);assert.throws(()=>f.enable(),{code:'SPEECH_SUBSIDY_REQUIRED'});
  f.blocked.delete('group:101');f.cfg.productionBudget.overrides['group:101']=0;f.commit();assert.equal(f.service.runtimePolicy('group:101').subsidy.dailyLimitCny,0);assert.throws(()=>f.enable(),{code:'SPEECH_SUBSIDY_REQUIRED'});
  delete f.cfg.productionBudget.overrides['group:101'];f.commit();
  const unavailable=createSpeechService({file:path.join(path.dirname(f.file),'unavailable.sqlite'),auth:{verifyPrincipal:p=>p,canAccess:()=>true},config:getConfig,credentials:()=>secret,guard:()=>null,provider:{async synthesize(){throw Error('must not call');}}});
  try{assert.equal(unavailable.runtimePolicy('group:101').subsidy.enabled,false);}finally{unavailable.close();}
  assert.equal(f.calls,0);assert.equal(f.rows().grants.length,0);
});

test('existing disabled and zero grants remain disabled, with old modes and preferences preserved on disk',async t=>{
  const f=fixture(t,{unified:false});f.enablePlatform();
  f.service.updateSubsidy(f.admin,{chatKey:'group:101',expectedVersion:0,enabled:true,allowedFundingModes:['byok','trial'],dailyLimitCny:.08});
  f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:0,enabled:false,voiceType:101004,speed:.5,volume:2,autoVoicePercent:35});
  f.service.updateSubsidy(f.admin,{chatKey:'private:102',expectedVersion:0,enabled:false,allowedFundingModes:['byok'],dailyLimitCny:.2});
  f.service.updateSubsidy(f.admin,{chatKey:'private:103',expectedVersion:0,enabled:false,allowedFundingModes:['trial'],dailyLimitCny:0});
  // Older storage can contain enabled=true with a zero cap. Preserve that exact
  // switch and cap, but never mistake it for permission to synthesize.
  const db=new DatabaseSync(f.file);db.prepare('UPDATE speech_subsidies SET enabled=1 WHERE chat_key=?').run('private:103');db.close();
  const before=f.rows();f.flag(true);
  const grant=f.service.runtimePolicy('group:101').subsidy;assert.deepEqual(grant,{chatKey:'group:101',version:1,enabled:true,allowedFundingModes:['platform'],dailyLimitCny:.08});
  assert.equal(f.service.runtimePolicy('private:102').subsidy.enabled,false);
  assert.equal(f.service.runtimePolicy('private:103').subsidy.enabled,true);
  assert.equal(f.service.runtimePolicy('private:103').subsidy.dailyLimitCny,0);
  for(const key of ['private:102','private:103'])assert.throws(()=>f.enable(key),{code:'SPEECH_SUBSIDY_REQUIRED'});
  const policy=f.service.runtimePolicy('group:101');assert.equal(policy.settings.voiceType,101004);assert.equal(policy.settings.speed,.5);assert.equal(policy.settings.volume,2);assert.equal(policy.settings.autoVoicePercent,35);
  assert.deepEqual(f.rows(),before);f.reopen();assert.deepEqual(f.rows(),before);
  f.flag(false);assert.deepEqual(f.service.runtimePolicy('group:101').subsidy.allowedFundingModes,['byok','trial']);
});

test('ordinary users cannot raise limits and unified subsidy updates reject legacy modes atomically',t=>{
  const f=fixture(t);f.enablePlatform();
  assert.throws(()=>f.service.updateSubsidy(f.user,{chatKey:'group:101',expectedVersion:0,enabled:true,allowedFundingModes:['platform'],dailyLimitCny:1}),{code:'SPEECH_ACCESS_DENIED'});
  assert.throws(()=>f.service.updatePlatform(f.user,{expectedVersion:2,dailyLimitCny:1}),{code:'SPEECH_ACCESS_DENIED'});
  for(const modes of [['byok'],['trial'],['platform','byok']])assert.throws(()=>f.service.updateSubsidy(f.admin,{chatKey:'group:101',expectedVersion:0,enabled:true,allowedFundingModes:modes,dailyLimitCny:.1}),{code:'SPEECH_SUBSIDY_INVALID'});
  assert.equal(f.rows().grants.length,0);
  const saved=f.service.updateSubsidy(f.admin,{chatKey:'group:101',expectedVersion:0,enabled:true,allowedFundingModes:['platform'],dailyLimitCny:.02});assert.equal(saved.version,1);assert.equal(saved.dailyLimitCny,.02);
  assert.throws(()=>f.service.updateSubsidy(f.admin,{chatKey:'group:101',expectedVersion:0,enabled:true,allowedFundingModes:['platform'],dailyLimitCny:.1}),{code:'SPEECH_VERSION_CONFLICT'});
});

test('platform and credential gates remain active and legacy false mode still requires an explicit subsidy',async t=>{
  const f=fixture(t,{unified:false});assert.equal(f.service.runtimePolicy('group:101').subsidy.enabled,false);assert.throws(()=>f.enable(),{code:'SPEECH_SUBSIDY_REQUIRED'});
  f.flag(true);f.setCredential(null);assert.throws(()=>f.enable(),{code:'SPEECH_NO_CREDENTIAL'});
  f.setCredential(secret);f.enable();await assert.rejects(f.call(),{code:'SPEECH_PLATFORM_DISABLED'});
  f.enablePlatform();f.setCredential(null);await assert.rejects(f.call(),{code:'SPEECH_NO_CREDENTIAL'});
  assert.equal(f.calls,0);assert.equal(f.ledger.records().length,0);
});

test('flag and funding-source changes invalidate receipts without deleting settled usage',async t=>{
  const f=fixture(t);f.enablePlatform();
  // Explicit matching modes keep both old/new projections identical: flag itself
  // still must invalidate the policy rather than relying on changed grant data.
  f.service.updateSubsidy(f.admin,{chatKey:'group:101',expectedVersion:0,enabled:true,allowedFundingModes:['platform'],dailyLimitCny:.1});f.enable();
  const receipt=(await f.call()).receipt,version=f.service.runtimePolicy('group:101').policyVersion;
  const records=f.ledger.records();f.flag(false);assert.notEqual(f.service.runtimePolicy('group:101').policyVersion,version);assert.throws(()=>f.service.assertCurrent(receipt),{code:'SPEECH_AUTHORIZATION_CHANGED'});
  f.flag(true);assert.equal(f.service.assertCurrent(receipt),true);f.epochs.set('group:101',1);assert.throws(()=>f.service.assertCurrent(receipt),{code:'SPEECH_AUTHORIZATION_CHANGED'});
  assert.deepEqual(f.ledger.records(),records);f.reopen();assert.deepEqual(f.ledger.records(),records);
});

test('inflight revocation before dispatch releases reservations; after dispatch retains settled nonzero cost',async t=>{
  const f=fixture(t);f.enablePlatform();f.enable();
  f.hook(request=>{f.flag(false);request.beforeRequest();});
  await assert.rejects(f.call(),{code:'SPEECH_AUTHORIZATION_CHANGED',chargeOutcome:'not_sent'});
  assert.equal(f.ledger.records().at(-1).state,'released');
  f.flag(true);f.advance();f.hook(request=>{request.beforeRequest();f.blocked.add('group:101');});
  await assert.rejects(f.call(),{code:'SPEECH_AUTHORIZATION_CHANGED',chargeOutcome:'settled'});
  assert.equal(f.ledger.records().at(-1).state,'settled');assert.ok(f.ledger.records().at(-1).amountCny>0);
});
