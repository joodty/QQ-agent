import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-speech-test-'));process.env.QQ_AGENT_DATA_DIR=root;
const {createSpeechService,readSpeechCredential}=await import('../src/speech-service.js');
const {createTencentSpeechProvider}=await import('../src/speech-provider.js');
const {createPaidCallGuard,createPaidCallStorage,setPaidCallFundingServices,runWithPaidConversation,closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js');
const {getConfig,setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js');
test.after(()=>{setPaidCallFundingServices(null);closeProductionPaidCallGuard();fs.rmSync(root,{recursive:true,force:true});});
const secret={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixtureTencentId',secretKey:'fixture-tencent-secret-value'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const audio=()=>{const a=Buffer.alloc(46);a.write('RIFF');a.write('WAVE',8);return a;};
async function fixture(t,{initialSpent={},trial=false}={}){
  setPaidCallFundingServices(null);const folder=path.join(root,crypto.randomUUID());fs.mkdirSync(folder);
  let clock=Date.parse('2026-10-23T04:00:00Z'),currentSecret=secret,archiveVersion=1,closed=false;
  const cfg={...structuredClone(DEFAULT_CONFIG),ownerQQ:'999',api:{...structuredClone(DEFAULT_CONFIG.api),baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-platform-llm-key'},allow:{groups:['101','202'],private:['101']},deny:{groups:[],private:[]},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent,outputCap:1024,imageTokensPerImage:1024,funding:Object.fromEntries(['group:101','group:202','private:101'].map(k=>[k,{mode:'platform',enabled:true}]))},speech:{timeoutMs:1000}};
  setRuntimeConfig(cfg);const modes=new Map(),epochs=new Map(),revoked=new Set(),keys=['group:101','group:202','private:101'];if(trial)modes.set('private:101','trial');
  const funding={resolve(k){if(revoked.has(k))return {blocked:true};const mode=modes.get(k);return mode?{id:mode+':'+k+':'+(epochs.get(k)||0),version:1,mode,ownerId:'user-a',endpoint:cfg.productionBudget.endpoint,model:cfg.productionBudget.model,prices:cfg.productionBudget.prices,responseModels:[],imageTokensPerImage:1024,apiKey:'fixture-user-llm-key',scopeAuthorized:true}:null;},policy(){return {scopeKeys:keys,trial:{dailyLimitCny:1,initialSpent:{}}};}};setPaidCallFundingServices(funding);
  const admin={id:'admin',role:'admin'},user={id:'user-a',role:'user'},stranger={id:'stranger',role:'user'},people=new Set([admin,user,stranger]);
  const auth={verifyPrincipal(p){if(!people.has(p))throw Error('fixture invalid session');return p;},canAccess(p,k){return people.has(p)&&keys.includes(k)&&(p===admin||p===user&&k!=='group:202');},listScopes(p){this.verifyPrincipal(p);return keys.filter(k=>this.canAccess(p,k));}};
  const store={captureArchive(){return {archiveId:'fixture-a',selectionVersion:archiveVersion};},assertArchiveCurrent(k,token){if(token?.selectionVersion!==archiveVersion)throw Object.assign(Error('fixture switched'),{code:'ARCHIVE_CHANGED'});}};
  const requests=[],plans=[],server=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const body=JSON.parse(text);requests.push({body,authorization:req.headers.authorization});const plan=plans.shift()||{};plan.started?.resolve();if(plan.wait)await plan.wait;if(res.destroyed)return;if(plan.hang){res.writeHead(200,{'content-type':'application/json'});res.write('{"Response":');return;}res.writeHead(plan.status||200,{'content-type':'application/json'});res.end(plan.raw??JSON.stringify({Response:{Audio:audio().toString('base64'),SessionId:body.SessionId,RequestId:'fixture-request'}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const provider=createTencentSpeechProvider({now:()=>clock,fetch(url,opts){assert.equal(url,'https://tts.tencentcloudapi.com/');assert.equal(opts.redirect,'error');return fetch('http://127.0.0.1:'+server.address().port,opts);}});
  const ledgerFile=path.join(folder,'paid.sqlite'),speechFile=path.join(folder,'speech.sqlite');let storage=createPaidCallStorage(ledgerFile),guard=createPaidCallGuard({storage,config:getConfig,now:()=>clock}),service;
  const build=()=>createSpeechService({file:speechFile,auth,store,config:getConfig,credentials:()=>currentSecret,guard:()=>guard,provider});service=build();
  t.after(async()=>{if(!closed){service.close();storage.close();}setPaidCallFundingServices(null);server.closeAllConnections();await new Promise(r=>server.close(r));});
  const f={folder,cfg,admin,user,stranger,auth,store,requests,plans,modes,epochs,revoked,ledgerFile,speechFile,get guard(){return guard;},get storage(){return storage;},get service(){return service;},setSecret(v){currentSecret=v;},advance(ms){clock+=ms;},nextDay(){clock+=86400000;},switchArchive(){archiveVersion++;},limits(k){const policy=service.runtimePolicy(k),p=service.platformOverview(admin);return {id:'fixture-speech',version:'fixture-v1',scopeDailyLimitCny:policy.subsidy.dailyLimitCny,platformDailyLimitCny:p.dailyLimitCny,cooldownMs:policy.settings.cooldownMs};},document(name){return JSON.parse(storage.readText(name));},reopen(){service.close();storage.close();storage=createPaidCallStorage(ledgerFile);guard=createPaidCallGuard({storage,config:getConfig,now:()=>clock});service=build();},enable(k='group:101',modes=['platform','trial','byok'],limit=.1){let p=service.platformOverview(admin);if(!p.enabled)service.updatePlatform(admin,{expectedVersion:p.version,enabled:true,cooldownMs:1000,dailyLimitCny:1});const old=service.runtimePolicy(k);service.updateSubsidy(admin,{chatKey:k,expectedVersion:old.subsidy.version,enabled:true,allowedFundingModes:modes,dailyLimitCny:limit});service.updateSettings(k==='group:202'?admin:user,{chatKey:k,expectedVersion:old.settings.version,enabled:true});},call(k='group:101',options={}){return service.synthesize(k,{text:'你好，世界。',direct:true,...options});}};
  return f;
}

test('missing credentials, platform opt-in, resource subsidy and explicit request each deny before HTTP or ledger reservation',async t=>{
  const f=await fixture(t);f.setSecret(null);assert.equal(f.service.runtimePolicy('group:101').configured,false);
  assert.throws(()=>f.service.updatePlatform(f.admin,{expectedVersion:1,enabled:true}),{code:'SPEECH_NO_CREDENTIAL'});
  await assert.rejects(f.call(),{code:'SPEECH_NO_CREDENTIAL',dispatched:false});
  f.setSecret(secret);await assert.rejects(f.call(),{code:'SPEECH_PLATFORM_DISABLED'});
  f.enable();await assert.rejects(f.service.synthesize('group:101',{text:'你好'}),{code:'SPEECH_EXPLICIT_REQUEST_REQUIRED'});
  await assert.rejects(f.call('private:101'),{code:'SPEECH_CHAT_DISABLED'});
  assert.equal(f.requests.length,0);assert.equal(f.guard.records().length,0);
});

test('management uses real scope authority and CAS; ordinary users cannot raise subsidy, global limits or weaken safeguards',async t=>{
  const f=await fixture(t);f.enable();
  assert.throws(()=>f.service.settings(f.stranger,'group:101'),{code:'SPEECH_ACCESS_DENIED'});
  assert.throws(()=>f.service.settings({id:'admin',role:'admin'},'group:101'),{code:'SPEECH_UNAUTHENTICATED'});
  assert.throws(()=>f.service.updatePlatform(f.user,{expectedVersion:2,enabled:true}),{code:'SPEECH_ACCESS_DENIED'});
  assert.throws(()=>f.service.updateSubsidy(f.user,{chatKey:'group:101'}),{code:'SPEECH_ACCESS_DENIED'});
  for(const edit of [{maxChars:151},{cooldownMs:999}])assert.throws(()=>f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:1,enabled:true,...edit}),{code:'SPEECH_SETTINGS_INVALID'});
  const saved=f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:1,enabled:true,maxChars:50,cooldownMs:2000});assert.equal(saved.settings.maxChars,50);assert.equal(saved.settings.cooldownMs,2000);
  assert.throws(()=>f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:1,enabled:true}),{code:'SPEECH_VERSION_CONFLICT'});
  assert.equal(JSON.stringify(f.service.overview(f.user)).includes(secret.secretKey),false);
  assert.equal(JSON.stringify(f.service.overview(f.user)).includes('group:202'),false);
});

test('voice preferences save while unconfigured, inherit platform defaults, override per resource and invalidate old receipts',async t=>{
  const f=await fixture(t);f.setSecret(null);
  const saved=f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:0,enabled:false,voiceType:101004,speed:-.5,volume:2});assert.equal(saved.settings.voiceType,101004);assert.equal(saved.configured,false);assert.equal(saved.allowed,false);
  f.service.updateSubsidy(f.admin,{chatKey:'group:101',expectedVersion:0,enabled:true,allowedFundingModes:['platform'],dailyLimitCny:.1});
  assert.throws(()=>f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:1,enabled:true}),{code:'SPEECH_NO_CREDENTIAL'});
  f.setSecret(secret);f.enable();f.enable('private:101');
  const p=f.service.platformOverview(f.admin);f.service.updatePlatform(f.admin,{expectedVersion:p.version,voiceType:101055,speed:.5,volume:-1});
  assert.equal(f.service.runtimePolicy('private:101').settings.voiceType,101055);assert.equal(f.service.runtimePolicy('group:101').settings.voiceType,101004);
  const result=await f.call();assert.equal(f.requests.at(-1).body.VoiceType,101004);assert.equal(f.requests.at(-1).body.Speed,-.5);assert.equal(f.requests.at(-1).body.Volume,2);
  const s=f.service.runtimePolicy('group:101').settings;f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:s.version,enabled:true,voiceType:null,speed:null,volume:null});
  assert.equal(f.service.runtimePolicy('group:101').settings.voiceType,101055);assert.deepEqual(f.service.runtimePolicy('group:101').settings.overrides,{voiceType:null,speed:null,volume:null,autoVoicePercent:null});assert.throws(()=>f.service.assertCurrent(result.receipt),{code:'SPEECH_AUTHORIZATION_CHANGED'});
  f.advance(1001);const inherited=await f.call();assert.equal(inherited.estimatedCostCny,result.estimatedCostCny);assert.equal(f.requests.at(-1).body.VoiceType,101055);assert.equal(f.requests.at(-1).body.Speed,.5);assert.equal(f.requests.at(-1).body.Volume,-1);
  const old=f.service.runtimePolicy('group:101').policyVersion;f.reopen();assert.equal(f.service.runtimePolicy('group:101').policyVersion,old);assert.equal(f.service.runtimePolicy('group:101').voices.length,6);
});

