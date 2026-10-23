import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs,createMockLLM} from './_harness.mjs';

test('trusted QQ input auto-replies through the original Agent after whitelist admission or binding without choosing payment',async t=>{
 const root=makeDataDir('qq-default-funding-app-'),ob=createMockOneBotHttp(),ws=createMockOneBotWs(),llm=createMockLLM(),native=globalThis.fetch;
 const obPort=await listen(ob.server),wsPort=await ws.ready(),llmPort=await listen(llm.server),headers=[];
 llm.server.prependListener('request',req=>headers.push(req.headers.authorization));
 globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.origin==='https://api.deepseek.com')return native('http://127.0.0.1:'+llmPort+'/v1'+url.pathname,options);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(Error('Fixture forbids external calls'));return native(input,options);};
 writeConfig(root,{platform:{enabled:true,publicOrigin:'https://defaults.example.test'},ownerQQ:'999',api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-platform-auto-key',model:'deepseek-flash',vision:false,maxRounds:3,timeoutMs:5000},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`},server:{port:await freePort(),token:'fixture-auto-funding-internal-token'},allow:{groups:['606'],private:['606']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,persona:{botName:'Fixture bot',roleText:'Fixture role'},store:{contextSliderPos:100},wakeDelayMs:30,drainDelayMs:30,send:{minGapMs:20,maxGapMs:20,byLengthMs:0,maxPerMinute:1000,maxPerHour:10000,dedupeWindowMs:0},proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},productionBudget:{enabled:true,defaultPlatformFunding:true,defaultFundingVersion:1,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:.1,overrides:{},initialSpent:{},funding:{},outputCap:512,imageTokensPerImage:1024}});
 const {createApp}=await import('../src/app.js'),paid=await import('../src/paid-call-guard.js');let app;
 t.after(async()=>{if(app)await app.stop();paid.closeProductionPaidCallGuard();await ws.close();for(const server of [ob.server,llm.server]){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}globalThis.fetch=native;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-default-funding-app-')));fs.rmSync(root,{recursive:true,force:true});});
 app=createApp({log(){}});await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});await app.start();await waitFor(()=>app.onebot.connected&&ws.state.client?.readyState===1);
 let mid=70000;
 const push=(kind,id,text)=>ws.push({post_type:'message',message_type:kind,...(kind==='group'?{group_id:Number(id)}:{}),user_id:Number(id),self_id:888,message_id:++mid,time:Math.floor(Date.now()/1000),sender:{user_id:Number(id),nickname:'Fixture contact'},message:[...(kind==='group'?[{type:'at',data:{qq:'888'}}]:[]),{type:'text',data:{text}}]});
 const reply=async(kind,id)=>{
  const sends=ob.state.sends.length;llm.state.script.push({model:'deepseek-flash',toolCalls:[{name:'send_message',args:{messages:['FIXTURE_AUTOMATIC_PLATFORM_REPLY']}},{name:'finish',args:{summary:'Fixture complete'}}]});push(kind,id,'Fixture hello');
  await waitFor(()=>ob.state.sends.length>sends,12000,'shared Agent reply without manual funding');await waitFor(()=>app.sessions.listSummaries().filter(row=>row.chatKey===kind+':'+id).every(row=>!['running','waiting'].includes(row.status)));
  assert.match(JSON.stringify(ob.state.sends.at(-1)),/FIXTURE_AUTOMATIC_PLATFORM_REPLY/);const status=paid.productionPaidCallGuard().status(kind+':'+id);assert.equal(status.dailyLimitCny,.1);assert.ok(status.spentCny>0);assert.equal(app.platformBusiness.runtimeAllowed(kind+':'+id),true);
 };
 await t.test('new whitelisted private and same-number group both use platform Key and independent 0.1 ledgers',async()=>{
  await reply('private','606');assert.equal(paid.productionPaidCallGuard().status('group:606').spentCny,0);await reply('group','606');assert.ok(headers.every(value=>value==='Bearer fixture-platform-auto-key'));assert.deepEqual(app.getConfig().productionBudget.funding,{});
 });
 await t.test('new ordinary account binds through QQ then immediately receives its private reply without funding selection',async()=>{
  const registered=await app.platformAuth.register({username:'fixture_new_user',password:'fixture-new-user-pass-2026'}),person=app.platformAuth.authenticate(app.platformAuth.cookie(registered.token).split(';')[0]);
  const proof=app.platformAuth.issueBinding(person,{qq:'778'}),before=llm.state.requests.length;push('private','778',proof.command);await waitFor(()=>app.platformAuth.store.binding(person.id));assert.equal(llm.state.requests.length,before,'binding control message is not sent to model');
  await reply('private','778');assert.equal(app.platformBusiness.funding(app.platformAuth.authenticate(app.platformAuth.cookie(registered.token).split(';')[0]),'private:778').inherited,true);assert.ok(headers.every(value=>value==='Bearer fixture-platform-auto-key'));
 });
});
