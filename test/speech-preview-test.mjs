// Explicit management preview crosses the real gateway and shared speech ledger.
// The only provider is a synthetic local fetch; previews never send QQ or LLM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs} from './_harness.mjs';
import {TENCENT_SPEECH_VOICES} from '../src/speech-provider.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('authenticated previews bind scope, draft voice, consent, quote and current authority without changing saved settings',async t=>{
 const root=makeDataDir('qq-speech-preview-'),publicOrigin='https://preview.example.test',nativeFetch=globalThis.fetch;
 const ob=createMockOneBotHttp(),ws=createMockOneBotWs(),obPort=await listen(ob.server),wsPort=await ws.ready(),calls=[],plans=[];let modelCalls=0;
 const wav=Buffer.alloc(46);wav.write('RIFF');wav.write('WAVE',8);
 globalThis.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.hostname==='tts.tencentcloudapi.com'){
   const body=JSON.parse(options.body),plan=plans.shift()||{};calls.push(body);plan.started?.resolve();
   if(plan.hang)return await new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>{plan.aborted?.();reject(Error('fixture aborted'));},{once:true});});
   if(plan.wait)await plan.wait;
   if(plan.fail)return new Response(JSON.stringify({Response:{Error:{Code:'ResourceUnavailable',Message:'fixture-private-provider-body'}}}),{status:500});
   return new Response(JSON.stringify({Response:{Audio:wav.toString('base64'),SessionId:body.SessionId,RequestId:'fixture-private-request'}}),{headers:{'content-type':'application/json'}});
  }
  if(url.hostname==='api.deepseek.com'){modelCalls++;throw Error('Fixture forbids model requests');}
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Fixture forbids external networking');
  return nativeFetch(input,options);
 };
 const token='fixture-preview-internal-token';
 writeConfig(root,{platform:{enabled:true,publicOrigin},ownerQQ:'999',api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-preview-model-key',model:'deepseek-flash',vision:false},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`},server:{port:await freePort(),token},allow:{groups:['456'],private:['999']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},speech:{timeoutMs:1000},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{'group:456':{mode:'platform',enabled:true},'private:999':{mode:'platform',enabled:true}},outputCap:512,imageTokensPerImage:1024}});
 const {createApp}=await import('../src/app.js'),{createAdminGateway}=await import('../src/admin-gateway.js'),paid=await import('../src/paid-call-guard.js');
 const credential={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixture-preview-identity',secretKey:'fixture-preview-secret-key-value'};
 let app,gateway;
 t.after(async()=>{if(gateway)await gateway.close();if(app)await app.stop();paid.closeProductionPaidCallGuard();await ws.close();ob.server.closeAllConnections?.();await new Promise(resolve=>ob.server.close(resolve));globalThis.fetch=nativeFetch;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-speech-preview-')));fs.rmSync(root,{recursive:true,force:true});});
 app=createApp({log(){},speechCredentials:()=>credential});await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});
 const appPort=await app.start();await waitFor(()=>app.onebot.connected,10000,'fixture OneBot connected');
 gateway=createAdminGateway({publicOrigin,platformFile:path.join(root,'platform.sqlite'),targetOrigin:`http://127.0.0.1:${appPort}`,consoleToken:token});await gateway.listen(await freePort());
 const request=(method,route,body,cookie='',{onRequest}={})=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:gateway.server.address().port,path:route,method,headers:{host:new URL(publicOrigin).host,origin:publicOrigin,cookie,...(body?{'content-type':'application/json'}:{})}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}));});req.on('error',reject);onRequest?.(req);req.end(body?JSON.stringify(body):undefined);});
 const admin=(await request('POST','/api/auth/login',{username:'fixture_admin',password:'fixture-admin-pass-2026'})).cookie;
 const alice=(await request('POST','/api/auth/register',{username:'fixture_alice',password:'fixture-alice-pass-2026'})).cookie,bob=(await request('POST','/api/auth/register',{username:'fixture_bob',password:'fixture-bob-pass-2026'})).cookie;
 const principal=app.platformAuth.authenticate(admin),aliceId=app.platformAuth.authenticate(alice).id;app.platformAuth.store.grant(aliceId,'group:456');
 app.speechService.updatePlatform(principal,{expectedVersion:1,enabled:true,maxChars:120,cooldownMs:1000,dailyLimitCny:1});
 for(const chatKey of ['group:456','private:999']){app.speechService.updateSubsidy(principal,{chatKey,expectedVersion:0,enabled:true,allowedFundingModes:['platform','byok'],dailyLimitCny:.1});app.speechService.updateSettings(principal,{chatKey,expectedVersion:0,enabled:true});}
 const voice=category=>TENCENT_SPEECH_VOICES.find(v=>v.category===category),input=(chatKey,category='supernatural')=>({chatKey,voiceType:voice(category).voiceType,expectedPolicyVersion:app.speechService.runtimePolicy(chatKey).policyVersion});
 const preview=(body,cookie=alice)=>request('POST','/api/platform/speech/preview',body,cookie);
 const saved=()=>JSON.stringify(app.speechService.overview(principal));
 const before=saved();
 await t.test('anonymous, foreign scope, malformed parameters, unknown voice and stale version deny before synthesis',async()=>{
  assert.equal((await preview(input('group:456'),'')).status,401);assert.equal((await preview(input('group:456'),bob)).status,403);
  assert.equal((await preview(input('private:456'))).status,403);
  for(const patch of [{voiceType:987654321},{text:'injected arbitrary text'},{rateCnyPer10k:0},{endpoint:'https://example.test'},{expectedPolicyVersion:'0'.repeat(64)}]){const result=await preview({...input('group:456'),...patch});assert.ok([400,409].includes(result.status),JSON.stringify(result));}
  assert.equal(calls.length,0);
 });
 await t.test('ordinary manager can preview an unsaved expensive voice at its exact shared-budget price without saving or sending',async()=>{
  const result=await preview(input('group:456'));assert.equal(result.status,200);assert.deepEqual(Object.keys(result.data).sort(),['audioBase64','characters','estimated','estimatedCostCny','mime','rateCnyPer10k'].sort());
  assert.equal(result.data.mime,'audio/wav');assert.equal(result.data.audioBase64,wav.toString('base64'));assert.equal(result.data.estimated,true);assert.equal(result.data.rateCnyPer10k,6.5);
  const count=app.speechService.runtimePolicy('group:456').previewCharacters;assert.equal(result.data.characters,count);assert.equal(result.data.estimatedCostCny,count*650/1e6);
  assert.equal(calls.at(-1).VoiceType,voice('supernatural').voiceType);assert.equal(calls.at(-1).Text.length,count);
  assert.equal(paid.productionPaidCallGuard().status('group:456').spentCny,result.data.estimatedCostCny);
  const attribution=Object.values(paid.productionPaidCallGuard().attributions()).at(-1);assert.equal(attribution.speechPurpose,'preview');assert.equal(attribution.voiceType,voice('supernatural').voiceType);
  assert.equal(saved(),before);assert.equal(ob.state.sends.length,0);assert.equal(modelCalls,0);assert.doesNotMatch(JSON.stringify(result.data),/receipt|RequestId|requestId|transcript|secretKey|fixture-private/);
 });
 await t.test('preview shares persistent speech cooldown and platform/BYOK private execution instead of a free alternate path',async()=>{
  const denied=await preview(input('group:456'));assert.equal(denied.status,403);assert.equal(calls.length,1);
  const own=app.platformBusiness.saveCredential(principal,{name:'Fixture private model',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-preview-byok-model-key',enabled:true}).credential;
  app.platformBusiness.setFunding(principal,{chatKey:'private:999',mode:'byok',credentialRef:own.id,expectedVersion:0});
  const result=await preview(input('private:999','large-model'),admin);assert.equal(result.status,200);assert.equal(result.data.rateCnyPer10k,1.2);assert.equal(result.data.estimatedCostCny,result.data.characters*120/1e6);assert.equal(calls.length,2);
  assert.equal(Object.values(paid.productionPaidCallGuard().attributions()).at(-1).llmFundingMode,'byok');assert.equal(ob.state.sends.length,0);assert.equal(modelCalls,0);
 });
 await t.test('supplier failure retains the expensive quote as unknown without response or credential leakage',async()=>{
  await new Promise(r=>setTimeout(r,1100));plans.push({fail:true});const result=await preview(input('group:456'));assert.equal(result.status,403);assert.equal(calls.length,3);
  assert.doesNotMatch(JSON.stringify(result.data),/fixture-private|fixture-preview-secret|audioBase64|secretKey/);
  const row=paid.productionPaidCallGuard().records({key:'group:456'}).at(-1);assert.equal(row.state,'unknown');assert.equal(row.amountCny,app.speechService.runtimePolicy('group:456').previewCharacters*650/1e6);
 });
 await t.test('an account losing its scope during synthesis receives no audio while the actual synthesis estimate remains settled',async()=>{
  await new Promise(r=>setTimeout(r,1100));const started=deferred(),gate=deferred();plans.push({started,wait:gate.promise});const pending=preview(input('group:456'));await started.promise;
  const accounts=await request('GET','/api/platform/accounts',null,admin);assert.equal((await request('PUT','/api/platform/accounts',{id:aliceId,expectedVersion:accounts.data.version,conversationKeys:[]},admin)).status,200);
  gate.resolve();const result=await pending;assert.ok([401,403].includes(result.status));assert.equal(result.data.audioBase64,undefined);assert.equal(paid.productionPaidCallGuard().records({key:'group:456'}).at(-1).state,'settled');
 });
 await t.test('logging out an active preview session suppresses its audio without undoing a completed synthesis charge',async()=>{
  const temporary=(await request('POST','/api/auth/login',{username:'fixture_admin',password:'fixture-admin-pass-2026'})).cookie;
  const started=deferred(),gate=deferred();plans.push({started,wait:gate.promise});const pending=preview(input('private:999'),temporary);await started.promise;
  assert.equal((await request('POST','/api/auth/logout',{},temporary)).status,200);gate.resolve();const result=await pending;assert.equal(result.status,401);assert.equal(result.data.audioBase64,undefined);assert.equal(paid.productionPaidCallGuard().records({key:'private:999'}).at(-1).state,'settled');
 });
 await t.test('a disconnected preview cancels the bounded provider request and conservatively retains its dispatched charge',async()=>{
  await new Promise(r=>setTimeout(r,1100));const started=deferred();let cancelledAt=null;plans.push({started,hang:true,aborted(){cancelledAt=Date.now();}});let connection;const pending=request('POST','/api/platform/speech/preview',input('private:999'),admin,{onRequest(req){connection=req;}});const rejected=assert.rejects(pending);await started.promise;const disconnectedAt=Date.now();connection.destroy();await rejected;
  await waitFor(()=>cancelledAt!==null,600,'gateway propagated abort before the 1000ms provider timeout');assert.ok(cancelledAt-disconnectedAt<600);
  await waitFor(()=>paid.productionPaidCallGuard().records({key:'private:999'}).at(-1).state==='unknown',3000,'cancelled preview charge retained');
  assert.equal(ob.state.sends.length,0);assert.equal(modelCalls,0);
 });
});