test('invalid expensive voices, strings and nonfinite/out-of-range style values cannot change persisted settings or incur a request',async t=>{
  const f=await fixture(t);f.enable();const current=f.service.runtimePolicy('group:101');
  for(const patch of [{voiceType:402000},{voiceType:501001},{voiceType:'101001'},{speed:NaN},{speed:3},{speed:.001},{speed:'1'},{volume:6},{volume:Infinity},{volume:'2'}])assert.throws(()=>f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:current.settings.version,enabled:true,...patch}),{code:'SPEECH_VOICE_INVALID'});
  assert.equal(f.service.runtimePolicy('group:101').policyVersion,current.policyVersion);assert.equal(f.requests.length,0);assert.equal(f.guard.records().length,0);
  const platform=f.service.platformOverview(f.admin);for(const patch of [{voiceType:402000},{speed:NaN},{volume:null}])assert.throws(()=>f.service.updatePlatform(f.admin,{expectedVersion:platform.version,...patch}),{code:'SPEECH_SETTINGS_INVALID'});
});

test('automatic voice has a distinct trusted purpose, defaults to zero, inherits by scope and remains budget guarded',async t=>{
  const f=await fixture(t);f.enable('group:101');f.enable('private:101');
  await assert.rejects(f.call('group:101',{purpose:'automatic',automaticSelected:true,direct:false}),{code:'SPEECH_AUTOMATIC_DISABLED'});
  const platform=f.service.platformOverview(f.admin);f.service.updatePlatform(f.admin,{expectedVersion:platform.version,autoVoicePercent:10});assert.equal(f.service.runtimePolicy('group:101').settings.autoVoicePercent,10);
  await assert.rejects(f.call('group:101',{purpose:'automatic',direct:true}),{code:'SPEECH_EXPLICIT_REQUEST_REQUIRED'});
  await f.call('group:101',{purpose:'automatic',automaticSelected:true,direct:false});assert.equal(Object.values(f.guard.attributions()).at(-1).speechPurpose,'automatic');
  const old=f.service.runtimePolicy('private:101');for(const value of [-1,101,10.5,'10',NaN])assert.throws(()=>f.service.updateSettings(f.user,{chatKey:'private:101',expectedVersion:old.settings.version,enabled:true,autoVoicePercent:value}),{code:'SPEECH_SETTINGS_INVALID'});
  f.service.updateSettings(f.user,{chatKey:'private:101',expectedVersion:old.settings.version,enabled:true,autoVoicePercent:0});await assert.rejects(f.call('private:101',{purpose:'automatic',automaticSelected:true,direct:false}),{code:'SPEECH_AUTOMATIC_DISABLED'});
  await f.call('private:101');assert.equal(Object.values(f.guard.attributions()).at(-1).speechPurpose,'requested');
  f.advance(1001);const cfg=getConfig();cfg.productionBudget.overrides['group:101']=.0002;setRuntimeConfig(cfg);await assert.rejects(f.call('group:101',{purpose:'automatic',automaticSelected:true,direct:false}),{code:'SPEECH_ADMISSION_DENIED'});
  assert.equal(f.requests.length,2);f.reopen();assert.equal(f.service.runtimePolicy('group:101').settings.autoVoicePercent,10);assert.equal(f.service.runtimePolicy('private:101').settings.autoVoicePercent,0);
});

