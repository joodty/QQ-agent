// Durable QQ display names. This index never creates a scope or grants access.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const APP=0x51434944,VERSION=1;
const fail=()=>Object.assign(Error('聊天名称索引暂不可用，已保留现有资料'),{statusCode:503,code:'CHAT_IDENTITIES_UNAVAILABLE'});
const botValid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(value);
const keyValid=value=>typeof value==='string'&&/^(group|private):[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value.split(':')[1]));
const timeValid=value=>Number.isSafeInteger(value)&&value>=0;
const sources=new Set(['group-list','friend-list','group-info','stranger-info','cache-seed']);
const cleanName=value=>{if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))return '';const text=value.trim().slice(0,200);return text.isWellFormed()?text:text.toWellFormed();};
function publicRow(row){
 if(!row)return null;
 if(!botValid(row.bot_id)||!keyValid(row.chat_key)||typeof row.name!=='string'||row.name!==cleanName(row.name)||!sources.has(row.source)||!timeValid(row.updated_at)||!timeValid(row.last_checked_at)||row.updated_at>row.last_checked_at||![0,1].includes(row.last_check_ok)||row.last_check_ok===1&&!row.name)throw fail();
 return {botId:row.bot_id,chatKey:row.chat_key,name:row.name,source:row.source,updatedAt:row.updated_at,lastCheckedAt:row.last_checked_at,lastCheckOk:row.last_check_ok===1};
}
export function createChatIdentityStore({file,now=Date.now}={}){
 if(!path.isAbsolute(file||'')||typeof now!=='function')throw fail();
 fs.mkdirSync(path.dirname(file),{recursive:true});const existed=fs.existsSync(file);
 if(existed){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw fail();}
 let db,closed=false;
 try{
  db=new DatabaseSync(file);if(!existed)fs.chmodSync(file,0o600);
  db.exec('PRAGMA busy_timeout=2000');
  if(!existed)db.exec(`BEGIN IMMEDIATE;CREATE TABLE chat_identities(bot_id TEXT NOT NULL,chat_key TEXT NOT NULL,name TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL,last_checked_at INTEGER NOT NULL,last_check_ok INTEGER NOT NULL,PRIMARY KEY(bot_id,chat_key)) STRICT;PRAGMA application_id=${APP};PRAGMA user_version=${VERSION};COMMIT;`);
  if(db.prepare('PRAGMA application_id').get().application_id!==APP||db.prepare('PRAGMA user_version').get().user_version!==VERSION||db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name))!=='["chat_identities"]')throw fail();
  if(JSON.stringify(db.prepare('PRAGMA table_info(chat_identities)').all().map(row=>[row.name,row.type]))!==JSON.stringify([['bot_id','TEXT'],['chat_key','TEXT'],['name','TEXT'],['source','TEXT'],['updated_at','INTEGER'],['last_checked_at','INTEGER'],['last_check_ok','INTEGER']]))throw fail();
  db.exec('PRAGMA journal_mode=WAL');fs.chmodSync(file,0o600);
 }catch{try{db?.close();}catch{}throw fail();}
 const open=()=>{if(closed)throw fail();};
 const scope=(botId,chatKey)=>{open();if(!botValid(botId)||!keyValid(chatKey))throw fail();};
 const service={
  get(botId,chatKey){scope(botId,chatKey);return publicRow(db.prepare('SELECT * FROM chat_identities WHERE bot_id=? AND chat_key=?').get(botId,chatKey));},
  list(botId,keys){open();if(!botValid(botId)||!Array.isArray(keys)||keys.length>10000||keys.some(key=>!keyValid(key)))throw fail();if(!keys.length)return [];return db.prepare('SELECT * FROM chat_identities WHERE bot_id=? AND chat_key IN (SELECT value FROM json_each(?)) ORDER BY chat_key').all(botId,JSON.stringify(keys)).map(publicRow);},
  upsert({botId='primary',chatKey,name='',source,checkedAt=now(),ok=Boolean(cleanName(name))}={}){
   scope(botId,chatKey);if(!sources.has(source)||!timeValid(checkedAt)||typeof ok!=='boolean')throw fail();const cleaned=cleanName(name);
   db.exec('BEGIN IMMEDIATE');
   try{
    const old=service.get(botId,chatKey);if(old&&checkedAt<old.lastCheckedAt){db.exec('COMMIT');return old;}
    const nextName=cleaned||old?.name||'',nextSource=cleaned?source:old?.source||source,updatedAt=cleaned&&cleaned!==old?.name?checkedAt:old?.updatedAt||0;
    db.prepare('INSERT INTO chat_identities VALUES(?,?,?,?,?,?,?) ON CONFLICT(bot_id,chat_key) DO UPDATE SET name=excluded.name,source=excluded.source,updated_at=excluded.updated_at,last_checked_at=excluded.last_checked_at,last_check_ok=excluded.last_check_ok').run(botId,chatKey,nextName,nextSource,updatedAt,checkedAt,ok&&Boolean(cleaned)?1:0);
    db.exec('COMMIT');return service.get(botId,chatKey);
   }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  },
  close(){if(!closed){closed=true;db.close();}}
 };
 return service;
}

