// Real gateway/app/RBAC and the primary paid ledger; no cloud or QQ traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs} from './_harness.mjs';

test('speech usage crosses the real account gateway without billing or changing speech settings',async t=>{
 const root=makeDataDir('qq-speech-usage-app-'),publicOrigin='https://usage.example.test',nativeFetch=globalThis.fetch;
 const ob=createMockOneBotHttp(),ws=createMockOneBotWs(),obPort=await listen(ob.server),wsPort=await ws.ready();let cloud=0;
 globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.hostname==='tts.tencentcloudapi.com'){cloud++;return Promise.resolve(new Response(JSON.stringify({Response:{Error:{Code:'UnsupportedOperation.PkgExhausted',Message:'fixture-private-provider-message'}}}),{headers:{'content-type':'application/json'}}));}
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(Error('Fixture blocks external networking'));
  return nativeFetch(input,options);
 };
 const token='fixture-speech-usage-internal-value';
 writeConfig(root,{platform:{enabled:true,publicOrigin},ownerQQ:'999',api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-speech-usage-model-key',model:'deepseek-flash',vision:false},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`},server:{port:await freePort(),token},allow:{groups:['456'],private:['999']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{'group:456':{mode:'platform',enabled:true},'private:999':{mode:'platform',enabled:true}},outputCap:512,imageTokensPerImage:1024}});
 const {createApp}=await import('../src/app.js'),{createAdminGateway}=await import('../src/admin-gateway.js'),paid=await import('../src/paid-call-guard.js');
 const credential={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixture-speech-usage-identity',secretKey:'fixture-speech-usage-key-value'};
 let app,gateway;
 t.after(async()=>{if(gateway)await gateway.close();if(app)await app.stop();paid.closeProductionPaidCallGuard();await ws.close();ob.server.closeAllConnections?.();await new Promise(resolve=>ob.server.close(resolve));globalThis.fetch=nativeFetch;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-speech-usage-app-')));fs.rmSync(root,{recursive:true,force:true});});
 app=createApp({log(){},speechCredentials:()=>credential});await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});
 const appPort=await app.start();await waitFor(()=>app.onebot.connected,10000,'fixture OneBot connected');
 gateway=createAdminGateway({publicOrigin,platformFile:path.join(root,'platform.sqlite'),targetOrigin:`http://127.0.0.1:${appPort}`,consoleToken:token});await gateway.listen(await freePort());
 const request=(method,route,body,cookie='')=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:gateway.server.address().port,path:route,method,headers:{host:new URL(publicOrigin).host,origin:publicOrigin,cookie,...(body?{'content-type':'application/json'}:{})}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 const admin=(await request('POST','/api/auth/login',{username:'fixture_admin',password:'fixture-admin-pass-2026'})).cookie;
 const alice=(await request('POST','/api/auth/register',{username:'fixture_alice',password:'fixture-alice-pass-2026'})).cookie,bob=(await request('POST','/api/auth/register',{username:'fixture_bob',password:'fixture-bob-pass-2026'})).cookie;
 const principal=app.platformAuth.authenticate(admin),aliceId=app.platformAuth.authenticate(alice).id;app.platformAuth.store.grant(aliceId,'group:456');
 app.speechService.updatePlatform(principal,{expectedVersion:1,enabled:true,maxChars:120,cooldownMs:1000,dailyLimitCny:1});
 app.speechService.updateSubsidy(principal,{chatKey:'group:456',expectedVersion:0,enabled:true,allowedFundingModes:['platform'],dailyLimitCny:.1});
 app.speechService.updateSettings(principal,{chatKey:'group:456',expectedVersion:0,enabled:true});
 await assert.rejects(paid.runWithPaidConversation('group:456',()=>app.store.withArchive('group:456',()=>app.speechService.synthesize('group:456',{text:'你好呀',direct:true,operationId:'fixture-usage-one-attempt'}))),error=>error.code==='SPEECH_PROVIDER_REJECTED');
 app.speechService.updatePlatform(principal,{expectedVersion:2,enabled:false});
 const snapshot=()=>{
  const ledger=new DatabaseSync(path.join(root,'paid-calls.sqlite'),{readOnly:true}),speech=new DatabaseSync(path.join(root,'speech.sqlite'),{readOnly:true});
  try{return {ledger:ledger.prepare('SELECT name,body FROM paid_documents ORDER BY name').all(),speech:['speech_meta','speech_scopes','speech_subsidies'].map(name=>speech.prepare('SELECT * FROM '+name+' ORDER BY 1').all())};}
  finally{speech.close();ledger.close();}
 };
 const before=snapshot();
 await t.test('anonymous is denied and administrator counts one failed speech attempt, not its auxiliary holds',async()=>{
  assert.equal((await request('GET','/api/platform/speech/usage?days=7')).status,401);
  const result=await request('GET','/api/platform/speech/usage?days=7',null,admin);assert.equal(result.status,200);
  assert.equal(result.data.scope,'platform');assert.equal(result.data.totals.attempts,1);assert.equal(result.data.totals.unknown,1);assert.equal(result.data.totals.succeeded,0);
  assert.equal(result.data.totals.characters,3);assert.equal(result.data.totals.knownCharacters,3);assert.equal(result.data.totals.estimatedCny,0);assert.equal(result.data.totals.unknownCny,.00009);assert.equal(result.data.totals.reservedCny,.00009);
  assert.equal(result.data.conversations.length,1);assert.equal(result.data.daily.length,1);
  assert.doesNotMatch(JSON.stringify(result.data),/fixture-private-provider-message|fixture-speech-usage-key|你好呀|secretKey|SecretId/);
 });
 await t.test('ordinary totals and explicit resource reads obey fresh exact scope permissions',async()=>{
  const own=await request('GET','/api/platform/speech/usage?days=30',null,alice);assert.equal(own.status,200);assert.equal(own.data.scope,'authorized');assert.equal(own.data.totals.attempts,1);
  const scoped=await request('GET','/api/platform/speech/usage?chatKey=group:456&days=1',null,alice);assert.equal(scoped.status,200);assert.equal(scoped.data.totals.attempts,1);
  assert.equal((await request('GET','/api/platform/speech/usage?chatKey=private:456',null,alice)).status,403);
  const empty=await request('GET','/api/platform/speech/usage?days=7',null,bob);assert.equal(empty.status,200);assert.equal(empty.data.totals.attempts,0);assert.deepEqual(empty.data.conversations,[]);
  assert.equal((await request('GET','/api/platform/speech/usage?chatKey=group:456',null,bob)).status,403);
  for(const query of ['days=2','days=abc','days=7&days=30','ownerId=fixture','chatKey=group:456&chatKey=private:456'])assert.equal((await request('GET','/api/platform/speech/usage?'+query,null,admin)).status,400);
 });
 await t.test('revoking a resource invalidates the old login and a fresh login cannot read that scope',async()=>{
  const accounts=await request('GET','/api/platform/accounts',null,admin);
  const changed=await request('PUT','/api/platform/accounts',{id:aliceId,expectedVersion:accounts.data.version,conversationKeys:[]},admin);assert.equal(changed.status,200);
  assert.equal((await request('GET','/api/platform/speech/usage?chatKey=group:456',null,alice)).status,401);
  const fresh=(await request('POST','/api/auth/login',{username:'fixture_alice',password:'fixture-alice-pass-2026'})).cookie;
  assert.equal((await request('GET','/api/platform/speech/usage?chatKey=group:456',null,fresh)).status,403);
  const visible=await request('GET','/api/platform/speech/usage',null,fresh);assert.equal(visible.status,200);assert.equal(visible.data.totals.attempts,0);
 });
 await t.test('report reads preserve every charge, unknown reservation and speech setting without extra requests',()=>{
  assert.deepEqual(snapshot(),before);assert.equal(cloud,1);assert.equal(ob.state.sends.length,0);assert.equal(app.speechService.platformOverview(principal).enabled,false);
 });
});