test('schema one settings upgrade atomically with unchanged consent/limits and default inherited voice, while unknown schemas refuse writes',async t=>{
  const f=await fixture(t);f.service.close();
  const db=new DatabaseSync(f.speechFile);db.exec('ALTER TABLE speech_scopes DROP COLUMN voice_type;ALTER TABLE speech_scopes DROP COLUMN speed;ALTER TABLE speech_scopes DROP COLUMN volume;ALTER TABLE speech_scopes DROP COLUMN auto_voice_percent;PRAGMA user_version=1');const old={version:8,enabled:false,maxChars:100,cooldownMs:2000,dailyLimitCny:.5};db.prepare("UPDATE speech_meta SET value_json=? WHERE name='platform'").run(JSON.stringify(old));db.prepare('INSERT INTO speech_scopes VALUES(?,?,?,?,?)').run('group:101',4,0,80,3000);db.close();
  const upgraded=createSpeechService({file:f.speechFile,auth:f.auth,store:f.store,config:getConfig,credentials:()=>secret,guard:()=>f.guard});
  const p=upgraded.platformOverview(f.admin);for(const [k,v]of Object.entries(old))assert.equal(p[k],v);assert.equal(p.voiceType,101001);assert.equal(p.autoVoicePercent,0);const row=upgraded.runtimePolicy('group:101');assert.equal(row.settings.version,4);assert.equal(row.settings.maxChars,80);assert.equal(row.settings.cooldownMs,3000);assert.deepEqual(row.settings.overrides,{voiceType:null,speed:null,volume:null,autoVoicePercent:null});upgraded.close();
  // Replace the closed service reference for fixture cleanup with a valid open handle.
  f.reopen();const check=new DatabaseSync(f.speechFile);assert.equal(check.prepare('PRAGMA user_version').get().user_version,3);check.exec('PRAGMA user_version=99');check.close();
  assert.throws(()=>createSpeechService({file:f.speechFile,auth:f.auth,config:getConfig,credentials:()=>secret}),{code:'SPEECH_STORAGE_INVALID'});
});

