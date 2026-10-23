// Explicit account actions. These methods are never registered as AI tools.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateSpeechVoiceOptions,quoteSpeechText} from './speech-provider.js';
import {speechErrorMessage} from './speech-runtime.js';

const APP=0x514d5347,VERSION=2,MAX_TARGETS=20,MAX_CHARS=2000;
const fail=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const unavailable=()=>fail('人工发送回执暂不可用，原资料已保留',503);
const validKey=value=>typeof value==='string'&&/^(group|private):[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value.split(':')[1]));
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{16,80}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const sha=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Message types own validation and delivery. The common task engine below owns
// targets, authority, queues and receipts. Future media adapters must validate
// resource ownership and any paid synthesis separately; this text capability
// must never become a way to synthesize free audio or send arbitrary URLs.
const MESSAGE_TYPES=Object.freeze({
 text:Object.freeze({
  normalize(message){
   if(!exact(message,['type','text'])||typeof message.text!=='string'||!message.text.trim()||message.text.length>MAX_CHARS||!message.text.isWellFormed()||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message.text))throw fail('请输入1至2000字符的纯文本');
   return Object.freeze({type:'text',text:message.text});
  },
  dispatch({sendText},chatKey,message,options){return sendText(chatKey,message.text,options);}
 }),
 speech:Object.freeze({
  normalize(message){
   if(!exact(message,['type','text','voiceType','speed','volume'])||!Object.hasOwn(message,'voiceType'))throw fail('请输入语音正文并选择音色');
   try{validateSpeechVoiceOptions({voiceType:message.voiceType,speed:message.speed??0,volume:message.volume??0});quoteSpeechText(message.text,{maxChars:150,voiceType:message.voiceType});}catch{throw fail('语音正文、音色或语速音量不符合限制（最多150字符）');}
   for(const field of ['speed','volume'])if(Object.hasOwn(message,field)&&(typeof message[field]!=='number'||!Number.isFinite(message[field])))throw fail('语速或音量无效');
   return Object.freeze({type:'speech',text:message.text,voiceType:message.voiceType,...(Object.hasOwn(message,'speed')?{speed:message.speed}:{}),...(Object.hasOwn(message,'volume')?{volume:message.volume}:{})});
  },
  dispatch({sendSpeech,speechService},chatKey,message,options){
   if(typeof sendSpeech!=='function'||!speechService)throw fail('语音发送尚未启用',503);
   return sendSpeech(chatKey,{...options,async build(){
    const built=await speechService.synthesizeForAccount(options.principal,{chatKey,text:message.text,voiceType:message.voiceType,...(message.speed===undefined?{}:{speed:message.speed}),...(message.volume===undefined?{}:{volume:message.volume}),expectedPolicyVersion:options.policyVersion,operationId:options.operationId},{assertAuthority:options.guard,beforeRequest:options.beforeBillable,signal:options.signal});
    options.afterSynthesis(built);return {...built,assertCurrent:()=>speechService.assertAccountDelivery(built.receipt)};
   }});
  }
 })
});
function normalizeMessage(input){
 const legacy=Object.hasOwn(input,'text'),typed=Object.hasOwn(input,'message');
 if(legacy===typed)throw fail('text与message必须且只能提供一种');
 const message=legacy?{type:'text',text:input.text}:input.message;
 if(!message||typeof message!=='object'||Array.isArray(message)||typeof message.type!=='string')throw fail('消息类型无效');
 if(!Object.hasOwn(MESSAGE_TYPES,message.type))throw fail('暂不支持这种消息类型，目前仅支持文字消息或指定文字的语音合成');
 return MESSAGE_TYPES[message.type].normalize(message);
}

