// Full public gateway/account/app path, exclusively synthetic QQ and isolated data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs} from './_harness.mjs';
const deferred=()=>{let resolve;return {promise:new Promise(done=>{resolve=done;}),resolve:value=>resolve(value)};};

test('manual account messages share QQ queues and history without using a model or payment authority',async t=>{
 const root=makeDataDir('qq-manual-messages-app-'),publicOrigin='https://messages.example.test',ob=createMockOneBotHttp(),ws=createMockOneBotWs(),obPort=await listen(ob.server),wsPort=await ws.ready(),nativeFetch=globalThis.fetch;
 let paidCalls=0,attempts=0,gate=null,mode='normal';
 globalThis.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(['api.deepseek.com','tts.tencentcloudapi.com'].includes(url.hostname)){paidCalls++;throw Error('Fixture blocks paid services');}
  if(url.hostname==='127.0.0.1'&&Number(url.port)===obPort&&/^\/send_(group|private)_msg$/.test(url.pathname)){
   attempts++;if(mode==='unknown')throw Object.assign(Error('Fixture timeout after possible dispatch'),{name:'TimeoutError'});
   if(gate){const current=gate;current.started.resolve();await current.wait.promise;}
  }
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Fixture forbids external network');return nativeFetch(input,options);
 };
 const token='fixture-manual-message-internal-token';
 writeConfig(root,{platform:{enabled:true,publicOrigin},ownerQQ:'999',api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-manual-message-model-key',model:'deepseek-flash',vision:false},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`},server:{port:await freePort(),token},allow:{groups:['456','789'],private:['456','777','999']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},send:{maxPerMinute:1000,maxPerHour:10000,dedupeWindowMs:0},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{},outputCap:512,imageTokensPerImage:1024}});
 const {createApp}=await import('../src/app.js'),{createAdminGateway}=await import('../src/admin-gateway.js'),paid=await import('../src/paid-call-guard.js');let app,gateway;
 const start=async()=>{app=createApp({log(){}});if(!app.platformAuth.status(null).configured)await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});const port=await app.start();await waitFor(()=>app.onebot.connected,10000,'mock QQ connected');gateway=createAdminGateway({publicOrigin,platformFile:path.join(root,'platform.sqlite'),targetOrigin:`http://127.0.0.1:${port}`,consoleToken:token});await gateway.listen(await freePort());};
 const stop=async()=>{if(gateway){await gateway.close();gateway=null;}if(app){await app.stop();app=null;}paid.closeProductionPaidCallGuard();};
 t.after(async()=>{gate?.wait.resolve();await stop();await ws.close();ob.server.closeAllConnections?.();await new Promise(resolve=>ob.server.close(resolve));globalThis.fetch=nativeFetch;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-manual-messages-app-')));fs.rmSync(root,{recursive:true,force:true});});
 const request=(method,route,body,cookie='')=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:gateway.server.address().port,path:route,method,headers:{host:new URL(publicOrigin).host,origin:publicOrigin,cookie,...(body?{'content-type':'application/json'}:{})}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 const send=(cookie,chatKey,text,extra={})=>request('POST','/api/platform/messages/send',{chatKey,text,requestId:crypto.randomUUID(),...extra},cookie),history=(cookie,key,extra='')=>request('GET','/api/platform/messages?chatKey='+encodeURIComponent(key)+extra,null,cookie);
 await start();const initialCall=app.onebot.call.bind(app.onebot);app.onebot.call=(action,params,timeoutMs)=>{if(/^send_(group|private)_msg$/.test(action))assert.equal(timeoutMs,10000);return initialCall(action,params,timeoutMs);};
 const admin=(await request('POST','/api/auth/login',{username:'fixture_admin',password:'fixture-admin-pass-2026'})).cookie,user=(await request('POST','/api/auth/register',{username:'fixture_user',password:'fixture-user-pass-2026'})).cookie;
 const person=app.platformAuth.authenticate(user),adminPrincipal=app.platformAuth.authenticate(admin);app.platformAuth.store.grant(person.id,'group:456');app.platformAuth.store.grant(person.id,'private:456');const binding=app.platformAuth.issueBinding(person,{qq:'777'});assert.equal(app.platformAuth.consumeBinding({private:true,qq:'777',text:binding.command}).ok,true);
 await t.test('targets use current account scopes and names/history reads do not manufacture empty conversations',async()=>{
  assert.equal((await request('GET','/api/platform/messages/targets')).status,401);
  const targets=await request('GET','/api/platform/messages/targets',null,user);assert.equal(targets.status,200);assert.equal(targets.data.broadcastAllowed,false);assert.equal(targets.data.connected,true);assert.deepEqual(targets.data.targets.map(row=>row.chatKey),['group:456','private:456','private:777']);
  assert.equal(targets.data.maxTargets,20);assert.equal(targets.data.maxChars,2000);
  assert.deepEqual((await history(admin,'private:999')).data.messages,[]);assert.equal(app.store.chats.size,0);assert.deepEqual(app.store.archives.list(),[]);
 });
 await t.test('ordinary group, own private and explicitly granted private messages send literally while unfunded and record legacy history',async()=>{
  const text='**原样文本** [CQ:at,qq=all]\n第二行';
  for(const key of ['group:456','private:456','private:777']){const response=await send(user,key,text);assert.equal(response.status,200);assert.equal(response.data.status,'sent');assert.equal(response.data.historyRecorded,true);const saved=(await history(user,key)).data;assert.equal(saved.archiveId,null);assert.equal(saved.messages.at(-1).text,text);assert.equal(saved.messages.at(-1).self,true);}
  assert.equal(ob.state.sends.length,3);for(const sent of ob.state.sends){assert.equal(sent.body.message.length,1);assert.equal(sent.body.message[0].type,'text');assert.ok(!sent.body.message[0].data.text.includes('[CQ:'));assert.match(sent.body.message[0].data.text,/\*\*原样文本\*\*/);}
  assert.equal(paidCalls,0);assert.equal(paid.productionPaidCallGuard().records().length,0);assert.deepEqual(app.getConfig().productionBudget.funding,{});
  await assert.rejects(app.orchestrator.sender?.sendTextBatch?.('group:456',['AI must not bypass funding'])||app.sender.sendTextBatch('group:456',['AI must not bypass funding']));
  assert.throws(()=>app.sender.sendManualText('group:456','No capability',{guard:()=>true,beforeDispatch(){}}),/人工发送未获授权/);
 });
 await t.test('ungranted, unknown and denied resources cannot be sent, and all broadcast prechecks finish before any send',async()=>{
  const before=attempts;assert.equal((await send(user,'private:999','No permission')).status,403);assert.equal((await send(admin,'private:123456789','Unknown target')).status,403);
  assert.equal((await request('POST','/api/platform/messages/broadcast',{chatKeys:['group:456'],text:'No broadcast authority',requestId:crypto.randomUUID()},user)).status,403);
  for(const keys of [[],['group:456','private:123456789'],['group:456','group:456'],Array.from({length:21},(_,i)=>'group:'+(900+i))])assert.ok([400,403].includes((await request('POST','/api/platform/messages/broadcast',{chatKeys:keys,text:'Precheck',requestId:crypto.randomUUID()},admin)).status));
  app.updateConfig({deny:{groups:[],private:['456']}});assert.equal((await send(admin,'private:456','Denied target')).status,403);assert.ok(!(await request('GET','/api/platform/messages/targets',null,admin)).data.targets.some(row=>row.chatKey==='private:456'));app.updateConfig({deny:{groups:[],private:[]}});
  assert.equal((await send(admin,'group:456','a'.repeat(2001))).status,400);assert.equal(attempts,before);
 });
 await t.test('same request ID singleflights concurrent posts, safely replays outcomes and rejects a changed payload',async()=>{
  gate={started:deferred(),wait:deferred()};const id=crypto.randomUUID(),before=attempts,body={chatKey:'group:456',text:'Idempotent queued message',requestId:id};const first=request('POST','/api/platform/messages/send',body,user);await gate.started.promise;
  const pending=await request('GET','/api/platform/messages/result?requestId='+id,null,user);assert.equal(pending.data.status,'pending');assert.equal(pending.data.complete,false);
  const second=request('POST','/api/platform/messages/send',body,user);assert.equal((await request('POST','/api/platform/messages/send',{...body,text:'Different payload'},user)).status,409);
  gate.wait.resolve();gate=null;const responses=await Promise.all([first,second]);assert.ok(responses.every(response=>response.status===200&&response.data.status==='sent'));assert.ok(responses.some(response=>response.data.replayed));assert.equal(attempts,before+1);
  assert.equal((await request('GET','/api/platform/messages/result?requestId='+id,null,admin)).status,404);
 });
 await t.test('administrator broadcast supports groups and private resources with individual results in serial order',async()=>{
  const before=ob.state.sends.length,id=crypto.randomUUID(),body={chatKeys:['group:789','private:999'],text:'Administrator notice',requestId:id};const sent=await request('POST','/api/platform/messages/broadcast',body,admin);assert.equal(sent.status,200);assert.deepEqual(sent.data.results.map(row=>[row.chatKey,row.status]),[['group:789','sent'],['private:999','sent']]);assert.equal(sent.data.complete,true);assert.deepEqual(ob.state.sends.slice(before).map(row=>row.action),['send_group_msg','send_private_msg']);
  assert.equal((await request('POST','/api/platform/messages/broadcast',body,admin)).data.replayed,true);assert.equal(ob.state.sends.length,before+2);
 });
 await t.test('typed and legacy text normalize to the same idempotent single-send and broadcast task',async()=>{
  let before=attempts;const requestId=crypto.randomUUID(),message={type:'text',text:'Canonical single message'};
  const typed=await request('POST','/api/platform/messages/send',{chatKey:'private:999',message,requestId},admin);assert.equal(typed.data.status,'sent');
  const legacy=await request('POST','/api/platform/messages/send',{chatKey:'private:999',text:message.text,requestId},admin);assert.equal(legacy.status,200);assert.equal(legacy.data.replayed,true);assert.equal(attempts,before+1);
  before=attempts;const broadcastId=crypto.randomUUID(),chatKeys=['group:789','private:999'],text='Canonical broadcast message';
  assert.equal((await request('POST','/api/platform/messages/broadcast',{chatKeys,text,requestId:broadcastId},admin)).status,200);
  const replay=await request('POST','/api/platform/messages/broadcast',{chatKeys,message:{text,type:'text'},requestId:broadcastId},admin);assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);assert.equal(attempts,before+2);
  assert.equal((await request('POST','/api/platform/messages/send',{chatKey:'private:999',message:{type:'text',text:'Changed canonical text'},requestId},admin)).status,409);
 });
 await t.test('unsupported types, mixed envelopes and unvalidated text fields never reach QQ or reserve a request',async()=>{
  const before=attempts;
  for(const payload of [{message:{type:'audio',url:'https://example.invalid/audio.wav'}},{message:{type:'image',url:'https://example.invalid/image.png'}},{message:{type:'toString',text:'Unknown inherited registry key'}},{text:'Ambiguous',message:{type:'text',text:'Ambiguous'}},{message:{type:'text',text:'No segments',segments:[{type:'at',data:{qq:'all'}}]}},{message:{type:'text',text:'x'.repeat(2001)}},{}]){
   const requestId=crypto.randomUUID(),response=await request('POST','/api/platform/messages/send',{chatKey:'private:999',requestId,...payload},admin);assert.equal(response.status,400);assert.equal((await request('GET','/api/platform/messages/result?requestId='+requestId,null,admin)).status,404);
   if(payload.message?.type&&!['text'].includes(payload.message.type))assert.match(response.data.error,/目前仅支持文字消息/);
  }
  const unsupported=await request('POST','/api/platform/messages/broadcast',{chatKeys:['group:789'],message:{type:'audio',url:'https://example.invalid/audio.wav'},requestId:crypto.randomUUID()},admin);assert.equal(unsupported.status,400);assert.equal(attempts,before);assert.equal(paidCalls,0);
 });
 await t.test('uncertain QQ outcomes remain unknown without retries, stop later broadcast targets, and survive restart',async()=>{
  mode='unknown';const id=crypto.randomUUID(),before=attempts,body={chatKeys:['group:789','private:999'],text:'Unknown outcome notice',requestId:id};const response=await request('POST','/api/platform/messages/broadcast',body,admin);assert.equal(response.status,200);assert.deepEqual(response.data.results.map(row=>row.status),['unknown','failed']);assert.equal(attempts,before+1);assert.match(response.data.results[0].error,/勿直接重发/);mode='normal';
  assert.equal((await request('POST','/api/platform/messages/broadcast',body,admin)).data.results[0].status,'unknown');assert.equal(attempts,before+1);
  await stop();await start();const saved=await request('GET','/api/platform/messages/result?requestId='+id,null,admin);assert.equal(saved.status,200);assert.equal(saved.data.results[0].status,'unknown');assert.equal(attempts,before+1);
 });
 await t.test('revocation while one message is in QQ prevents the next queued message but records the accepted first message',async()=>{
  gate={started:deferred(),wait:deferred()};const id=crypto.randomUUID(),first=send(user,'group:456','In-flight before revocation',{requestId:id});await gate.started.promise;const secondId=crypto.randomUUID(),second=send(user,'group:456','Queued after revocation',{requestId:secondId});await waitFor(()=>app.sender.pendingSends.size>=2,2000,'second manual send queued');
  const currentAdmin=app.platformAuth.authenticate(admin),currentPerson=app.platformAuth.authenticate(user);app.platformAuth.updateAccount(currentAdmin,{id:currentPerson.id,conversationKeys:['private:456'],expectedVersion:app.platformAuth.store.version()});const before=attempts;gate.wait.resolve();gate=null;
  for(const response of await Promise.all([first,second]))assert.ok([401,403].includes(response.status));assert.equal(attempts,before);assert.match((await history(admin,'group:456')).data.messages.at(-1).text,/In-flight before revocation/);
  const db=new DatabaseSync(path.join(root,'manual-messages.sqlite'),{readOnly:true});assert.equal(db.prepare('SELECT status FROM manual_results WHERE request_id=?').get(secondId).status,'failed');db.close();
 });
 await t.test('a switched archive receives only its own sends; an accepted in-flight send is recorded against the origin',async()=>{
  const principal=app.platformAuth.authenticate(admin),chatKey='group:789',a=app.platformBusiness.createPersona(principal,{chatKey,name:'Manual A',content:'Fixture A'}).persona,b=app.platformBusiness.createPersona(principal,{chatKey,name:'Manual B',content:'Fixture B'}).persona;
  const origin=app.platformBusiness.createArchive(principal,{chatKey,personaId:a.id,expectedSelectionVersion:0}).selected;
  gate={started:deferred(),wait:deferred()};const first=send(admin,chatKey,'Captured origin message',{expectedSelectionVersion:origin.selectionVersion});await gate.started.promise;const next=app.platformBusiness.createArchive(principal,{chatKey,personaId:b.id,expectedSelectionVersion:origin.selectionVersion}).selected;gate.wait.resolve();gate=null;assert.equal((await first).data.status,'sent');
  assert.equal((await history(admin,chatKey)).data.messages.some(row=>row.text==='Captured origin message'),false);assert.equal((await history(admin,chatKey,'&archiveId='+encodeURIComponent(origin.archiveId))).data.messages.at(-1).text,'Captured origin message');
  const before=attempts,stale=await send(admin,chatKey,'Stale draft',{expectedSelectionVersion:origin.selectionVersion});assert.equal(stale.data.status,'failed');assert.equal(attempts,before);assert.equal(app.store.captureArchive(chatKey).selectionVersion,next.selectionVersion);
 });
 await t.test('manual messages obey the common QQ rate limiter and allow-all still requires a known authorized target',async()=>{
  app.updateConfig({allow:{groups:['456','789','444'],private:['456','777','999']},send:{maxPerMinute:1}});
  assert.equal((await send(admin,'group:444','One rate-limited message')).data.status,'sent');const before=attempts;assert.equal((await send(admin,'group:444','A second rate-limited message')).data.status,'failed');assert.equal(attempts,before);
  app.updateConfig({allow:{groups:[],private:[]},allowAllWhenEmpty:true,send:{maxPerMinute:1000}});const targets=(await request('GET','/api/platform/messages/targets',null,admin)).data;assert.ok(targets.targets.some(row=>row.chatKey==='group:444'));assert.equal((await send(admin,'private:123456789','Still not a known resource')).status,403);
  app.updateConfig({deny:{groups:['444'],private:[]}});assert.ok(!(await request('GET','/api/platform/messages/targets',null,admin)).data.targets.some(row=>row.chatKey==='group:444'));
  app.updateConfig({allow:{groups:['456','789','444'],private:['456','777','999']},allowAllWhenEmpty:false,deny:{groups:[],private:[]}});
 });
 await t.test('shutdown cancels queued sends, records the one in flight, and startup never resumes pending durable requests',async()=>{
  gate={started:deferred(),wait:deferred()};const id=crypto.randomUUID(),first=send(admin,'private:999','Accepted before shutdown',{requestId:id});await gate.started.promise;const queuedId=crypto.randomUUID(),second=send(admin,'private:999','Queued before shutdown',{requestId:queuedId});await waitFor(()=>app.sender.pendingSends.size>=2,2000,'manual queue waiting before shutdown');const before=attempts;
  const stopping=app.stop();gate.wait.resolve();gate=null;for(const response of await Promise.all([first,second]))assert.equal(response.status,503);await stopping;app=null;await gateway.close();gateway=null;paid.closeProductionPaidCallGuard();assert.equal(attempts,before);
  const db=new DatabaseSync(path.join(root,'manual-messages.sqlite'));assert.equal(db.prepare('SELECT status FROM manual_results WHERE request_id=?').get(id).status,'sent');assert.equal(db.prepare('SELECT status FROM manual_results WHERE request_id=?').get(queuedId).status,'failed');
  const dispatchedId=crypto.randomUUID(),unstartedId=crypto.randomUUID();for(const [requestId,status]of [[dispatchedId,'dispatching'],[unstartedId,'queued']]){db.prepare('INSERT INTO manual_requests VALUES(?,?,?,?,?)').run(adminPrincipal.id,requestId,'0'.repeat(64),'send',Date.now());db.prepare('INSERT INTO manual_results(user_id,request_id,ordinal,chat_key,status) VALUES(?,?,?,?,?)').run(adminPrincipal.id,requestId,0,'private:999',status);}db.close();
  await start();assert.equal((await request('GET','/api/platform/messages/result?requestId='+dispatchedId,null,admin)).data.status,'unknown');assert.equal((await request('GET','/api/platform/messages/result?requestId='+unstartedId,null,admin)).data.status,'failed');assert.equal(attempts,before);
 });
 await t.test('a corrupt optional receipt database is retained while the main app and histories remain available',async()=>{
  await stop();const file=path.join(root,'manual-messages.sqlite'),bytes=Buffer.from('Fixture-corrupt-manual-receipts');fs.writeFileSync(file,bytes);await start();assert.equal((await request('GET','/api/platform/overview?summary=1',null,admin)).status,200);assert.equal((await request('GET','/api/platform/messages/targets',null,admin)).status,503);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(paidCalls,0);assert.equal(paid.productionPaidCallGuard().records().length,0);
 });
});