test('group/private and platform/BYOK use the same signed provider and shared ledger, with explicit independent TTS subsidy',async t=>{
  const f=await fixture(t);f.enable('group:101',['platform']);f.enable('private:101',['platform']);
  for(const key of ['group:101','private:101']){
    const result=await f.call(key);assert.equal(result.estimatedCostCny,.00018);assert.match(result.estimationBoundary,/免费资源包实际抵扣未同步/);assert.equal(f.service.assertCurrent(result.receipt),true);
    f.advance(1001);f.modes.set(key,'byok');assert.equal(f.service.runtimePolicy(key).allowed,false);await assert.rejects(f.call(key),{code:'SPEECH_SUBSIDY_REQUIRED'});
    const grant=f.service.runtimePolicy(key).subsidy;f.service.updateSubsidy(f.admin,{chatKey:key,expectedVersion:grant.version,enabled:true,allowedFundingModes:['platform','byok'],dailyLimitCny:grant.dailyLimitCny});
    const byok=await f.call(key);assert.equal(byok.estimatedCostCny,result.estimatedCostCny);assert.equal(byok.mime,result.mime);
  }
  assert.equal(f.requests.length,4);assert.ok(f.requests.every(r=>r.authorization.startsWith('TC3-HMAC-SHA256 Credential='+secret.secretId+'/')));
  assert.ok(f.requests.every(r=>!JSON.stringify(r).includes('fixture-user-llm-key')&&!JSON.stringify(r).includes('fixture-platform-llm-key')));
  assert.equal(f.guard.records({key:'group:101'}).length,2);assert.equal(f.guard.records({key:'private:101'}).length,2);
  assert.equal(f.guard.status('group:101').spentCny,.00036);assert.equal(f.guard.status('private:101').spentCny,.00036);
  assert.ok(Object.values(f.guard.attributions()).every(a=>a.kind==='speech'&&a.mode==='platform-speech'&&a.ownerId===null&&a.credentialRef===null&&a.estimated));
  assert.equal(Object.values(f.guard.attributions()).filter(a=>a.llmOwnerId==='user-a').length,2);
});

