// Independent review regressions: synthetic accounts and local WebSocket only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import {createHostedBots} from '../src/hosted-bots.js';
import {OneBotClient} from '../src/onebot.js';
import {createHostedPlatform} from '../src/hosted-platform.js';

const waitFor = async predicate => {
  const until = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > until) throw Error('Local fixture timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('a historical stopped request cannot bypass one live bot per owner', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqagent-provider-review-'));
  const principal={kind:'session',id:'1'.repeat(32),sessionHash:'fixture-session',passwordVersion:1,role:'user'};
  const client={start:async()=>({login:{state:'waiting_scan'}}),cancel:async()=>({login:{state:'stopped'}})};
  const manager=createHostedBots({file:path.join(root,'bots.sqlite'),platformStore:{verifiedSession:()=>principal},loginClient:client,maxBots:2,cooldownMs:0});
  t.after(()=>{manager.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'qqagent-provider-review-')));fs.rmSync(root,{recursive:true,force:true});});
  const old=manager.create(principal,{expectedQQ:'10001'});
  await manager.cancel(principal,{requestId:old.id});
  const current=manager.create(principal,{expectedQQ:'10002'});
  await manager.start(principal,{requestId:current.id});
  await assert.rejects(manager.start(principal,{requestId:old.id}),{statusCode:409});
});

test('a reconnect cannot broadcast connected with stale cached QQ identity', async t => {
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise(resolve=>server.once('listening',resolve));
  const client=new OneBotClient({wsUrl:'ws://127.0.0.1:'+server.address().port});
  let complete;
  client.selfInfo={user_id:'10001'};
  client.call=()=>new Promise(resolve=>{complete=resolve;});
  const observed=[];
  client.onStatus(({connected})=>{if(connected)observed.push(client.selfId);});
  t.after(async()=>{client.close();for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));});
  await client.connect();
  await waitFor(()=>complete);
  complete({user_id:'10002'});
  assert.equal(observed.includes('10001'),false,'cached old QQ must not be announced as verified on the new connection');
});

test('a failed background lease renewal cannot leave the last application displayed as applied',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqagent-provider-review-'));
  const principal={kind:'session',id:'2'.repeat(32),sessionHash:'fixture-session',passwordVersion:1,role:'user'};
  let unavailable=false,failures=0;
  const connection=input=>({login:{state:'ready'},connection:{botId:'hosted-'+input.requestId,expectedQQ:input.expectedQQ,port:24002,machineToken:'fixture-only-machine-token-0000000001'}});
  const service=createHostedPlatform({auth:{verifyPrincipal:value=>value,store:{verifiedSession:()=>principal,account:()=>principal}},dataDir:root,
    config:()=>({allow:{groups:[],private:[]}}),onebot:{},primaryControls:{},
    loginClient:{start:async input=>connection(input),status:async input=>connection(input)},reconcileMs:20,
    fetchImpl:async()=>{if(unavailable){failures++;throw Error('Fixture worker unavailable');}return {ok:true,text:async()=>JSON.stringify({ok:true})};}});
  t.after(async()=>{await service.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'qqagent-provider-review-')));fs.rmSync(root,{recursive:true,force:true});});
  const request=service.manager.create(principal,{expectedQQ:'10001'});
  await service.manager.start(principal,{requestId:request.id});
  assert.equal(service.preferences.overview(principal,{botId:request.botId}).application.status,'applied');
  unavailable=true;await waitFor(()=>failures>1);
  assert.equal(service.preferences.overview(principal,{botId:request.botId}).application.status,'failed');
});
