import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {OneBotClient} from '../src/onebot.js';

const waitFor=async predicate=>{
  const until=Date.now()+4000;
  while(!predicate()){
    if(Date.now()>until)throw Error('Local OneBot fixture timed out');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t,{expectedSelfId='10001',connect=true,beforeSend=null}={}){
  const state={actualQQ:'10001',failLogin:false,loginCalls:0,sends:[],events:[],statuses:[],pending:[]};
  const server=http.createServer(async(req,res)=>{
    for await(const _ of req){}
    const action=req.url.slice(1);
    if(action==='get_login_info'){
      state.loginCalls++;
      const pending=state.pending.shift(),value=pending?await pending.promise:{user_id:state.actualQQ,nickname:'Fixture QQ'};
      if(state.failLogin){res.writeHead(503);res.end('{}');return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:value}));return;
    }
    state.sends.push(action);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:1}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const ws=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise(resolve=>ws.once('listening',resolve));
  const client=new OneBotClient({expectedSelfId,beforeSend,httpUrl:'http://127.0.0.1:'+server.address().port,wsUrl:'ws://127.0.0.1:'+ws.address().port,onEvent:event=>state.events.push(event)});
  client.onStatus(value=>state.statuses.push({...value,selfId:client.selfId}));
  t.after(async()=>{
    client.close();for(const pending of state.pending)pending.resolve({user_id:'10001'});
    for(const socket of ws.clients)socket.terminate();
    await new Promise(resolve=>ws.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  });
  if(connect){await client.connect();await waitFor(()=>client.selfId==='10001');}
  return {client,state,ws,push(event){for(const socket of ws.clients)if(socket.readyState===1)socket.send(JSON.stringify(event));}};
}

test('hosted send, poke and upload verify the real HTTP identity for every dispatch',async t=>{
  const {client,state}=await fixture(t),before=state.loginCalls;
  for(const action of ['send_group_msg','send_private_msg','friend_poke','group_poke','upload_group_file','_send_group_notice'])await client.call(action,{});
  assert.equal(state.loginCalls-before,6);assert.equal(state.sends.length,6);
});

test('a changed HTTP account blocks a send despite a still-connected WebSocket and old cached identity',async t=>{
  const {client,state}=await fixture(t);state.actualQQ='10002';
  await assert.rejects(client.call('send_group_msg',{}),{code:'ONEBOT_IDENTITY_UNVERIFIED'});
  assert.equal(state.sends.length,0);assert.equal(client.selfId,'');
  assert.ok(state.statuses.some(value=>value.selfId===''));
});

test('a wrong or absent incoming self_id clears identity synchronously and never reaches the event handler',async t=>{
  const f=await fixture(t);f.push({post_type:'message',self_id:10002,user_id:99999});
  await waitFor(()=>f.client.selfId==='');assert.equal(f.state.events.length,0);
  // Correct events cannot themselves re-authorize a connection after mismatch.
  f.push({post_type:'message',self_id:10001,user_id:99999});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(f.state.events.length,0);
  await f.client.call('send_group_msg',{});assert.equal(f.client.selfId,'10001');
  f.push({post_type:'message',user_id:99999});
  await waitFor(()=>f.client.selfId==='');assert.equal(f.state.events.length,0);
});

test('identity lookup failure fails closed without dispatching or retaining cached identity',async t=>{
  const {client,state}=await fixture(t);state.failLogin=true;
  await assert.rejects(client.call('send_private_msg',{}),{code:'ONEBOT_IDENTITY_UNVERIFIED'});
  assert.equal(state.sends.length,0);assert.equal(client.selfId,'');
});

test('the application startup refresh shares identity validation and cannot apply a result after close',async t=>{
  const f=await fixture(t),pending=deferred(),before=f.state.loginCalls;f.state.pending.push(pending);
  const refreshing=f.client.refreshSelfInfo();const rejected=assert.rejects(refreshing,{code:'ONEBOT_IDENTITY_UNVERIFIED'});
  await waitFor(()=>f.state.loginCalls>before);f.client.close();pending.resolve({user_id:'10001'});await rejected;
  assert.equal(f.client.selfId,'');assert.equal(f.client.connected,false);
});

test('an identity event arriving during the send lookup invalidates its otherwise matching reply',async t=>{
  const f=await fixture(t),pending=deferred(),before=f.state.loginCalls;f.state.pending.push(pending);
  const sending=f.client.call('send_group_msg',{});const rejected=assert.rejects(sending,{code:'ONEBOT_IDENTITY_UNVERIFIED'});
  await waitFor(()=>f.state.loginCalls>before);f.push({post_type:'meta_event',self_id:10002});await waitFor(()=>f.client.selfId==='');
  pending.resolve({user_id:'10001'});await rejected;assert.equal(f.state.sends.length,0);assert.equal(f.client.selfId,'');
});

test('a lease or resource revoked during the fresh lookup is checked again immediately before send',async t=>{
  let authorized=true;
  const f=await fixture(t,{beforeSend:()=>authorized}),pending=deferred(),before=f.state.loginCalls;f.state.pending.push(pending);
  const sending=f.client.call('send_group_msg',{group_id:12345});const rejected=assert.rejects(sending,{code:'ONEBOT_SEND_REVOKED'});
  await waitFor(()=>f.state.loginCalls>before);authorized=false;pending.resolve({user_id:'10001'});
  await rejected;assert.equal(f.state.sends.length,0);
});

test('reconnect clears identity immediately and a late previous connection lookup cannot restore it',async t=>{
  const f=await fixture(t,{connect:false}),old=deferred();f.state.pending.push(old);
  await f.client.connect();await waitFor(()=>f.state.loginCalls===1);
  f.client.selfInfo={user_id:'10001'};
  const at=f.state.statuses.length;await f.client.reconnect();assert.equal(f.client.selfId,'');
  await waitFor(()=>f.state.loginCalls===2&&f.client.selfId==='10001');
  old.resolve({user_id:'10002'});await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.client.selfId,'10001');
  assert.equal(f.state.statuses.slice(at).find(value=>value.connected)?.selfId,'');
  const next=deferred();f.state.pending.push(next);await f.client.reconnect();await waitFor(()=>f.state.loginCalls===3);
  f.client.close();next.resolve({user_id:'10001'});await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(f.client.selfId,'');assert.equal(f.client.connected,false);
});

test('primary compatibility does not add per-send identity lookups or require event self_id',async t=>{
  const f=await fixture(t,{expectedSelfId:''}),before=f.state.loginCalls;
  await f.client.call('send_group_msg',{});assert.equal(f.state.loginCalls,before);
  f.push({post_type:'message',user_id:99999});await waitFor(()=>f.state.events.length===1);
});