test('LLM 80 percent/100 percent/zero limit stop optional voice without a provider request',async t=>{
  const f=await fixture(t,{initialSpent:{'2026-10-23':{'group:101':.8,'private:101':1}}});f.enable('group:101');f.enable('private:101');
  await assert.rejects(f.call(),{code:'SPEECH_ADMISSION_DENIED',chargeOutcome:'not_sent'});await assert.rejects(f.call('private:101'),{code:'SPEECH_ADMISSION_DENIED'});
  const cfg=getConfig();cfg.productionBudget.overrides['group:101']=0;setRuntimeConfig(cfg);await assert.rejects(f.call(),{code:'SPEECH_ADMISSION_DENIED'});
  assert.equal(f.requests.length,0);assert.equal(f.guard.records().length,2);
});

test('concurrent independent chats reserve one shared speech subsidy total atomically, without leaking rejected holds',async t=>{
  const f=await fixture(t);f.enable('group:101');f.enable('private:101');const platform=f.service.platformOverview(f.admin);f.service.updatePlatform(f.admin,{expectedVersion:platform.version,dailyLimitCny:.005});
  const started=deferred(),gate=deferred();f.plans.push({started,wait:gate.promise});const first=f.call('group:101',{text:'中'.repeat(100)});await started.promise;
  await assert.rejects(f.call('private:101',{text:'中'.repeat(100)}),{code:'SPEECH_ADMISSION_DENIED'});assert.equal(f.requests.length,1);assert.equal(f.guard.records({key:'private:101'}).length,0);
  assert.equal(f.guard.serviceStatus('group:101',f.limits('group:101')).platform.reservedCny,.003);
  gate.resolve();await first;assert.equal(f.guard.serviceStatus('group:101',f.limits('group:101')).platform.spentCny,.003);
  assert.equal(f.guard.status('group:101').spentCny,.003);
});

test('only two synthesis allocations run at once; the third never dispatches, and unknown charges do not retain execution slots',async t=>{
  const f=await fixture(t);for(const key of ['group:101','private:101','group:202'])f.enable(key);
  const one=deferred(),two=deferred(),beganOne=deferred(),beganTwo=deferred();f.plans.push({started:beganOne,wait:one.promise,status:500},{started:beganTwo,wait:two.promise});
  const first=f.call('group:101');const firstOutcome=assert.rejects(first,{code:'SPEECH_PROVIDER_REJECTED',chargeOutcome:'unknown'});await beganOne.promise;
  const second=f.call('private:101');await beganTwo.promise;
  await assert.rejects(f.call('group:202'),{code:'SPEECH_BUSY',statusCode:429,dispatched:false});assert.equal(f.requests.length,2);assert.equal(f.guard.records({key:'group:202'}).length,0);
  one.resolve();await firstOutcome;assert.equal(f.guard.status('group:101').unknownReservations,1);
  await f.call('group:202');assert.equal(f.requests.length,3);two.resolve();await second;assert.equal(f.guard.status('group:101').unknownReservations,1);
});