export function createChatIdentitySync({store,onebot,knownKeys=()=>[],botId='primary',now=Date.now,ttlMs=300000,negativeTtlMs=15000,intervalMs=30000,timeoutMs=2000,maxMissing=200,onError=()=>{}}={}){
 if(!store||typeof onebot?.call!=='function'||typeof knownKeys!=='function'||!botValid(botId)||![ttlMs,negativeTtlMs,intervalMs,timeoutMs,maxMissing].every(value=>Number.isSafeInteger(value)&&value>0)||maxMissing>200)throw fail();
 let stopped=false,started=false,healthy=true,timer=null,unsubscribe=null,cycle=null,closing=null,active=0,issuedAt=0,missingCursor=0,forceRequested=false;
 const jobs=new Map(),queue=[],cancellers=new Set(),listsUntil={groups:0,friends:0};
 const stamp=()=>issuedAt=Math.max(now(),issuedAt+1);
 const unavailable=()=>{healthy=false;try{onError();}catch{};};
 const read=chatKey=>{if(!healthy)throw fail();return store.get(botId,chatKey);};
 const due=chatKey=>{const row=read(chatKey);return !row||now()-row.lastCheckedAt>=(row.lastCheckOk?ttlMs:negativeTtlMs);};
 const keysOf=keys=>[...new Set((Array.isArray(keys)?keys:[]).filter(keyValid))].slice(0,10000);
 const check=()=>{if(stopped||!healthy)throw fail();};
 async function boundedCall(action,params){
  if(stopped||onebot.connected===false)return null;
  let timer,cancel;const cancelled=new Promise(resolve=>{cancel=()=>resolve(null);cancellers.add(cancel);});
  try{return await Promise.race([Promise.resolve().then(()=>onebot.call(action,params,timeoutMs)).catch(()=>null),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs+100);}),cancelled]);}
  finally{clearTimeout(timer);cancellers.delete(cancel);}
 }
 function pump(){
  while(!stopped&&active<2&&queue.length){const job=queue.shift();active++;
   Promise.resolve().then(job.work).catch(()=>{unavailable();}).finally(()=>{active--;jobs.delete(job.id);job.resolve();pump();});
  }
 }
 function schedule(id,work,urgent=false){
  if(stopped||!healthy)return Promise.resolve();const old=jobs.get(id);
  if(old){if(urgent){const index=queue.indexOf(old);if(index>=0){queue.splice(index,1);queue.unshift(old);}}return old.promise;}
  let resolve;const promise=new Promise(done=>{resolve=done;}),job={id,work,promise,resolve};jobs.set(id,job);if(urgent)queue.unshift(job);else queue.push(job);pump();return promise;
 }
 function observe(rows,kind,checkedAt=stamp()){
  if(stopped||!healthy||!Array.isArray(rows))return;
  try{for(const row of rows.slice(0,10000)){const id=String(kind==='groups'?row?.group_id:row?.user_id),chatKey=(kind==='groups'?'group:':'private:')+id;if(keyValid(chatKey))store.upsert({botId,chatKey,name:kind==='groups'?row.group_name:row.nickname,source:kind==='groups'?'group-list':'friend-list',checkedAt});}}
  catch{unavailable();}
 }
 function bulk(kind,{force=false}={}){
  if(!force&&listsUntil[kind]>now())return Promise.resolve();
  return schedule('list:'+kind,async()=>{const checkedAt=stamp(),rows=await boundedCall(kind==='groups'?'get_group_list':'get_friend_list',{});if(stopped)return;if(Array.isArray(rows)){observe(rows,kind,checkedAt);listsUntil[kind]=now()+ttlMs;}else listsUntil[kind]=now()+negativeTtlMs;});
 }
 function lookup(chatKey,{urgent=false,force=false}={}){
  if(stopped||!healthy||!keyValid(chatKey))return Promise.resolve();
  try{if(!force&&!due(chatKey))return Promise.resolve();}catch{unavailable();return Promise.resolve();}
  return schedule('chat:'+chatKey,async()=>{
   if(stopped||!healthy||!force&&!due(chatKey))return;
   const checkedAt=stamp(),group=chatKey.startsWith('group:'),id=chatKey.split(':')[1],result=await boundedCall(group?'get_group_info':'get_stranger_info',group?{group_id:Number(id)}:{user_id:Number(id)});
   if(stopped)return;const matches=String(group?result?.group_id:result?.user_id)===id,name=matches?(group?result?.group_name:result?.nickname):'';
   store.upsert({botId,chatKey,name,source:group?'group-info':'stranger-info',checkedAt,ok:matches&&Boolean(cleanName(name))});
  },urgent);
 }
 function request(keys){
  if(stopped||!healthy)return;
  const requested=keysOf(keys),missing=requested.filter(key=>{try{return due(key);}catch{unavailable();return false;}});
  const offset=missing.length>maxMissing?missingCursor%missing.length:0,selected=[...missing.slice(offset),...missing.slice(0,offset)].slice(0,maxMissing);
  if(missing.length>maxMissing)missingCursor=(offset+selected.length)%missing.length;
  for(const key of selected)void lookup(key);
 }
 function refresh({force=false}={}){
  if(stopped||!healthy||onebot.connected===false)return Promise.resolve();
  if(cycle){forceRequested ||= force;return cycle;}
  cycle=(async()=>{await Promise.all([bulk('groups',{force}),bulk('friends',{force})]);if(!stopped)request(keysOf(knownKeys()));})().catch(()=>{unavailable();}).finally(()=>{cycle=null;if(forceRequested&&!stopped){forceRequested=false;void refresh({force:true});}});return cycle;
 }
 const service={
  store,
  get(chatKey){check();return read(chatKey);},
  list(keys){check();return store.list(botId,keysOf(keys));},
  request(keys){if(!stopped){void refresh();request(keys);}},
  async ready(keys,{timeoutMs:waitMs=4500}={}){
   check();const requested=keysOf(keys);let rows=service.list(requested);const missing=requested.filter(key=>!rows.some(row=>row.chatKey===key&&row.name));
   if(!missing.length){service.request(requested);return {identities:rows,pending:false};}
   let timer;const cutoff=new Promise(resolve=>{timer=setTimeout(resolve,Math.min(4500,Math.max(1,waitMs)));});
   try{await Promise.race([(async()=>{await Promise.all([bulk('groups'),bulk('friends')]);await Promise.all(missing.slice(0,maxMissing).map(chatKey=>lookup(chatKey,{urgent:true})));})(),cutoff]);}
   finally{clearTimeout(timer);}
   check();rows=service.list(requested);request(requested);
   return {identities:rows,pending:requested.some(chatKey=>jobs.has('chat:'+chatKey))};
  },
  observeGroups(rows,{checkedAt}={}){observe(rows,'groups',checkedAt);},
  observeFriends(rows,{checkedAt}={}){observe(rows,'friends',checkedAt);},
  seedGroups(entries){try{for(const [id,name]of entries||[]){const chatKey='group:'+id;if(keyValid(chatKey)&&!read(chatKey)?.name)store.upsert({botId,chatKey,name,source:'cache-seed',checkedAt:stamp()});}}catch{unavailable();}},
  start(){if(started||stopped)return;started=true;unsubscribe=onebot.onStatus?.(status=>{if(status.connected)void refresh({force:true});});timer=setInterval(()=>void refresh(),intervalMs);timer.unref?.();if(onebot.connected)void refresh({force:true});},
  refresh,
  close(){if(closing)return closing;stopped=true;if(timer)clearInterval(timer);unsubscribe?.();for(const cancel of [...cancellers])cancel();for(const job of queue.splice(0)){jobs.delete(job.id);job.resolve();}return closing=(async()=>{await Promise.all([...jobs.values()].map(job=>job.promise));await cycle;store.close();})();}
 };
 return service;
}
