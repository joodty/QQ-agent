import fs from 'node:fs';
import path from 'node:path';
import {createHostedBots} from './hosted-bots.js';
import {createHostedLoginClient} from './hosted-login-client.js';
import {createBotPreferences,BOT_PREFERENCE_DEFAULTS} from './bot-preferences.js';

const fail=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
export function readHostedClientConfig(file){
  if(!file)return {};
  if(!path.isAbsolute(file))throw fail('托管服务配置必须使用绝对路径',503);
  const info=fs.lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||process.platform!=='win32'&&(info.mode&0o077))throw fail('托管服务私有配置权限不正确',503);
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!exact(value,['baseUrl','secret','maxBots'])||!Number.isInteger(value.maxBots)||value.maxBots<1||value.maxBots>10)throw fail('托管服务配置不正确',503);
  return {loginClient:createHostedLoginClient(value),maxBots:value.maxBots};
}

export function createHostedPlatform({auth,dataDir,config,onebot,primaryControls,speechService,
  loginClient,maxBots=1,fetchImpl=fetch,reconcileMs=30000}={}){
  const snapshot=config(),speechKey=(snapshot.allow?.groups||[]).map(id=>'group:'+id).concat((snapshot.allow?.private||[]).map(id=>'private:'+id))[0];
  let speech=null;try{if(speechKey)speech=speechService?.runtimePolicy(speechKey);}catch{}
  const primarySnapshot={...structuredClone(BOT_PREFERENCE_DEFAULTS),
    enabled:snapshot.botControls?.enabled??true,mentionOnly:snapshot.botControls?.mentionOnly??false,
    replyPercent:snapshot.botControls?.replyPercent??(snapshot.store?.contextTier>=4?100:snapshot.store?.randomPercent??10),
    contextMessages:snapshot.store?.historyCount??30,voiceEnabled:speech?.settings?.enabled??false,
    autoVoicePercent:speech?.settings?.autoVoicePercent??0,voiceType:speech?.voiceType??101001,speed:speech?.speed??0,volume:speech?.volume??0,
    groupIds:(snapshot.allow?.groups||[]).map(String),privateIds:(snapshot.allow?.private||[]).map(String),
    personaText:snapshot.persona?.roleText?.trim()||BOT_PREFERENCE_DEFAULTS.personaText,...snapshot.botControls};
  let preferences,closed=false,running=null;
  const applied=new Map(),runtimeHealth=new Map();
  const manager=createHostedBots({file:path.join(dataDir,'hosted-bots.sqlite'),platformStore:auth.store,loginClient,maxBots,
    onReady:async({request,connection})=>applyWorker(request,{...connection,origin:'http://127.0.0.1:'+connection.port})});
  const owns=(principal,botId)=>botId==='primary'?principal.role==='admin':manager.overview(principal).requests.some(r=>r.botId===botId);
  async function workerRequest(connection,route,body){
    const url=new URL(connection.origin);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw fail('机器人内部地址无效',503);
    const response=await fetchImpl(new URL(route,url),{method:'PUT',headers:{'content-type':'application/json','x-console-token':connection.machineToken},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
    const text=await response.text();if(text.length>65536)throw fail('机器人内部响应无效',503);
    let result;try{result=JSON.parse(text);}catch{throw fail('机器人暂不可用',503);}
    if(!response.ok||result.ok!==true)throw fail('机器人配置尚未应用，请稍后重试',503);
    return result;
  }
  async function applyWorker(request,connection,assertCurrent=()=>true){
    const owner=auth.store.account(request.ownerUserId);
    if(!owner||owner.disabled)throw fail('机器人所属账号已停用',403);
    const view=preferences.runtimePolicy(request.botId),stamp=JSON.stringify([view.version,view.defaultsVersion]);
    assertCurrent();
    const current=preferences.runtimePolicy(request.botId);
    if(current.version!==view.version||current.defaultsVersion!==view.defaultsVersion)throw fail('机器人配置已更新，请重试',409);
    await workerRequest(connection,'/api/hosted/settings',{version:view.version,defaultsVersion:view.defaultsVersion,effective:view.effective,expectedQQ:request.expectedQQ,leaseUntil:Date.now()+90000});
    assertCurrent();
    const after=auth.store.account(request.ownerUserId);
    if(!after||after.disabled)throw fail('机器人所属账号已停用',403);
    preferences.markRuntimeApplied({botId:view.botId,version:view.version,defaultsVersion:view.defaultsVersion});
    runtimeHealth.set(request.botId,{online:true,checkedAt:Date.now()});
    applied.set(request.botId,stamp);return {applied:true};
  }
  preferences=createBotPreferences({file:path.join(dataDir,'bot-preferences.sqlite'),auth,canManageBot:owns,
    initialBotOverrides:{primary:primarySnapshot},onChanged:async event=>{
      if(event.botId==='primary'){
        // Legacy per-chat settings remain authoritative until the owner saves
        // the new bot-wide controls. Merely editing new-user defaults cannot
        // flatten an existing bot's persona archives or speech overrides.
        if(event.reason==='defaults'&&!config().botControls)return {status:'not_connected',applied:false};
        return primaryControls.apply(event.effective,{principal:event.principal,assertCurrent:event.assertCurrent});
      }
      const request=manager.listRuntime().find(r=>r.botId===event.botId);
      if(!request)return {status:'not_connected',applied:false};
      const connection=await manager.connection(request.id);event.assertCurrent();
      return applyWorker(request,connection,event.assertCurrent);
    }});
  async function reconcile(){
    for(const request of manager.listRuntime()){
      if(closed)break;
      try{
        const owner=auth.store.account(request.ownerUserId);
        if(!owner||owner.disabled){
          const result=await loginClient?.cancel({requestId:request.id,ownerUserId:request.ownerUserId,expectedQQ:request.expectedQQ,slot:request.slot,version:request.version});
          if(result?.login?.state==='stopped')manager.confirmStopped({requestId:request.id,version:request.version});
          applied.delete(request.botId);runtimeHealth.set(request.botId,{online:false,checkedAt:Date.now()});preferences.markRuntimeUnavailable(request.botId);continue;
        }
        const connection=await manager.connection(request.id),view=preferences.runtimePolicy(request.botId),stamp=JSON.stringify([view.version,view.defaultsVersion]);
        if(applied.get(request.botId)!==stamp)await applyWorker(request,connection);
        else {await workerRequest(connection,'/api/hosted/lease',{leaseUntil:Date.now()+90000,expectedQQ:request.expectedQQ});runtimeHealth.set(request.botId,{online:true,checkedAt:Date.now()});}
      }catch{applied.delete(request.botId);runtimeHealth.set(request.botId,{online:false,checkedAt:Date.now()});preferences.markRuntimeUnavailable(request.botId);}
    }
  }
  const tick=()=>{if(closed||running)return;running=reconcile().finally(()=>{running=null;});};
  const timer=setInterval(tick,reconcileMs);timer.unref?.();
  // First synchronization also recovers independent workers after a front-door restart.
  queueMicrotask(tick);
  return {
    manager,preferences,
    async handle(req,res,url,principal,{readBody,json}){
      const pathname=url.pathname;
      if(pathname==='/api/platform/hosted-bots'){
        if(req.method==='GET'){
          const view=manager.overview(principal),fresh=auth.verifyPrincipal(principal);
          view.requests=view.requests.map(request=>{const health=runtimeHealth.get(request.botId);return request.status==='ready'&&(!health?.online||health.checkedAt<Date.now()-90000)?{...request,status:'connecting',reason:'实例连接正在核对，偏好应用状态以当前核验为准'}:request;});
          return json(res,200,{ok:true,...view,primaryBot:fresh.role==='admin'?{id:'primary',botId:'primary',expectedQQ:String(onebot.selfId||''),name:'我的 QQ（现有实例）',status:onebot.connected&&onebot.selfId?'ready':'connecting',reason:config().platform?.apiAccessPending?'平台模型服务等待开通 API 权限，AI 回复已暂停':null,version:0,primary:true}:null}),true;
        }
        if(req.method==='POST')return json(res,200,{ok:true,request:manager.create(principal,await readBody(req))}),true;
        throw fail('请求方法不支持',405);
      }
      const action=/^\/api\/platform\/hosted-bots\/([a-f0-9]{32})\/(start|status|refresh|reconnect|cancel)$/.exec(pathname);
      if(action){
        if(req.method!=='POST')throw fail('请求方法不支持',405);
        const input=await readBody(req);if(!exact(input,['version']))throw fail('接入参数无效');
        return json(res,200,{ok:true,...await manager[action[2]](principal,{requestId:action[1],...input})}),true;
      }
      if(pathname==='/api/platform/bot-preferences'){
        if(req.method==='GET')return json(res,200,{ok:true,...preferences.overview(principal,{botId:url.searchParams.get('botId')})}),true;
        if(req.method==='PUT')return json(res,200,{ok:true,...await preferences.update(principal,await readBody(req))}),true;
        throw fail('请求方法不支持',405);
      }
      if(pathname==='/api/platform/bot-defaults'){
        if(req.method==='GET')return json(res,200,{ok:true,...preferences.defaults(principal)}),true;
        if(req.method==='PUT')return json(res,200,{ok:true,...await preferences.updateDefaults(principal,await readBody(req))}),true;
        throw fail('请求方法不支持',405);
      }
      return false;
    },
    async close(){closed=true;clearInterval(timer);await running;await preferences.whenIdle?.();preferences.close();manager.close();}
  };
}