test('scope subsidy cannot be enlarged by raising a BYOK LLM cap; persistent cooldown and operation identity prevent duplicate requests',async t=>{
  const f=await fixture(t);f.modes.set('group:101','byok');f.enable('group:101',['byok'],.005);
  await f.call('group:101',{text:'中'.repeat(100),operationId:'same-operation'});
  const cfg=getConfig();cfg.productionBudget.overrides['group:101']=100;setRuntimeConfig(cfg);f.advance(1001);
  await assert.rejects(f.call('group:101',{text:'中'.repeat(100)}),{code:'SPEECH_ADMISSION_DENIED'});
  await assert.rejects(f.call('group:101',{text:'中',operationId:'same-operation'}),{code:'SPEECH_ADMISSION_DENIED'});
  // A separate private scope has its own cooldown even with an identical numeric QQ.
  f.enable('private:101');await f.call('private:101');
  await assert.rejects(f.call('private:101'),{code:'SPEECH_ADMISSION_DENIED'});
  assert.equal(f.requests.length,2);assert.equal(f.guard.status('private:101').reservedCny,0);
});

test('pre-cancel has no hold; in-flight cancellation keeps unknown reservations in main/scope/platform/trial after restart and midnight',async t=>{
  const f=await fixture(t,{trial:true});f.enable('private:101',['trial']);const before=new AbortController();before.abort();await assert.rejects(f.call('private:101',{signal:before.signal}),{code:'SPEECH_CANCELLED',dispatched:false});assert.equal(f.guard.records().length,0);
  const controller=new AbortController(),started=deferred();f.plans.push({started,hang:true});const work=f.call('private:101',{signal:controller.signal});await started.promise;controller.abort();await assert.rejects(work,{code:'SPEECH_CANCELLED',chargeOutcome:'unknown'});
  for(const name of ['conversation-budget','speech-subsidy-budget','speech-platform-budget','platform-trial-budget'])assert.equal(f.document(name).records.at(-1).state,'unknown');
  f.nextDay();f.reopen();assert.equal(f.guard.status('private:101').spentCny,0);assert.equal(f.guard.status('private:101').reservedCny,.00018);assert.equal(f.guard.trialStatus().reservedCny,.00018);
  const status=f.guard.serviceStatus('private:101',f.limits('private:101'));assert.equal(status.scope.reservedCny,.00018);assert.equal(status.platform.reservedCny,.00018);assert.equal(status.platform.unknownReservations,1);
});

test('lost in-memory handles never release persisted not-yet-dispatched holds, including trial global holds',async t=>{
  const f=await fixture(t,{trial:true});f.enable('private:101',['trial']);
  await runWithPaidConversation('private:101',()=>f.guard.prepareService({service:'speech',operationId:'crashed-before-dispatch',amountCny:.003,assertAuthorized:()=>f.limits('private:101')}));
  f.nextDay();f.reopen();for(const name of ['conversation-budget','speech-subsidy-budget','speech-platform-budget','platform-trial-budget']){const rows=f.document(name).records;assert.equal(rows.at(-1).state,'reserved');assert.equal(rows.at(-1).amountMicros,3000);}
  assert.equal(f.guard.status('private:101').reservedCny,.003);assert.equal(f.guard.trialStatus().reservedCny,.003);assert.equal(f.requests.length,0);
});

test('trial global cap and same-chat concurrent cooldown are enforced by the same atomic admission path',async t=>{
  const f=await fixture(t,{trial:true});f.enable('private:101',['trial']);setPaidCallFundingServices({resolve:k=>({id:'trial:'+k,version:1,mode:'trial',ownerId:'user-a',endpoint:f.cfg.productionBudget.endpoint,model:'deepseek-flash',prices:f.cfg.productionBudget.prices,imageTokensPerImage:1024,scopeAuthorized:true}),policy:()=>({trial:{dailyLimitCny:.005,initialSpent:{}}})});
  const gate=deferred(),started=deferred();f.plans.push({started,wait:gate.promise});const pending=f.call('private:101',{text:'中'.repeat(100)});await started.promise;
  await assert.rejects(f.call('private:101',{text:'中'}),{code:'SPEECH_ADMISSION_DENIED'});assert.equal(f.requests.length,1);assert.equal(f.guard.trialStatus().reservedCny,.003);
  gate.resolve();await pending;f.advance(1001);await assert.rejects(f.call('private:101',{text:'中'.repeat(100)}),{code:'SPEECH_ADMISSION_DENIED'});assert.equal(f.guard.trialStatus().spentCny,.003);assert.equal(f.requests.length,1);
});

