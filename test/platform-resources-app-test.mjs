// Real application/auth/business/paid-guard/speech wiring; every fetch and QQ
// peer is synthetic. There is deliberately no native-fetch/network fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {makeDataDir,writeConfig,freePort,waitFor,createMockOneBotWs} from './_harness.mjs';

test('real app derives shared model and speech funding from fresh account scopes/binding without payer rows',async t=>{
  const root=makeDataDir('qq-platform-resources-app-'),previousFetch=globalThis.fetch;
  const ws=createMockOneBotWs(),wsPort=await ws.ready(),obOrigin='http://127.0.0.1:39997';
  const endpoint='https://api.commandcode.ai/alpha',model='deepseek/deepseek-v4.1-flash';
  const modelRequests=[],speechRequests=[],qqSends=[],speechNonces=new Set();
  const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  const wav=Buffer.alloc(44);wav.write('RIFF',0);wav.writeUInt32LE(36,4);wav.write('WAVE',8);
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(String(input));
    if(url.href===endpoint+'/generate'){
      const body=JSON.parse(options.body);modelRequests.push(body);
      assert.equal(options.headers.authorization,'Bearer fixture-shared-go-key');
      assert.equal(body.params.model,model);assert.ok(body.params.max_tokens<=128);
      return new Response([
        {type:'text-start',id:'fixture-text'},
        {type:'text-delta',id:'fixture-text',text:'Synthetic shared model reply'},
        {type:'text-end',id:'fixture-text'},
        {type:'finish',finishReason:'stop',totalUsage:{inputTokens:100,outputTokens:10,totalTokens:110,inputTokenDetails:{cacheReadTokens:20}}}
      ].map(event=>JSON.stringify(event)).join('\n')+'\n',{headers:{'content-type':'application/x-ndjson'}});
    }
    if(url.href==='https://tts.tencentcloudapi.com/'){
      const body=JSON.parse(options.body);speechRequests.push(body);
      assert.match(options.headers.Authorization,/Credential=fixture-shared-tencent-id\//);
      assert.equal(speechNonces.has(body.SessionId),false);speechNonces.add(body.SessionId);
      return json({Response:{SessionId:body.SessionId,RequestId:'fixture-request-'+speechRequests.length,Audio:wav.toString('base64')}});
    }
    if(url.origin===obOrigin){
      const action=url.pathname.slice(1),body=JSON.parse(options.body||'{}');let data;
      if(action==='get_login_info')data={user_id:888,nickname:'Synthetic bot'};
      else if(action==='get_group_list')data=[{group_id:789,group_name:'Synthetic scoped group'}];
      else if(action==='get_friend_list')data=[{user_id:777,nickname:'Synthetic binding owner'}];
      else if(action==='get_group_info')data={group_id:body.group_id,group_name:'Synthetic scoped group'};
      else if(action==='get_group_member_info')data={group_id:body.group_id,user_id:body.user_id,role:'admin',nickname:'Synthetic owner'};
      else if(action==='get_group_member_list')data=[];
      else if(action==='get_status')data={online:true};
      else if(action.startsWith('send_')){qqSends.push({action,body});data={message_id:1000+qqSends.length};}
      else throw Error('Unexpected synthetic OneBot action: '+action);
      return json({status:'ok',retcode:0,data});
    }
    throw Error('Synthetic fixture forbids external networking: '+url.origin);
  };
  writeConfig(root,{
    platform:{enabled:true,publicOrigin:'https://resources.example.test',resourcesOnly:true},ownerQQ:'999',
    api:{baseUrl:endpoint,model,apiKey:'fixture-shared-go-key',fallbackModels:[],vision:false,timeoutMs:5000},
    snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:obOrigin,accessToken:''},
    server:{port:await freePort(),token:'fixture-internal-resources-token-2026'},
    allow:{groups:[],private:[]},deny:{groups:[],private:[]},allowAllWhenEmpty:false,
    proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},
    webSearch:{enabled:false},extensions:{hotReload:false},speech:{timeoutMs:1000},
    productionBudget:{enabled:true,endpoint,model,prices:{inputCnyPerMillion:2.4,cacheHitCnyPerMillion:.048,outputCnyPerMillion:9.6,reasoningIncluded:true},
      defaultDailyLimitCny:.2,totalDailyLimitCny:1,overrides:{},initialSpent:{},funding:{},outputCap:128,imageTokensPerImage:1024}
  });
  const {createApp}=await import('../src/app.js');
  const {chatCompletion}=await import('../src/llm.js');
  const {runWithPaidConversation,capturePaidFunding,productionPaidCallGuard,closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js');
  let app;
  t.after(async()=>{
    if(app)await app.stop();closeProductionPaidCallGuard();await ws.close();globalThis.fetch=previousFetch;
    assert.ok(path.basename(root).startsWith('qq-platform-resources-app-'));fs.rmSync(root,{recursive:true,force:true});
  });
  app=createApp({log:()=>{},speechCredentials:()=>({format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixture-shared-tencent-id',secretKey:'fixture-shared-tencent-key'})});
  const adminLogin=await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});
  const userLogin=await app.platformAuth.register({username:'fixture_member',password:'fixture-member-pass-2026'});
  const principal=login=>app.platformAuth.authenticate(app.platformAuth.cookie(login.token));
  const admin=principal(adminLogin),user=principal(userLogin);assert.equal(admin.role,'admin');assert.equal(user.role,'user');
  await app.start();await waitFor(()=>app.onebot.connected&&ws.state.client?.readyState===1,5000,'synthetic OneBot ready');
  const proof=app.platformAuth.issueBinding(user,{qq:'777'});
  ws.push({post_type:'message',message_type:'private',self_id:888,user_id:777,message_id:90001,time:Math.floor(Date.now()/1000),sender:{user_id:777,nickname:'Synthetic owner'},message:[{type:'text',data:{text:proof.command}}]});
  await waitFor(()=>app.platformAuth.status(user).binding?.qq==='777',5000,'real binding consumed');
  assert.ok(qqSends.some(row=>row.action==='send_private_msg'));
  assert.equal(modelRequests.length,0,'Binding never calls a model');
  app.platformAuth.store.grant(user.id,'group:789','primary');
  assert.deepEqual(app.getConfig().allow,{groups:[],private:[]});
  assert.deepEqual(app.platformAuth.resourceOwners('group:789').map(owner=>owner.id),[user.id]);
  assert.deepEqual(app.platformAuth.resourceOwners('private:777').map(owner=>owner.id),[user.id]);
  const fundingRows=()=>{const db=new DatabaseSync(path.join(root,'platform-business.sqlite'));try{return db.prepare('SELECT * FROM business_funding').all();}finally{db.close();}};
  assert.deepEqual(fundingRows(),[]);
  assert.equal(capturePaidFunding('group:789').mode,'platform');
  assert.equal(capturePaidFunding('private:777').ownerId,user.id);
  assert.equal(app.platformBusiness.runtimeAllowed('group:789'),true);
  assert.equal(app.platformBusiness.runtimeAllowed('group:999'),false,'Administrator-wide authority cannot fund an unowned resource');
  const complete=chatKey=>runWithPaidConversation(chatKey,()=>chatCompletion({messages:[{role:'user',content:'Synthetic shared-resource request'}],maxTokens:32}));
  await complete('group:789');await complete('private:777');
  assert.equal(modelRequests.length,2);
  const guard=productionPaidCallGuard();assert.equal(guard.records().filter(row=>row.state==='settled').length,2);
  const platform=app.speechService.platformOverview(admin);
  app.speechService.updatePlatform(admin,{expectedVersion:platform.version,enabled:true,dailyLimitCny:.1,cooldownMs:1000});
  const initialSpeech=app.speechService.settings(user,'group:789');
  assert.equal(initialSpeech.subsidy.inherited,true);assert.equal(initialSpeech.subsidy.dailyLimitCny,.1);
  app.speechService.updateSettings(user,{chatKey:'group:789',expectedVersion:initialSpeech.settings.version,enabled:true});
  const audio=await app.speechService.synthesize('group:789',{text:'合成测试。',direct:true});
  assert.equal(audio.mime,'audio/wav');assert.ok(audio.estimatedCostCny>0);assert.equal(speechRequests.length,1);
  assert.equal(guard.records().filter(row=>row.state==='settled').length,3);
  assert.deepEqual(fundingRows(),[],'Model/speech admission does not create payer rows');
  const settled=guard.records(),paidBefore=modelRequests.length+speechRequests.length;
  await app.platformAuth.updateAccount(admin,{id:user.id,conversationKeys:[],botScopes:[],expectedVersion:app.platformAuth.store.version()});
  assert.deepEqual(app.platformAuth.resourceOwners('group:789'),[]);
  await assert.rejects(async()=>complete('group:789'),{code:'PAID_CALL_DENIED'});
  await assert.rejects(app.speechService.synthesize('group:789',{text:'撤权后不得合成。',direct:true}),{code:'SPEECH_ADMISSION_DENIED',chargeOutcome:'not_sent'});
  const renewedUser=principal(await app.platformAuth.login({username:'fixture_member',password:'fixture-member-pass-2026'}));
  assert.throws(()=>app.speechService.updateSettings(renewedUser,{chatKey:'group:789',expectedVersion:1,enabled:true}),{code:'SPEECH_ACCESS_DENIED'});
  await app.platformAuth.updateAccount(admin,{id:user.id,disabled:true,expectedVersion:app.platformAuth.store.version()});
  assert.deepEqual(app.platformAuth.resourceOwners('private:777'),[]);
  await assert.rejects(async()=>complete('private:777'),{code:'PAID_CALL_DENIED'});
  assert.equal(modelRequests.length+speechRequests.length,paidBefore);
  assert.deepEqual(guard.records(),settled,'Revocation preserves settled model and speech bills');
  assert.deepEqual(fundingRows(),[]);
});
