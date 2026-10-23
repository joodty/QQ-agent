// Real app/gateway payload and permission checks with local synthetic QQ only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs} from './_harness.mjs';

test('lean workspace navigation omits bodies and repeated catalogues while retaining fresh account and resource permissions',async t=>{
 const root=makeDataDir('qq-platform-lean-'),publicOrigin='https://lean.example.test',nativeFetch=globalThis.fetch;
 const ob=createMockOneBotHttp(),ws=createMockOneBotWs(),obPort=await listen(ob.server),wsPort=await ws.ready();let paidRequests=0;
 globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)){if(['api.deepseek.com','tts.tencentcloudapi.com'].includes(url.hostname))paidRequests++;return Promise.reject(Error('Fixture forbids external requests'));}return nativeFetch(input,options);};
 const token='fixture-lean-internal-token';
 writeConfig(root,{platform:{enabled:true,publicOrigin},ownerQQ:'999',api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-lean-model-key',model:'deepseek-flash',vision:false},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`},server:{port:await freePort(),token},allow:{groups:['456','789'],private:['999']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{'group:456':{mode:'platform',enabled:true},'group:789':{mode:'platform',enabled:true},'private:999':{mode:'platform',enabled:true}},outputCap:512,imageTokensPerImage:1024}});
 const {createApp}=await import('../src/app.js'),{createAdminGateway}=await import('../src/admin-gateway.js'),paid=await import('../src/paid-call-guard.js');let app,gateway;
 t.after(async()=>{if(gateway)await gateway.close();if(app)await app.stop();paid.closeProductionPaidCallGuard();await ws.close();ob.server.closeAllConnections?.();await new Promise(resolve=>ob.server.close(resolve));globalThis.fetch=nativeFetch;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-platform-lean-')));fs.rmSync(root,{recursive:true,force:true});});
 app=createApp({log(){},speechCredentials:()=>null});await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});
 const appPort=await app.start();await waitFor(()=>app.onebot.connected,10000,'fixture OneBot connected');gateway=createAdminGateway({publicOrigin,platformFile:path.join(root,'platform.sqlite'),targetOrigin:`http://127.0.0.1:${appPort}`,consoleToken:token});await gateway.listen(await freePort());
 const request=(method,route,body,cookie='')=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:gateway.server.address().port,path:route,method,headers:{host:new URL(publicOrigin).host,origin:publicOrigin,cookie,...(body?{'content-type':'application/json'}:{})}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw),bytes:Buffer.byteLength(raw),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 const admin=(await request('POST','/api/auth/login',{username:'fixture_admin',password:'fixture-admin-pass-2026'})).cookie,alice=(await request('POST','/api/auth/register',{username:'fixture_alice',password:'fixture-alice-pass-2026'})).cookie;
 const principal=app.platformAuth.authenticate(admin),alicePrincipal=app.platformAuth.authenticate(alice);app.platformAuth.store.grant(alicePrincipal.id,'group:456');
 for(const p of [principal,alicePrincipal])app.platformBusiness.saveCredential(p,{name:'Fixture private configuration',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-owner-private-key',enabled:true});
 const persona=app.store.archives.createPersona({name:'Fixture selected role',content:'fixture-private-persona-body-'+('x'.repeat(200000)),history:[{version:1,content:'fixture-private-role-history-'+('y'.repeat(200000))}]});
 app.store.archives.createArchive({chatKey:'group:456',personaId:persona.id,expectedSelectionVersion:0});
 // Initialize the same unchanged budget snapshots that the pre-existing full
 // overview reads, then compare subsequent lightweight GETs byte-for-byte.
 await request('GET','/api/platform/overview',null,admin);await request('GET','/api/platform/speech/overview',null,admin);
 const snapshot=()=>{const ledger=new DatabaseSync(path.join(root,'paid-calls.sqlite'),{readOnly:true}),speech=new DatabaseSync(path.join(root,'speech.sqlite'),{readOnly:true});try{return {ledger:ledger.prepare('SELECT name,body FROM paid_documents ORDER BY name').all(),speech:['speech_meta','speech_scopes','speech_subsidies'].map(table=>speech.prepare('SELECT * FROM '+table+' ORDER BY 1').all())};}finally{speech.close();ledger.close();}};
 const before=snapshot();
 await t.test('anonymous callers remain denied on each lean account endpoint',async()=>{
  for(const route of ['/api/platform/overview?summary=1','/api/platform/speech/overview?compact=1','/api/platform/speech/settings?chatKey=group:456&compact=1'])assert.equal((await request('GET',route)).status,401);
 });
 await t.test('summary preserves account/scopes/selection/budgets and counts only the current account credentials without prompt bodies',async()=>{
  const full=await request('GET','/api/platform/overview',null,alice),lean=await request('GET','/api/platform/overview?summary=1',null,alice);assert.equal(full.status,200);assert.equal(lean.status,200);
  assert.equal(lean.data.accountId,alicePrincipal.id);assert.equal(lean.data.credentialCount,1);assert.equal(lean.data.role,'user');assert.deepEqual(lean.data.providers,full.data.providers);assert.deepEqual(lean.data.bot,full.data.bot);assert.equal(full.data.accountId,undefined);
  assert.deepEqual(lean.data.scopes.map(s=>s.chatKey),['group:456']);const old=full.data.scopes[0],current=lean.data.scopes[0];
  assert.deepEqual(current.archives,old.archives);assert.deepEqual(current.budget,old.budget);assert.deepEqual(current.funding,old.funding);assert.equal(current.name,old.name);assert.equal(current.selected.archiveId,old.selected.archiveId);assert.equal(current.selected.selectionVersion,old.selected.selectionVersion);assert.deepEqual(current.selected.persona,{id:persona.id,name:persona.name,version:1});
  assert.equal(current.personaOptions,undefined);assert.doesNotMatch(JSON.stringify(lean.data),/fixture-private-persona-body|fixture-private-role-history|fixture-owner-private-key|private:999|group:789/);
  assert.ok(lean.bytes<full.bytes/10);assert.ok(lean.bytes<24000);assert.ok(full.bytes>200000);
 });
 await t.test('summary never invokes selected prompt, persona collection or history-body readers',async()=>{
  const archives=app.store.archives,originals=Object.fromEntries(['active','personas','readChat'].map(name=>[name,archives[name]]));let bodyReads=0;
  for(const name of Object.keys(originals))archives[name]=()=>{bodyReads++;throw Error('Fixture forbids full body reads during summary');};
  try {const result=await request('GET','/api/platform/overview?summary=1',null,alice);assert.equal(result.status,200);assert.equal(result.data.scopes[0].selected.persona.id,persona.id);assert.equal(bodyReads,0);}finally{Object.assign(archives,originals);}
 });
 await t.test('compact speech overview retains platform fields and references one immutable catalogue without enumerating chat policies',async()=>{
  const full=await request('GET','/api/platform/speech/overview',null,admin);let enumerations=0;const original=app.platformAuth.listScopes;
  app.platformAuth.listScopes=function(...args){enumerations++;return original.apply(this,args);};let lean;
  try {lean=await request('GET','/api/platform/speech/overview?compact=1',null,admin);}finally{app.platformAuth.listScopes=original;}
  assert.equal(lean.status,200);assert.equal(enumerations,0);assert.equal(lean.data.conversations,undefined);assert.equal(lean.data.platform.voices,undefined);const {voiceCatalog,...settings}=lean.data.platform,{voices,...originalSettings}=full.data.platform;assert.deepEqual(settings,originalSettings);assert.ok(voices.length>6);
  assert.match(voiceCatalog.version,/^[a-f0-9]{64}$/);assert.equal(voiceCatalog.count,voices.length);assert.equal(voiceCatalog.url,'/assets/speech-voices.'+voiceCatalog.version+'.json');assert.ok(lean.bytes<full.bytes/5);
 });
 await t.test('compact single-chat settings retain readiness, policy version and controls after the same ensureAccess check',async()=>{
  const full=await request('GET','/api/platform/speech/settings?chatKey=group:456',null,alice),lean=await request('GET','/api/platform/speech/settings?chatKey=group:456&compact=1',null,alice);assert.equal(full.status,200);assert.equal(lean.status,200);
  const {voiceCatalog,...settings}=lean.data,{voices,...old}=full.data;assert.deepEqual(settings,old);assert.equal(voiceCatalog.count,voices.length);assert.equal(settings.previewCharacters,15);assert.equal(typeof settings.policyVersion,'string');assert.equal(typeof settings.rateCnyPer10k,'number');assert.ok(lean.bytes<full.bytes/3);
  for(const key of ['group:789','private:456'])assert.equal((await request('GET','/api/platform/speech/settings?chatKey='+key+'&compact=1',null,alice)).status,403);
 });
 await t.test('invalid lightweight flags fail rather than selecting an ambiguous response shape',async()=>{
  for(const route of ['/api/platform/overview?summary=0','/api/platform/overview?summary=1&summary=1','/api/platform/speech/overview?compact=0','/api/platform/speech/settings?chatKey=group:456&compact=1&compact=1'])assert.equal((await request('GET',route,null,alice)).status,400);
 });
 await t.test('revocation invalidates the old login and a new login immediately loses the private resource',async()=>{
  const accounts=await request('GET','/api/platform/accounts',null,admin);assert.equal((await request('PUT','/api/platform/accounts',{id:alicePrincipal.id,expectedVersion:accounts.data.version,conversationKeys:[]},admin)).status,200);
  assert.equal((await request('GET','/api/platform/overview?summary=1',null,alice)).status,401);
  const fresh=(await request('POST','/api/auth/login',{username:'fixture_alice',password:'fixture-alice-pass-2026'})).cookie;
  assert.deepEqual((await request('GET','/api/platform/overview?summary=1',null,fresh)).data.scopes,[]);assert.equal((await request('GET','/api/platform/speech/settings?chatKey=group:456&compact=1',null,fresh)).status,403);
 });
 await t.test('lean and full reads preserve every ledger row and speech configuration without provider or QQ sends',()=>{assert.deepEqual(snapshot(),before);assert.equal(paidRequests,0);assert.equal(ob.state.sends.length,0);});
});