export function createPlatformMessages({file,auth,store,onebot,config,sendText,sendSpeech,speechService,canReach=()=>true}={}){
 if(!path.isAbsolute(file||'')||!auth||!store||!onebot||typeof config!=='function'||typeof sendText!=='function'||typeof canReach!=='function')throw unavailable();
 fs.mkdirSync(path.dirname(file),{recursive:true});const existed=fs.existsSync(file);let db;
 try{
  if(existed){const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw unavailable();}
  db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=2000;PRAGMA foreign_keys=ON;');
  if(!existed){fs.chmodSync(file,0o600);db.exec(`BEGIN IMMEDIATE;CREATE TABLE manual_requests(user_id TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,request_id)) STRICT;CREATE TABLE manual_results(user_id TEXT NOT NULL,request_id TEXT NOT NULL,ordinal INTEGER NOT NULL,chat_key TEXT NOT NULL,status TEXT NOT NULL,message_id INTEGER,error TEXT,history_recorded INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,request_id,ordinal),FOREIGN KEY(user_id,request_id) REFERENCES manual_requests(user_id,request_id)) STRICT;PRAGMA application_id=${APP};PRAGMA user_version=1;COMMIT;`);}
  if(db.prepare('PRAGMA application_id').get().application_id!==APP||![1,VERSION].includes(db.prepare('PRAGMA user_version').get().user_version)||db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw unavailable();
  if(JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name))!=='["manual_requests","manual_results"]')throw unavailable();
  db.prepare('SELECT user_id,request_id,payload_hash,kind,created_at FROM manual_requests LIMIT 0').all();db.prepare('SELECT user_id,request_id,ordinal,chat_key,status,message_id,error,history_recorded FROM manual_results LIMIT 0').all();
  if(db.prepare('PRAGMA user_version').get().user_version===1)db.exec("BEGIN IMMEDIATE;ALTER TABLE manual_results ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text';ALTER TABLE manual_results ADD COLUMN stage TEXT NOT NULL DEFAULT 'queued';ALTER TABLE manual_results ADD COLUMN tts_outcome TEXT NOT NULL DEFAULT 'not_started';ALTER TABLE manual_results ADD COLUMN estimated_cost_micros INTEGER;UPDATE manual_results SET stage=CASE WHEN status='dispatching' THEN 'qq' WHEN status='sent' THEN 'complete' ELSE 'queued' END;PRAGMA user_version=2;COMMIT;");
  db.prepare('SELECT message_type,stage,tts_outcome,estimated_cost_micros FROM manual_results LIMIT 0').all();
  db.exec('PRAGMA journal_mode=WAL;');fs.chmodSync(file,0o600);
  db.prepare("UPDATE manual_results SET status='unknown',tts_outcome=CASE WHEN stage='tts' THEN 'unknown' ELSE tts_outcome END,error=CASE WHEN stage='tts' THEN '重启前已请求语音合成，费用待核对，QQ尚未发送；请勿直接重试' WHEN stage='qq_pending' THEN '语音已合成计费但QQ尚未发送；请核对后再创建新请求' ELSE '服务重启前已请求QQ，结果待核对；请勿直接重发' END WHERE status='dispatching'").run();
  db.prepare("UPDATE manual_results SET status='failed',error='服务重启前尚未发送，本次请求已停止' WHERE status='queued'").run();
 }catch{try{db?.close();}catch{}throw unavailable();}
 let stopped=false,closing=null;const inFlight=new Map(),pending=new Set(),controllers=new Set();
 const transaction=work=>{db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}};
 const fresh=principal=>auth.verifyPrincipal(principal);
 const allowed=chatKey=>{const cfg=config(),[kind,id]=chatKey.split(':'),field=kind==='group'?'groups':'private',allow=cfg.allow?.[field];return Array.isArray(allow)&&(allow.length?allow.map(String).includes(id):cfg.allowAllWhenEmpty===true)&&!(cfg.deny?.[field]||[]).map(String).includes(id);};
 const assertTarget=(principal,chatKey,{broadcast=false,transport=true}={})=>{
  if(stopped)throw fail('服务正在关闭，本条尚未发送',503);
  const current=fresh(principal);
  if(broadcast&&current.role!=='admin')throw fail('只有平台管理员可以群发消息',403);
  if(!validKey(chatKey)||!auth.listScopes(current,{botId:'primary'}).includes(chatKey)||!auth.canAccess(current,chatKey,{botId:'primary',write:true}))throw fail('没有这个聊天的发送权限',403);
  if(transport){if(!allowed(chatKey)||canReach(chatKey)!==true)throw fail('此聊天未在可发送名单中，或机器人已离开该群',403);if(onebot.connected!==true)throw fail('QQ尚未连接，本条尚未发送',503);}
  return current;
 };
 const rowsFor=(userId,requestId)=>db.prepare('SELECT * FROM manual_results WHERE user_id=? AND request_id=? ORDER BY ordinal').all(userId,requestId);
 const requestFor=(userId,requestId)=>db.prepare('SELECT * FROM manual_requests WHERE user_id=? AND request_id=?').get(userId,requestId);
 const report=(request,{replayed=false}={})=>{
  const rows=rowsFor(request.user_id,request.request_id);if(!rows.length||rows.length>MAX_TARGETS||!['send','broadcast'].includes(request.kind))throw unavailable();
  const results=rows.map(row=>{
   if(!validKey(row.chat_key)||!['queued','dispatching','sent','unknown','failed'].includes(row.status)||![0,1].includes(row.history_recorded)||row.message_id!==null&&(!Number.isSafeInteger(row.message_id)||row.message_id===0))throw unavailable();
   return {chatKey:row.chat_key,status:['queued','dispatching'].includes(row.status)?'pending':row.status,messageId:row.message_id,historyRecorded:row.history_recorded===1,messageType:row.message_type,stage:row.stage,ttsOutcome:row.tts_outcome,estimatedCostCny:row.estimated_cost_micros===null?null:row.estimated_cost_micros/1e6,...(row.error?{error:row.error}:{})};
  });
  const common={requestId:request.request_id,replayed,complete:results.every(row=>row.status!=='pending')};
  return request.kind==='send'?{...common,...results[0]}:{...common,results};
 };
 const visibleReport=(principal,request,options)=>{for(const row of rowsFor(request.user_id,request.request_id))assertTarget(principal,row.chat_key,{broadcast:request.kind==='broadcast',transport:false});return report(request,options);};
 const speechReason=code=>code==='SPEECH_FUNDING_UNAVAILABLE'?'当前聊天尚未配置可用的费用来源，请先在费用与额度中配置':speechErrorMessage(code);
 async function quoteTargets(principal,keys,message){
  for(const chatKey of keys){await auth.ensureAccess(fresh(principal),chatKey,{botId:'primary',write:true});assertTarget(principal,chatKey,{broadcast:keys.length>1});}
  const quotes=keys.map(chatKey=>{
   if(message.type==='text')return {chatKey,allowed:true,reason:null,maxChars:MAX_CHARS,characters:message.text.length,estimatedCostCny:0,rateCnyPer10k:0,policyVersion:null};
   if(!speechService||typeof sendSpeech!=='function')return {chatKey,allowed:false,reason:'语音发送尚未启用',maxChars:0,estimatedCostCny:0,rateCnyPer10k:null,policyVersion:null};
   try{const row=speechService.quoteForAccount(fresh(principal),{chatKey,...message});return {chatKey,...row,reason:row.reason?speechReason(row.reason):null};}catch{return {chatKey,allowed:false,reason:'语音报价暂不可用，请检查音色、费用来源和语音额度',maxChars:0,estimatedCostCny:0,rateCnyPer10k:null,policyVersion:null};}
  });
  const total=quotes.reduce((sum,row)=>sum+Math.round(row.estimatedCostCny*1e6),0)/1e6,platformRoom=Math.min(...quotes.filter(row=>row.capacity).map(row=>row.capacity.platformCny)),trialTotal=quotes.filter(row=>row.capacity?.trialCny!==null&&row.capacity?.trialCny!==undefined).reduce((sum,row)=>sum+row.estimatedCostCny,0),trialRoom=Math.min(...quotes.filter(row=>row.capacity?.trialCny!==null&&row.capacity?.trialCny!==undefined).map(row=>row.capacity.trialCny));
  if(message.type==='speech'&&(total>=platformRoom||trialTotal>=trialRoom))for(const row of quotes){row.allowed=false;row.reason='本批次预计语音费用将达到平台或体验总额度的80%，请减少目标或调整授权额度';}
  for(const chatKey of keys)assertTarget(principal,chatKey,{broadcast:keys.length>1});
  return {messageType:message.type,currency:'CNY',estimated:true,characters:message.text.length,totalEstimatedCostCny:total,allowed:quotes.every(row=>row.allowed),targets:quotes.map(({capacity,...row})=>row),speechPolicyVersions:Object.fromEntries(quotes.filter(row=>row.policyVersion).map(row=>[row.chatKey,row.policyVersion])),estimationBoundary:'按每个聊天独立合成、按指定音色标价估算；免费资源包抵扣未同步。报价不预留费用，发送前重新核验额度与冷却。'};
 }
 function finish(userId,requestId,ordinal,result){db.prepare('UPDATE manual_results SET status=?,message_id=?,error=?,history_recorded=? WHERE user_id=? AND request_id=? AND ordinal=?').run(result.status,result.messageId??null,result.error??null,result.historyRecorded?1:0,userId,requestId,ordinal);}
 async function execute(principal,input,request,keys,broadcast){
  let stopReason=null;
  for(let ordinal=0;ordinal<keys.length;ordinal++){
   const chatKey=keys[ordinal];if(stopReason){finish(request.user_id,input.requestId,ordinal,{status:'failed',error:stopReason});continue;}
   let dispatched=false,billable=false,settled=false,stage='queued';
   try{
    await auth.ensureAccess(fresh(principal),chatKey,{botId:'primary',write:true});assertTarget(principal,chatKey,{broadcast});
    const selection=store.captureArchive?.(chatKey)||{archiveId:null,selectionVersion:0};
    if(!broadcast&&input.expectedSelectionVersion!==undefined&&input.expectedSelectionVersion!==selection.selectionVersion)throw fail('人设会话已切换，本条尚未发送，请刷新后核对',409);
    const result=await MESSAGE_TYPES[input.message.type].dispatch({sendText,sendSpeech,speechService},chatKey,input.message,{selection,principal,signal:input.signal,operationId:'manual:'+sha([request.user_id,input.requestId,chatKey]),policyVersion:input.speechPolicyVersions?.[chatKey],guard:()=>{assertTarget(principal,chatKey,{broadcast});store.assertArchiveCurrent?.(chatKey,selection);},beforeBillable(){
     assertTarget(principal,chatKey,{broadcast});store.assertArchiveCurrent?.(chatKey,selection);const changed=db.prepare("UPDATE manual_results SET status='dispatching',stage='tts',tts_outcome='unknown' WHERE user_id=? AND request_id=? AND ordinal=? AND status='queued'").run(request.user_id,input.requestId,ordinal);if(changed.changes!==1)throw unavailable();billable=true;stage='tts';
    },afterSynthesis(built){
     db.prepare("UPDATE manual_results SET tts_outcome='settled',stage='qq_pending',estimated_cost_micros=? WHERE user_id=? AND request_id=? AND ordinal=?").run(Math.round(built.estimatedCostCny*1e6),request.user_id,input.requestId,ordinal);settled=true;stage='qq_pending';
    },beforeDispatch(){
     assertTarget(principal,chatKey,{broadcast});
     const changed=db.prepare("UPDATE manual_results SET status='dispatching',stage='qq' WHERE user_id=? AND request_id=? AND ordinal=? AND status IN ('queued','dispatching')").run(request.user_id,input.requestId,ordinal);if(changed.changes!==1)throw unavailable();dispatched=true;stage='qq';
    }});
    db.prepare("UPDATE manual_results SET stage='complete' WHERE user_id=? AND request_id=? AND ordinal=?").run(request.user_id,input.requestId,ordinal);
    finish(request.user_id,input.requestId,ordinal,{status:'sent',messageId:result.messageId,historyRecorded:result.historyRecorded});
    try{assertTarget(principal,chatKey,{broadcast});}catch{stopReason='发送后权限或连接已变化，后续目标均未发送';}
   }catch(error){
    const charge=settled?'settled':error?.chargeOutcome||(billable?'unknown':'not_sent'),cloudUnknown=input.message.type==='speech'&&charge==='unknown';
    if(input.message.type==='speech'){settled=charge==='settled';if(!dispatched)stage=settled?'qq_pending':cloudUnknown?'tts':'queued';db.prepare('UPDATE manual_results SET stage=?,tts_outcome=? WHERE user_id=? AND request_id=? AND ordinal=?').run(stage,settled?'settled':cloudUnknown?'unknown':'not_started',request.user_id,input.requestId,ordinal);}
    const detail=dispatched?'已向QQ请求发送，结果无法确认；请先在QQ核对，勿直接重发':cloudUnknown?'语音合成结果与费用待核对，QQ尚未发送；请勿直接重试':settled?'语音已经合成并计入用量，但QQ尚未发送，请核对权限与设置后再操作':error?.code?.startsWith('SPEECH_')?speechReason(error.code):error?.statusCode===403?'权限或白名单已变化，本条尚未发送':error?.code==='ARCHIVE_CHANGED'||error?.statusCode===409?'人设会话已切换，本条尚未发送':stopped?'服务正在关闭，本条尚未发送':error?.message?.startsWith('发送频率超限')?'发送频率超限，本条尚未发送':'发送条件未满足，本条尚未发送';
    finish(request.user_id,input.requestId,ordinal,{status:dispatched||cloudUnknown?'unknown':'failed',messageId:error?.messageId,error:detail});
    if(dispatched||cloudUnknown||settled||stopped||error?.statusCode===401||error?.statusCode===403)stopReason=dispatched||cloudUnknown?'前一条结果待核对，后续目标均未发送':'权限、语音或服务状态已变化，后续目标均未发送';
   }
  }
  return visibleReport(principal,request);
 }
 async function submit(principal,input,broadcast){
  if(stopped)throw fail('人工发送服务正在关闭',503);
  if(!exact(input,broadcast?['chatKeys','text','message','requestId','speechPolicyVersions']:['chatKey','text','message','requestId','expectedSelectionVersion','speechPolicyVersions'])||!validId(input.requestId))throw fail('请选择聊天并提供有效消息和请求编号');
  const message=normalizeMessage(input);
  const person=fresh(principal);if(broadcast&&person.role!=='admin')throw fail('只有平台管理员可以群发消息',403);
  const keys=broadcast?input.chatKeys:[input.chatKey];
  if(!Array.isArray(keys)||!keys.length||keys.length>MAX_TARGETS||new Set(keys).size!==keys.length||keys.some(key=>!validKey(key)))throw fail('请选择1至20个不重复的群聊或私聊');
  if(!broadcast&&input.expectedSelectionVersion!==undefined&&(!Number.isSafeInteger(input.expectedSelectionVersion)||input.expectedSelectionVersion<0))throw fail('人设会话版本无效');
  if(message.type==='speech'&&(!exact(input.speechPolicyVersions,keys)||Object.keys(input.speechPolicyVersions).length!==keys.length||keys.some(key=>!/^\w{64}$/.test(input.speechPolicyVersions[key]||''))))throw fail('请先获取当前目标的语音报价，再确认发送');
  if(message.type==='text'&&input.speechPolicyVersions!==undefined)throw fail('文字消息无需语音报价');
  const hashParts=[broadcast?'broadcast':'send',keys,message,input.expectedSelectionVersion??null];if(message.type==='speech')hashParts.push(keys.map(key=>[key,input.speechPolicyVersions[key]]));
  const payloadHash=sha(hashParts),flightKey=person.id+':'+input.requestId;
  let old=requestFor(person.id,input.requestId);if(old&&old.payload_hash!==payloadHash)throw fail('相同请求编号不能用于不同内容或聊天',409);
  for(const chatKey of keys){await auth.ensureAccess(fresh(principal),chatKey,{botId:'primary',write:true});assertTarget(principal,chatKey,{broadcast,transport:!old});}
  old=requestFor(person.id,input.requestId);
  if(old){if(old.payload_hash!==payloadHash)throw fail('相同请求编号不能用于不同内容或聊天',409);if(inFlight.has(flightKey))await inFlight.get(flightKey);return visibleReport(principal,old,{replayed:true});}
  let quoted=null;if(message.type==='speech'){quoted=await quoteTargets(principal,keys,message);if(!quoted.allowed)throw fail(quoted.targets.find(row=>!row.allowed)?.reason||'语音发送条件未满足',403);if(keys.some(key=>quoted.speechPolicyVersions[key]!==input.speechPolicyVersions[key]))throw fail('语音报价或设置已经变化，请重新预览确认',409);}
  old=requestFor(person.id,input.requestId);if(old){if(old.payload_hash!==payloadHash)throw fail('相同请求编号不能用于不同内容或聊天',409);if(inFlight.has(flightKey))await inFlight.get(flightKey);return visibleReport(principal,old,{replayed:true});}
  if(stopped)throw fail('人工发送服务正在关闭',503);
  if(inFlight.size>=4||[...inFlight.keys()].filter(key=>key.startsWith(person.id+':')).length>=2)throw fail('有其他人工发送正在处理，请稍后再试',429);
  transaction(()=>{db.prepare('INSERT INTO manual_requests VALUES(?,?,?,?,?)').run(person.id,input.requestId,payloadHash,broadcast?'broadcast':'send',Date.now());keys.forEach((chatKey,ordinal)=>db.prepare('INSERT INTO manual_results(user_id,request_id,ordinal,chat_key,status,message_type,estimated_cost_micros) VALUES(?,?,?,?,?,?,?)').run(person.id,input.requestId,ordinal,chatKey,'queued',message.type,quoted?Math.round(quoted.targets[ordinal].estimatedCostCny*1e6):null));});
  const controller=new AbortController();controllers.add(controller);
  const task=Object.freeze({requestId:input.requestId,message,expectedSelectionVersion:input.expectedSelectionVersion,speechPolicyVersions:input.speechPolicyVersions,signal:controller.signal});
  const request=requestFor(person.id,input.requestId),work=execute(principal,task,request,keys,broadcast);inFlight.set(flightKey,work);
  try{return await work;}finally{inFlight.delete(flightKey);controllers.delete(controller);}
 }
 const tracked=work=>{const promise=work();pending.add(promise);promise.finally(()=>pending.delete(promise)).catch(()=>{});return promise;};
 return {
  targets(principal){if(stopped)throw unavailable();const person=fresh(principal);return {targets:auth.listScopes(person,{botId:'primary'}).filter(chatKey=>validKey(chatKey)&&auth.canAccess(person,chatKey,{botId:'primary',write:true})&&allowed(chatKey)&&canReach(chatKey)===true).map(chatKey=>({chatKey})),maxTargets:MAX_TARGETS,maxChars:MAX_CHARS,connected:onebot.connected===true,broadcastAllowed:person.role==='admin'};},
  send(principal,input){return tracked(()=>submit(principal,input,false));},
  broadcast(principal,input){return tracked(()=>submit(principal,input,true));},
  quote(principal,input){return tracked(async()=>{if(!exact(input,['chatKeys','message','text'])||!Array.isArray(input.chatKeys)||!input.chatKeys.length||input.chatKeys.length>MAX_TARGETS||new Set(input.chatKeys).size!==input.chatKeys.length||input.chatKeys.some(key=>!validKey(key)))throw fail('请选择1至20个不重复的群聊或私聊');return quoteTargets(principal,input.chatKeys,normalizeMessage(input));});},
  result(principal,requestId){if(stopped)throw unavailable();if(!validId(requestId))throw fail('请求编号无效');const person=fresh(principal),request=requestFor(person.id,requestId);if(!request)throw fail('未找到本次发送请求',404);return visibleReport(principal,request,{replayed:true});},
  close(){if(closing)return closing;stopped=true;for(const controller of controllers)controller.abort();return closing=(async()=>{await Promise.allSettled([...pending]);db.close();})();}
 };
}
