// Complete synthetic cloud workflow. No real QQ, remote account service or paid API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {makeDataDir,writeConfig,freePort,listen,waitFor,sleep,createMockOneBotHttp,createMockOneBotWs,createMockLLM} from './_harness.mjs';

test('standalone account workspace reaches the shared Agent through the real gateway and trusted OneBot',async t=>{
 const root=makeDataDir('qq-agent-platform-app-'),publicOrigin='https://workspace.example.test',nativeFetch=globalThis.fetch;
 const ob=createMockOneBotHttp(),ws=createMockOneBotWs(),llm=createMockLLM();
 let groupRole='admin',botInGroup=true;
 const originalHandler=ob.server.listeners('request')[0];ob.server.removeAllListeners('request');
 ob.server.on('request',async(req,res)=>{
  const action=req.url.slice(1);
  if(!['get_group_list','get_group_member_info'].includes(action))return originalHandler(req,res);
  let text='';for await(const part of req)text+=part;const body=JSON.parse(text||'{}');ob.state.calls.push(action);
  const data=action==='get_group_list'?(botInGroup?[{group_id:789,group_name:'Fixture managed group'}]:[]):{group_id:body.group_id,user_id:body.user_id,role:groupRole,nickname:'Fixture manager'};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data}));
 });
 const obPort=await listen(ob.server),wsPort=await ws.ready(),llmPort=await listen(llm.server),headers=[];
 llm.server.prependListener('request',req=>{headers.push(req.headers.authorization);});
 globalThis.fetch=(input,init)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.origin==='https://api.deepseek.com')return nativeFetch(`http://127.0.0.1:${llmPort}/v1${url.pathname}`,init);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(Error('Synthetic fixture forbids external networking'));
  return nativeFetch(input,init);
 };
 const token='fixture-internal-control-value-00000001';
 writeConfig(root,{
  platform:{enabled:true,publicOrigin},ownerQQ:'999',
  api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-platform-key',model:'deepseek-flash',vision:false,maxRounds:3,timeoutMs:5000},
  snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`,accessToken:''},
  server:{port:await freePort(),token},persona:{botName:'Fixture bot',roleText:'Fixture default persona'},
  allow:{groups:['456'],private:['999']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,
  store:{contextSliderPos:5,historyCount:40,maxMessagesPerChat:0},wakeDelayMs:80,drainDelayMs:100,maxConcurrentRuns:1,
  send:{minGapMs:50,maxGapMs:50,byLengthMs:0,maxPerMinute:1000,maxPerHour:10000,dedupeWindowMs:0},
  proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},
  productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{'group:456':{mode:'platform',enabled:true},'private:999':{mode:'platform',enabled:true}},outputCap:512,imageTokensPerImage:1024}
 });
 const {createApp}=await import('../src/app.js'),{createAdminGateway}=await import('../src/admin-gateway.js'),{productionPaidCallGuard,closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js');
 let app,gateway;
 t.after(async()=>{if(gateway)await gateway.close();if(app)await app.stop();closeProductionPaidCallGuard();await ws.close();for(const server of [ob.server,llm.server]){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}globalThis.fetch=nativeFetch;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-agent-platform-app-')));fs.rmSync(root,{recursive:true,force:true});});
 app=createApp({log:()=>{}});await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});
 const appPort=await app.start();await waitFor(()=>app.onebot.connected&&ws.state.client?.readyState===1,10000,'synthetic OneBot ready');
 gateway=createAdminGateway({publicOrigin,platformFile:path.join(root,'platform.sqlite'),targetOrigin:`http://127.0.0.1:${appPort}`,consoleToken:token});await gateway.listen(await freePort());
 const gatewayPort=gateway.server.address().port;
 const request=(method,route,body,cookie='',extra={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:gatewayPort,path:route,method,headers:{host:new URL(publicOrigin).host,origin:publicOrigin,accept:'application/json',...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{}),...extra}},res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>{const text=Buffer.concat(chunks).toString();let data;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,data,cookie:res.headers['set-cookie']?.[0]?.split(';')[0],headers:res.headers});});});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 const ok=async(method,route,body,cookie)=>{const result=await request(method,route,body,cookie);assert.equal(result.status,200,JSON.stringify(result.data));return result;};
 const admin=(await ok('POST','/api/auth/login',{username:'fixture_admin',password:'fixture-admin-pass-2026'})).cookie;
 const alice=(await ok('POST','/api/auth/register',{username:'fixture_alice',password:'fixture-alice-pass-2026'})).cookie;
 const bob=(await ok('POST','/api/auth/register',{username:'fixture_bob',password:'fixture-bob-pass-2026'})).cookie;
 let mid=90000;
 const push=(kind,id,text)=>ws.push({post_type:'message',message_type:kind,...(kind==='group'?{group_id:Number(id)}:{}),user_id:777,self_id:888,message_id:++mid,time:Math.floor(Date.now()/1000),sender:{user_id:777,nickname:'Fixture manager'},message:[...(kind==='group'?[{type:'at',data:{qq:'888'}}]:[]),{type:'text',data:{text}}]});
 await t.test('same-site registration cannot grant roles; anonymous and ordinary native console requests are denied',async()=>{
  assert.equal((await request('POST','/api/auth/register',{username:'fixture_injected',password:'fixture-secret-2026',role:'admin'})).status,400);
  assert.equal((await request('GET','/api/platform/overview')).status,401);
  assert.equal((await request('GET','/api/sessions',null,alice)).status,403);
  assert.equal((await request('GET','/console.html',null,alice)).status,403);
  assert.equal((await request('GET','/api/platform/accounts',null,alice)).status,403);
  assert.equal((await request('GET','/help.html')).status,200);
  assert.equal((await request('GET','/login.html')).status,200);
  const overview=(await ok('GET','/api/platform/overview',null,alice)).data;assert.deepEqual(overview.scopes,[]);
 });
 await t.test('web binding is completed only by trusted private QQ input, outside old allowlists and model history',async()=>{
  const proof=(await ok('POST','/api/platform/binding/issue',{qq:'777'},alice)).data;
  push('private','777',proof.command);
  await waitFor(()=>app.platformAuth.status(app.platformAuth.authenticate(alice)).binding?.qq==='777',5000,'binding consumed');
  assert.equal(llm.state.requests.length,0);assert.equal(app.sessions.listSummaries().length,0);
  assert.ok(ob.state.sends.some(row=>row.action==='send_private_msg'));
  const scopes=(await ok('GET','/api/platform/overview',null,alice)).data.scopes;
  assert.ok(scopes.some(row=>row.chatKey==='private:777'));assert.equal(app.platformBusiness.runtimeAllowed('private:777'),false);
 });
 await t.test('group claim traverses gateway to app and verifies bot membership plus real QQ group manager role',async()=>{
  await ok('POST','/api/platform/groups/claim',{chatKey:'group:789'},alice);
  assert.ok(ob.state.calls.includes('get_group_list'));assert.ok(ob.state.calls.includes('get_group_member_info'));
  const scopes=(await ok('GET','/api/platform/overview',null,alice)).data.scopes;assert.ok(scopes.some(row=>row.chatKey==='group:789'));
  assert.equal(app.platformBusiness.runtimeAllowed('group:789'),false);
  assert.equal((await request('GET','/api/platform/personas?chatKey=group:789',null,bob)).status,403);
 });
 let personaA,personaB,archiveA;
 await t.test('normal user saves immutable versions; applying A/B/A resumes the original archive through HTTP',async()=>{
  personaA=(await ok('POST','/api/platform/personas',{chatKey:'group:789',name:'Fixture A',content:'Fixture original A'},alice)).data.persona;
  assert.equal(app.store.archiveSelection('group:789'),null);
  archiveA=(await ok('POST','/api/platform/archives',{chatKey:'group:789',personaId:personaA.id,expectedSelectionVersion:0},alice)).data.selected;
  personaB=(await ok('PUT','/api/platform/personas',{chatKey:'group:789',id:personaA.id,expectedVersion:personaA.version,name:'Fixture B',content:'Fixture new B'},alice)).data.persona;
  assert.equal(app.store.archiveSelection('group:789').archiveId,archiveA.archiveId);
  const selectedB=(await ok('POST','/api/platform/archives',{chatKey:'group:789',personaId:personaB.id,expectedSelectionVersion:archiveA.selectionVersion},alice)).data.selected;
  const resumed=(await ok('POST','/api/platform/archives',{chatKey:'group:789',personaId:personaA.id,expectedSelectionVersion:selectedB.selectionVersion},alice)).data;
  assert.equal(resumed.reused,true);assert.equal(resumed.selected.archiveId,archiveA.archiveId);assert.ok(resumed.selected.selectionVersion>selectedB.selectionVersion);
 });
 let credential;
 await t.test('saving a personal Key does not grant resources or enable spending until explicit funding selection',async()=>{
  credential=(await ok('PUT','/api/platform/credentials',{name:'Fixture personal model',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-personal-api-key',enabled:true},alice)).data.credential;
  assert.equal(app.platformBusiness.runtimeAllowed('group:789'),false);
  assert.equal(JSON.stringify((await ok('GET','/api/platform/credentials',null,alice)).data).includes('fixture-personal-api-key'),false);
  assert.equal((await ok('GET','/api/platform/credentials',null,bob)).data.credentials.length,0);
  await ok('PUT','/api/platform/funding',{chatKey:'group:789',mode:'byok',credentialRef:credential.id,expectedVersion:0},alice);
  assert.equal(app.platformBusiness.runtimeAllowed('group:789'),true);
 });
 await t.test('a new authorized group outside static allowlists uses the original full Agent and personal-key budget pipeline',async()=>{
  const sends=ob.state.sends.length;
  llm.state.script.push({model:'deepseek-flash',toolCalls:[{name:'send_message',args:{messages:['FIXTURE_SHARED_ENGINE_REPLY']}},{name:'finish',args:{summary:'Fixture complete'}}]});
  push('group','789','Fixture explicit request');
  await waitFor(()=>ob.state.sends.length>sends,15000,'new group shared engine reply');
  await waitFor(()=>app.sessions.listSummaries().some(row=>!['running','waiting'].includes(row.status)),5000,'run settled');
  assert.ok(llm.state.requests.length>0);assert.ok(headers.every(value=>value==='Bearer fixture-personal-api-key'));
  assert.match(JSON.stringify(llm.state.requests[0].messages),/Fixture original A/);
  assert.ok(productionPaidCallGuard().records({key:'group:789'}).some(row=>row.state==='settled'));
  const usage=(await ok('GET','/api/platform/usage?chatKey=group:789',null,alice)).data;assert.ok(usage.conversations.some(row=>row.amountCny>0));
  assert.equal((await request('GET','/api/platform/usage?chatKey=group:789',null,bob)).status,403);
 });
 await t.test('native live updates omit provider raw while explicit administrator JSON mode can retrieve it',async()=>{
  const sample=app.sessions.create({chatKey:'group:789',trigger:'Fixture live projection'});
  sample.messages.push({role:'assistant',content:'Fixture visible content',raw:{payload:'x'.repeat(2*1024*1024)}});
  sample.inputMessages=[{role:'user',content:'Fixture original input'}];app.sessions.update(sample.id);
  const detail=(await ok('GET','/api/sessions/'+sample.id,null,admin)).data;
  assert.equal(detail.rawAvailable,true);assert.equal(detail.messages[0].raw,undefined);assert.equal(detail.inputMessages,undefined);assert.equal(detail.systemPrompt,undefined);assert.equal(detail.userPrompt,undefined);
  const full=(await ok('GET','/api/sessions/'+sample.id+'/raw',null,admin)).data;
  assert.equal(full.messages[0].raw.payload.length,2*1024*1024);
  assert.equal((await request('GET','/api/sessions/'+sample.id+'/raw',null,alice)).status,403);
  const first=(await ok('GET','/api/sessions?limit=1',null,admin)).data;
  assert.equal(first.sessions.length,1);assert.ok(first.total>=2);assert.ok(first.nextCursor);
  const second=(await ok('GET','/api/sessions?limit=1&before='+encodeURIComponent(first.nextCursor),null,admin)).data;
  assert.equal(second.sessions.length,1);assert.notEqual(first.sessions[0].id,second.sessions[0].id);
  let stream,client;
  try{
   const event=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Fixture SSE update timeout')),2500);
    client=http.get({hostname:'127.0.0.1',port:gatewayPort,path:'/api/events',headers:{host:new URL(publicOrigin).host,origin:publicOrigin,cookie:admin}},response=>{
     assert.equal(response.statusCode,200);stream=response;let buffer='';let sent=false;
     response.on('data',chunk=>{buffer+=chunk.toString();if(!sent&&buffer.includes('event: hello')){sent=true;app.emit('session-update',{sessionId:sample.id});}
      const match=/event: session-update\ndata: ([^\n]+)/.exec(buffer);if(match){clearTimeout(timeout);resolve({payload:JSON.parse(match[1]),bytes:Buffer.byteLength(match[1])});}
     });response.on('error',reject);
    });client.on('error',reject);
   });
   assert.equal(event.payload.messages[0].raw,undefined);assert.equal(event.payload.inputMessages,undefined);assert.equal(event.payload.messages[0].content,'Fixture visible content');assert.ok(event.bytes<2048);
  }finally{stream?.destroy();client?.destroy();app.sessions.finish(sample.id,'done');}
 });
 await t.test('verified personal private chat outside static allowlists uses the same engine only after explicit funding',async()=>{
  await ok('PUT','/api/platform/funding',{chatKey:'private:777',mode:'byok',credentialRef:credential.id,expectedVersion:0},alice);
  const sends=ob.state.sends.length;
  llm.state.script.push({model:'deepseek-flash',toolCalls:[{name:'send_message',args:{messages:['FIXTURE_PRIVATE_SHARED_REPLY']}},{name:'finish',args:{summary:'Private fixture complete'}}]});
  push('private','777','Fixture authorized private request');
  await waitFor(()=>ob.state.sends.length>sends,15000,'private shared engine reply');
  assert.ok(ob.state.sends.slice(sends).some(row=>row.action==='send_private_msg'));
  await waitFor(()=>productionPaidCallGuard().records({key:'private:777'}).some(row=>row.state==='settled'),5000,'private budget settled');
 });
 await t.test('a trusted bot-removal notice blocks even statically funded group input until bot rejoins',async()=>{
  ws.push({post_type:'notice',notice_type:'group_decrease',group_id:456,user_id:888});await sleep(50);
  const before=llm.state.requests.length;push('group','456','Fixture removed bot must not answer');await sleep(250);
  assert.equal(llm.state.requests.length,before);assert.equal(app.store.has?.('group:456')??false,false);
  ws.push({post_type:'notice',notice_type:'group_increase',group_id:456,user_id:888});
 });
 await t.test('trusted group role removal immediately stops automatic authority and new-group admission',async()=>{
  groupRole='member';ws.push({post_type:'notice',notice_type:'group_admin',sub_type:'unset',group_id:789,user_id:777});
  await waitFor(()=>!app.platformBusiness.runtimeAllowed('group:789'),5000,'group authority invalidated');
  const before=llm.state.requests.length;push('group','789','Should never call provider');await sleep(250);assert.equal(llm.state.requests.length,before);
  assert.equal((await request('POST','/api/platform/groups/claim',{chatKey:'group:789'},alice)).status,403);
 });
 await t.test('local accounts work without any old auth service; changing password revokes current login',async()=>{
  assert.equal((await ok('GET','/api/auth/status',null,alice)).data.authenticated,true);
  await ok('POST','/api/auth/password',{currentPassword:'fixture-alice-pass-2026',newPassword:'fixture-alice-new-pass-2026'},alice);
  assert.equal((await request('GET','/api/platform/overview',null,alice)).status,401);
  assert.equal((await ok('POST','/api/auth/login',{username:'fixture_alice',password:'fixture-alice-new-pass-2026'})).data.authenticated,true);
  const accounts=(await ok('GET','/api/platform/accounts',null,admin)).data;assert.equal(accounts.accounts.length,3);
 });
});