test('failed or timed-out synthesis is charged unknown conservatively, never retried or treated as free-package zero',async t=>{
  const f=await fixture(t);f.enable();f.plans.push({status:401,raw:JSON.stringify({secret:secret.secretKey})});
  await assert.rejects(f.call(),e=>e.code==='SPEECH_PROVIDER_REJECTED'&&e.chargeOutcome==='unknown'&&!String(e).includes(secret.secretKey));
  f.advance(1001);f.plans.push({hang:true});await assert.rejects(f.call(),{code:'SPEECH_TIMEOUT',chargeOutcome:'unknown'});
  assert.equal(f.requests.length,2);assert.equal(f.guard.status('group:101').reservedCny,.00036);assert.equal(f.guard.status('group:101').spentCny,0);
  assert.equal(f.guard.records().filter(r=>r.state==='released').length,0);
});

test('resource-close ABA, owner revocation, credential change and archive change after synthesis all suppress delivery but preserve synthesis estimate',async t=>{
  const f=await fixture(t);f.enable();
  const scenarios=[()=>{const s=f.service.runtimePolicy('group:101').settings;f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:s.version,enabled:false});f.service.updateSettings(f.user,{chatKey:'group:101',expectedVersion:s.version+1,enabled:true});},()=>{f.modes.set('group:101','byok');f.epochs.set('group:101',2);},()=>f.setSecret({...secret,secretKey:'fixture-replaced-secret-value'}),()=>f.switchArchive()];
  for(const change of scenarios){const gate=deferred(),started=deferred();f.plans.push({started,wait:gate.promise});const work=f.call();await started.promise;change();gate.resolve();await assert.rejects(work,e=>e.chargeOutcome==='settled'&&e.dispatched);assert.equal(f.guard.records().at(-1).state,'settled');f.advance(1001);}
  assert.equal(f.requests.length,4);assert.equal(f.guard.status('group:101').spentCny,.00072);assert.equal(f.guard.status('group:101').reservedCny,0);
});

test('receipt and persisted settings reject forged/corrupt state; credential files are private regular bounded JSON',async t=>{
  const f=await fixture(t);f.enable();const result=await f.call();assert.throws(()=>f.service.assertCurrent({...result.receipt}),{code:'SPEECH_RECEIPT_INVALID'});
  const file=path.join(f.folder,'credential.json');fs.writeFileSync(file,JSON.stringify(secret),{mode:0o600});assert.deepEqual(readSpeechCredential(file),secret);assert.equal(readSpeechCredential(path.join(f.folder,'absent.json')),null);
  fs.writeFileSync(file,'{malformed');assert.throws(()=>readSpeechCredential(file),{code:'SPEECH_CREDENTIAL_INVALID'});
  const db=new DatabaseSync(f.speechFile);db.prepare("UPDATE speech_meta SET value_json='null' WHERE name='platform'").run();db.close();assert.throws(()=>f.service.runtimePolicy('group:101'),{code:'SPEECH_STORAGE_INVALID'});
});

test('existing seed marker and 26 settled records are preserved byte-for-byte when enabling and using speech',async t=>{
  const f=await fixture(t,{initialSpent:{'2026-10-22':{'group:101':.123}}});
  for(let i=0;i<25;i++)await runWithPaidConversation('group:101',()=>{const token=f.guard.prepare({api:getConfig().api,body:{model:'deepseek-flash',stream:false,messages:[{role:'user',content:'fixture'}],max_tokens:1},platformCredential:getConfig().api.apiKey});f.guard.dispatch(token);f.guard.complete(token,{text:JSON.stringify({model:'deepseek-flash',usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})});});
  const before=f.guard.records(),marker=f.storage.readText('initial-spent-marker');assert.equal(before.length,26);f.enable();await f.call();
  assert.deepEqual(f.guard.records().slice(0,26),before);assert.equal(f.storage.readText('initial-spent-marker'),marker);assert.equal(f.guard.records().length,27);
  f.reopen();assert.deepEqual(f.guard.records().slice(0,26),before);assert.equal(f.service.runtimePolicy('group:101').allowed,true);
});
