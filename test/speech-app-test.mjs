// Real gateway -> app -> Agent -> TC3 provider, with synthetic local HTTP/QQ only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs,createMockLLM} from './_harness.mjs';
test('Tencent speech uses one scoped Agent for group/private and platform/BYOK with explicit independent quota',async t=>{
 const root=makeDataDir('qq-speech-app-'),origin='https://speech.example.test',nativeFetch=globalThis.fetch;
 const onebot=createMockOneBotHttp(),ws=createMockOneBotWs(),llm=createMockLLM();
 const obPort=await listen(onebot.server),wsPort=await ws.ready(),llmPort=await listen(llm.server),speechCalls=[];
 let failProvider=false,credentialsReady=false;
 const credential={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixture-speech-identity',secretKey:'fixture-speech-secret-value'};
 const wave=Buffer.alloc(46);wave.write('RIFF');wave.writeUInt32LE(38,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(16000,24);wave.writeUInt32LE(32000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(2,40);
 globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(url.hostname==='tts.tencentcloudapi.com'){
   const body=JSON.parse(options.body);speechCalls.push({body,headers:options.headers});
   if(failProvider)return Promise.resolve(new Response('{"Response":{"Error":{"Code":"Fixture"}}}',{status:500}));
   return Promise.resolve(new Response(JSON.stringify({Response:{Audio:wave.toString('base64'),SessionId:body.SessionId,RequestId:'fixture-tts-request'}}),{headers:{'content-type':'application/json'}}));
  }
  if(url.origin==='https://api.deepseek.com')return nativeFetch(`http://127.0.0.1:${llmPort}/v1${url.pathname}`,options);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(Error('Fixture blocks external network'));
  return nativeFetch(input,options);
 };
 const token='fixture-internal-speech-control-value';
 writeConfig(root,{platform:{enabled:true,publicOrigin:origin},ownerQQ:'999',api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-platform-model-key',model:'deepseek-flash',vision:false,maxRounds:3,timeoutMs:5000},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`},server:{port:await freePort(),token},allow:{groups:['456'],private:['456']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,store:{contextSliderPos:5,historyCount:20},wakeDelayMs:40,drainDelayMs:50,maxConcurrentRuns:1,send:{minGapMs:1,maxGapMs:1,byLengthMs:0,maxPerMinute:1000,maxPerHour:10000,dedupeWindowMs:0},proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},speech:{credentialFile:path.join(root,'fixture-private-speech-credential.json'),timeoutMs:1000},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:10,overrides:{},initialSpent:{},funding:{'group:456':{mode:'platform',enabled:true},'private:456':{mode:'platform',enabled:true}},outputCap:512,imageTokensPerImage:1024}});
 const {createApp}=await import('../src/app.js'),{createAdminGateway}=await import('../src/admin-gateway.js'),{productionPaidCallGuard,closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js');
 let app,gateway;
 t.after(async()=>{if(gateway)await gateway.close();if(app)await app.stop();closeProductionPaidCallGuard();await ws.close();for(const server of [onebot.server,llm.server]){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}globalThis.fetch=nativeFetch;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-speech-app-')));fs.rmSync(root,{recursive:true,force:true});});
 app=createApp({log(){},speechCredentials:()=>credentialsReady?credential:null});await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});
 const port=await app.start();await waitFor(()=>app.onebot.connected,10000,'fake OneBot connected');
 gateway=createAdminGateway({publicOrigin:origin,platformFile:path.join(root,'platform.sqlite'),targetOrigin:`http://127.0.0.1:${port}`,consoleToken:token});await gateway.listen(await freePort());
 const request=(method,route,body,cookie='')=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:gateway.server.address().port,path:route,method,headers:{host:new URL(origin).host,origin,cookie,...(body?{'content-type':'application/json'}:{})}},res=>{let text='';res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 const admin=(await request('POST','/api/auth/login',{username:'fixture_admin',password:'fixture-admin-pass-2026'})).cookie;
 const user=(await request('POST','/api/auth/register',{username:'fixture_user',password:'fixture-user-pass-2026'})).cookie;
 const principal=app.platformAuth.authenticate(admin);
 await t.test('same-site RBAC, missing-Key readiness and no secret/path reflection through config',async()=>{
  assert.equal((await request('GET','/api/platform/speech/overview')).status,401);
  const p=(await request('GET','/api/platform/speech/platform',null,admin)).data;assert.equal(p.configured,false);assert.equal(p.enabled,false);
  assert.equal((await request('PUT','/api/platform/speech/platform',{expectedVersion:p.version,enabled:true},admin)).status,403);
  assert.equal((await request('PUT','/api/platform/speech/platform',{expectedVersion:p.version,enabled:true},user)).status,403);
  assert.equal((await request('GET','/api/platform/speech/settings?chatKey=group:456',null,user)).status,403);
  const config=(await request('GET','/api/config',null,admin)).data;
  assert.ok(!JSON.stringify(config).includes('fixture-private-speech-credential'));assert.equal(speechCalls.length,0);
 });
 credentialsReady=true;
 app.speechService.updatePlatform(principal,{expectedVersion:1,enabled:true,maxChars:120,cooldownMs:1000,dailyLimitCny:5});
 for(const key of ['group:456','private:456']){
  app.speechService.updateSubsidy(principal,{chatKey:key,expectedVersion:0,enabled:true,allowedFundingModes:['platform','byok'],dailyLimitCny:1});
  app.speechService.updateSettings(principal,{chatKey:key,expectedVersion:0,enabled:true,maxChars:80,cooldownMs:1000,voiceType:key.startsWith('group:')?101004:101055,speed:1,volume:-3});
 }
 const own=app.platformBusiness.saveCredential(principal,{name:'Fixture own model',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-byok-model-key',enabled:true}).credential;
 let mid=10000;
 async function run(key,text,{voice=true,requested=true,split=false}={}){
  const index=llm.state.requests.length;llm.state.script[index]={model:'deepseek-flash',toolCalls:[{name:voice?'send_voice':'send_message',args:voice?{text}:{messages:split?[text,'第二个短句。']:[text]}}]};llm.state.script[index+1]={model:'deepseek-flash',content:'done'};
  const [kind,id]=key.split(':');ws.push({post_type:'message',message_type:kind,...(kind==='group'?{group_id:Number(id)}:{}),user_id:456,self_id:888,message_id:++mid,time:Math.floor(Date.now()/1000),sender:{user_id:456,nickname:'Fixture caller'},message:[...(kind==='group'?[{type:'at',data:{qq:'888'}}]:[]),{type:'text',data:{text:(requested?'请用语音回复我 ':'晚上好 ')+mid}}]});
  await waitFor(()=>llm.state.requests.length>=index+2&&!app.orchestrator.runningChats.size,10000,'Agent speech turn completed');return llm.state.requests.slice(index,index+2);
 }
 await t.test('four real Agent combinations expose one voice tool and settle both model and voice without duplicate text',async()=>{
  for(const key of ['group:456','private:456'])for(const mode of ['platform','byok']){
   if(mode==='byok')app.platformBusiness.setFunding(principal,{chatKey:key,mode:'byok',credentialRef:own.id,expectedVersion:0});
   const before=speechCalls.length,sends=onebot.state.sends.length,rounds=await run(key,'测试短句 '+mode);
   assert.equal(speechCalls.length,before+1);assert.ok(rounds[0].tools.some(tool=>tool.function.name==='send_voice'));assert.equal(onebot.state.sends.length,sends+1);
   const outgoing=onebot.state.sends.at(-1);assert.ok(JSON.stringify(outgoing).includes('record'));assert.ok(!JSON.stringify(speechCalls.at(-1)).includes('fixture-byok-model-key'));
   assert.equal(speechCalls.at(-1).body.VoiceType,key.startsWith('group:')?101004:101055);assert.equal(speechCalls.at(-1).body.Speed,1);assert.equal(speechCalls.at(-1).body.Volume,-3);
   const usage=app.platformBusiness.usage(principal,{chatKey:key});assert.ok(usage.conversations.some(row=>row.amountCny>0));assert.match(usage.estimationBoundary,/语音字符.*免费资源包/);
  }
  const attribution=Object.values(productionPaidCallGuard().attributions()).filter(row=>row.kind==='speech');assert.equal(attribution.length,4);assert.ok(attribution.every(row=>row.mode==='platform-speech'));
 });
 await t.test('automatic probability goes through the same four real Agent combinations once for a multipart reply',async()=>{
  let draws=0;app.orchestrator.speechRandom=()=>{draws++;return .05;};
  for(const key of ['group:456','private:456']){
   app.speechService.updateSettings(principal,{chatKey:key,expectedVersion:1,enabled:true,autoVoicePercent:10});
   app.platformBusiness.setFunding(principal,{chatKey:key,mode:'platform',expectedVersion:1});
   for(const mode of ['platform','byok']){
    if(mode==='byok')app.platformBusiness.setFunding(principal,{chatKey:key,mode:'byok',credentialRef:own.id,expectedVersion:2});
    const before=speechCalls.length,sends=onebot.state.sends.length;
    await run(key,'自动回复 '+mode,{voice:false,requested:false,split:true});
    assert.equal(speechCalls.length,before+1);assert.equal(onebot.state.sends.length,sends+1);assert.match(speechCalls.at(-1).body.Text,/\n第二个短句/);
   }
  }
  assert.equal(draws,4);
 });
 await t.test('known pre-QQ provider failure falls back to the same sentence while preserving unknown charge',async()=>{
  failProvider=true;const before=onebot.state.sends.length;
  await run('group:456','只发送这句文字');assert.equal(onebot.state.sends.length,before+1);assert.match(JSON.stringify(onebot.state.sends.at(-1)),/只发送这句文字/);assert.doesNotMatch(JSON.stringify(onebot.state.sends.at(-1)),/'record'/);
  assert.ok(productionPaidCallGuard().records({key:'group:456'}).some(row=>row.state==='unknown'));
 });
});
