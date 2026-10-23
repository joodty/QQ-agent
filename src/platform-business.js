// Resource business services. Account/session authority is injected from platform-auth.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { productionPaidCallGuard, setPaidCallFundingServices, validateProductionBudgetConfig, updateProductionBudgetLimits, productionBudgetOverview } from './paid-call-guard.js';
import { updateConfig,DATA_DIR } from './config.js';
import { beijingBudgetDate } from './conversation-budget.js';
import { switchConversationArchive } from './archive-runtime.js';
import { createPlatformCostSummary } from './platform-management-costs.js';
import { createPlatformModelManagement } from './platform-management-model.js';

const APP = 0x51425553;
const fail = (message,statusCode=400) => Object.assign(Error(message),{statusCode});
const money = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1_000_000 && Math.abs(n*1e6-Math.round(n*1e6)) < .00001;
const key = s => typeof s === 'string' && /^(group|private):[1-9]\d*$/.test(s) && Number.isSafeInteger(Number(s.split(':')[1]));
const label = s => typeof s === 'string' && s.length > 0 && s.length <= 200 && !/[\x00-\x1f\x7f]/.test(s);
const json = s => { try { return JSON.parse(s); } catch { throw fail('业务数据损坏，已停止操作',503); } };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uid = prefix => prefix+'-'+crypto.randomUUID();
const exact = (v,allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k=>allowed.includes(k));
const schema = `CREATE TABLE business_meta(name TEXT PRIMARY KEY,value_json TEXT NOT NULL) STRICT;
CREATE TABLE business_personas(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,chat_key TEXT,origin_id TEXT,version INTEGER NOT NULL,public INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE business_credentials(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,endpoint TEXT NOT NULL,model TEXT NOT NULL,iv TEXT NOT NULL,ciphertext TEXT NOT NULL,tag TEXT NOT NULL,version INTEGER NOT NULL,enabled INTEGER NOT NULL,reason TEXT) STRICT;
CREATE TABLE business_funding(chat_key TEXT PRIMARY KEY,owner_id TEXT NOT NULL,mode TEXT NOT NULL,credential_id TEXT,version INTEGER NOT NULL,daily_limit_micros INTEGER,enabled INTEGER NOT NULL) STRICT;
CREATE TABLE business_usage(source_id TEXT NOT NULL,id TEXT NOT NULL,chat_key TEXT NOT NULL,date TEXT NOT NULL,amount_micros INTEGER NOT NULL,payload_json TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(source_id,id)) STRICT;
CREATE INDEX business_usage_scope ON business_usage(chat_key,date);`;

export function createPlatformBusiness({file,keyFile=typeof file==='string'?file+'.key':null,archives,store,orchestrator,auth,config,installFunding=true}={}) {
  if (!path.isAbsolute(file || '') || !path.isAbsolute(keyFile || '') || !archives || !auth || typeof config !== 'function' || typeof auth.canUseResourceOwner !== 'function') throw fail('业务服务缺少可信依赖',503);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const exists=fs.existsSync(file), db=new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=10000');
    if(!exists)db.exec('BEGIN IMMEDIATE;'+schema+`PRAGMA application_id=${APP}; PRAGMA user_version=1; COMMIT;`);
    if(db.prepare('PRAGMA application_id').get().application_id!==APP||db.prepare('PRAGMA user_version').get().user_version!==1||db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw fail('业务库身份或版本损坏',503);
  }catch(e){db.close();throw e;}
  let master;
  try {
    if(!fs.existsSync(keyFile)) {
      if(db.prepare('SELECT 1 FROM business_credentials LIMIT 1').get())throw fail('加密主密钥缺失，不能替换已有凭据',503);
      fs.writeFileSync(keyFile,crypto.randomBytes(32).toString('base64'),{flag:'wx',mode:0o600});
    }
    const info=fs.lstatSync(keyFile);if(!info.isFile()||info.isSymbolicLink()||process.platform!=='win32'&&(info.mode&0o077))throw fail('加密主密钥文件类型或权限异常',503);
    const encodedKey=fs.readFileSync(keyFile,'utf8').trim();master=Buffer.from(encodedKey,'base64');if(master.length!==32||master.toString('base64')!==encodedKey)throw fail('加密主密钥格式无效',503);
    archives.upgradeSchema();
  }catch(e){db.close();throw e;}
  const transact = work => { db.exec('BEGIN IMMEDIATE');try{const result=work();db.exec('COMMIT');return result;}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;} };
  const fresh = principal => auth.verifyPrincipal(principal);
  const scope = (principal,chatKey,write=false) => { const p=fresh(principal);if(!key(chatKey)||!auth.canAccess(p,chatKey,{botId:'primary',write}))throw fail('没有这个聊天的管理权限',403);return p; };
  const admin = principal => {const p=fresh(principal);if(p.role!=='admin')throw fail('仅平台管理员可修改平台默认配置',403);return p;};
  const settings = () => ({trialEnabled:true,trialDailyLimitCny:.1,trialPlatformDailyLimitCny:1,trialInitialSpent:{},...json(db.prepare("SELECT value_json FROM business_meta WHERE name='settings'").get()?.value_json || '{}')});
  const writeSettings = value => db.prepare("INSERT INTO business_meta VALUES('settings',?) ON CONFLICT(name) DO UPDATE SET value_json=excluded.value_json").run(JSON.stringify(value));
  const providers = () => {const p=validateProductionBudgetConfig(config());return [{endpoint:p.endpoint,model:p.model,prices:p.prices,responseModels:p.verifiedResponseModels||[],imageTokensPerImage:p.imageTokensPerImage},...(config().productionBudget.approvedProviders||[])].filter(v=>{try{const u=new URL(v.endpoint);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&v.model&&v.prices?.reasoningIncluded===true&&['inputCnyPerMillion','cacheHitCnyPerMillion','outputCnyPerMillion'].every(k=>typeof v.prices[k]==='number'&&Number.isFinite(v.prices[k])&&v.prices[k]>=0);}catch{return false;}});};
  const approved = (endpoint,model) => providers().find(p=>p.endpoint.replace(/\/+$/,'')===String(endpoint).replace(/\/+$/,'')&&p.model===model);
  const seal = (text,aad) => {const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',master,iv);cipher.setAAD(Buffer.from(aad));return {iv:iv.toString('base64'),ciphertext:Buffer.concat([cipher.update(text,'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};};
  const aad = row => JSON.stringify([row.id,row.owner_id,row.endpoint,row.model,row.version]);
  const unseal = row => {try{const cipher=crypto.createDecipheriv('aes-256-gcm',master,Buffer.from(row.iv,'base64'));cipher.setAAD(Buffer.from(aad(row)));cipher.setAuthTag(Buffer.from(row.tag,'base64'));return Buffer.concat([cipher.update(Buffer.from(row.ciphertext,'base64')),cipher.final()]).toString('utf8');}catch{throw fail('凭据无法解密，已停止付费调用',503);}};
  const fundingRow = chatKey => db.prepare('SELECT * FROM business_funding WHERE chat_key=?').get(chatKey);
  // Imported member cards retain their stable account owner. Other imported cards
  // remain private to their associated chats; they are not public templates.
  for(const p of archives.personas()){const source=p.history.find(h=>h?.kind==='legacy-member-card-source');if(label(source?.ownerUserId))db.prepare('INSERT INTO business_personas VALUES(?,?,?,?,?,0) ON CONFLICT DO NOTHING').run(p.id,source.ownerUserId,null,null,p.version);}
  const credentialView = row => ({id:row.id,name:row.name,endpoint:row.endpoint,model:row.model,enabled:row.enabled===1,version:row.version,hasKey:Boolean(row.ciphertext),reason:row.reason||null});
  function resolveFunding(chatKey) {
    const row=fundingRow(chatKey);if(!row)return null;
    if(!row.enabled||row.mode==='disabled'||!auth.canUseResourceOwner(row.owner_id,chatKey,{botId:'primary'}))return {blocked:true};
    const stamp=hash(auth.permissionVersion?.(row.owner_id,chatKey,{botId:'primary'})||'initial').slice(0,20);
    const p=validateProductionBudgetConfig(config()),base={id:row.mode+':'+row.chat_key+':'+stamp,version:row.version,mode:row.mode,ownerId:row.owner_id,scopeAuthorized:true,endpoint:p.endpoint,model:p.model,prices:p.prices,responseModels:p.verifiedResponseModels||[],imageTokensPerImage:p.imageTokensPerImage};
    if(row.mode==='byok') {
      const c=db.prepare('SELECT * FROM business_credentials WHERE id=? AND owner_id=?').get(row.credential_id,row.owner_id),catalog=c&&approved(c.endpoint,c.model);
      if(!c?.enabled||!catalog)return {blocked:true};
      return {...base,id:'byok:'+c.id+':'+stamp,version:row.version*1_000_000+c.version,credentialRef:c.id,endpoint:catalog.endpoint,model:catalog.model,prices:catalog.prices,responseModels:catalog.responseModels||[],imageTokensPerImage:catalog.imageTokensPerImage,apiKey:unseal(c)};
    }
    if(row.mode==='trial'&&(!settings().trialEnabled||!chatKey.startsWith('private:')))return {blocked:true};
    return base;
  }
  function effectiveFunding(chatKey) {const row=fundingRow(chatKey),p=validateProductionBudgetConfig(config()),limit=p.overrides[chatKey]??p.defaultDailyLimitCny;if(!row)return {chatKey,mode:p.funding[chatKey]?.enabled&&p.funding[chatKey]?.mode==='platform'?'platform':'disabled',version:0,credentialRef:null,enabled:Boolean(p.funding[chatKey]?.enabled),dailyLimitCny:limit};const source=resolveFunding(chatKey);return {chatKey,mode:row.mode,version:row.version,credentialRef:row.credential_id,enabled:!source?.blocked,dailyLimitCny:row.mode==='trial'?Math.min(limit,row.daily_limit_micros===null?settings().trialDailyLimitCny:row.daily_limit_micros/1e6):limit};}
  function policyOverlay(){const overrides={},p=validateProductionBudgetConfig(config()),rows=db.prepare('SELECT * FROM business_funding WHERE enabled=1').all();for(const row of rows)if(row.mode==='trial')overrides[row.chat_key]=Math.min(row.daily_limit_micros===null?settings().trialDailyLimitCny:row.daily_limit_micros/1e6,p.overrides[row.chat_key]??Infinity);const s=settings();return {overrides,scopeKeys:rows.map(row=>row.chat_key),trial:{dailyLimitCny:s.trialPlatformDailyLimitCny,initialSpent:s.trialInitialSpent}};}
  if(installFunding)setPaidCallFundingServices({resolve:resolveFunding,policy:policyOverlay});
  function visiblePersonas(principal,chatKey) {
    const p=scope(principal,chatKey),associated=new Set(archives.list(chatKey).map(a=>a.personaId));
    const owners=new Map(db.prepare('SELECT * FROM business_personas').all().map(r=>[r.id,r]));
    return archives.personas().filter(v=>{const own=owners.get(v.id);return p.role==='admin'||own?.owner_id===p.id||own?.public===1||associated.has(v.id);}).map(v=>{const own=owners.get(v.id);return {id:v.id,name:v.name,content:v.content,version:own?.version??v.version,editable:p.role==='admin'||own?.owner_id===p.id,historyCount:v.history.filter(x=>x?.kind==='qq-agent-persona-revision').length,originId:own?.origin_id||null};});
  }
  const managementCosts=createPlatformCostSummary({file:path.join(DATA_DIR,'paid-calls.sqlite'),auth,legacyUsage({from,to,keys}){
    return db.prepare("SELECT date,chat_key chatKey,SUM(amount_micros) amountMicros FROM business_usage WHERE date BETWEEN ? AND ? AND COALESCE(json_extract(payload_json,'$.botId'),'primary')='primary'"+(keys===null?'':" AND chat_key IN (SELECT value FROM json_each(?))")+' GROUP BY date,chat_key').all(...[from,to,...(keys===null?[]:[JSON.stringify(keys)])]);
  }});
  const modelManagement=createPlatformModelManagement({auth,config,providers,onChanged(){
    const keys=new Set([...Object.keys(config().productionBudget?.funding||{}),...(store?.listChats?.()||[]),...db.prepare('SELECT chat_key FROM business_funding').all().map(row=>row.chat_key)]);
    for(const chatKey of keys)if(key(chatKey)){const source=effectiveFunding(chatKey);if(source.enabled&&source.mode!=='byok')orchestrator?.archiveChanged?.(chatKey);}
  }});
  const service={
    costSummary(principal,input){return managementCosts.summary(principal,input);},
    managementOverview(principal,input){const p=admin(principal),costs=managementCosts.summary(p,input,true),resources=new Set([...auth.listScopes(p,{botId:'primary'}),...Object.keys(config().productionBudget?.funding||{}),...(store?.listChats?.()||[]),...db.prepare('SELECT chat_key FROM business_funding').all().map(row=>row.chat_key)]);return {scope:'platform',costs,conversationCount:[...resources].filter(key).length};},
    platformModel(principal){return modelManagement.get(principal);},
    updatePlatformModel(principal,input){return modelManagement.update(principal,input);},
    runtimeAllowed(chatKey){try{const source=resolveFunding(chatKey),p=validateProductionBudgetConfig(config());return Boolean(source&&!source.blocked||!source&&p.funding[chatKey]?.mode==='platform'&&p.funding[chatKey]?.enabled);}catch{return false;}},
    overview(principal,{summary=false}={}){
      const p=fresh(principal),keys=auth.listScopes(p,{botId:'primary'}),guard=productionPaidCallGuard();
      return {role:p.role,providers:providers().map(({endpoint,model,prices})=>({endpoint,model,prices,currency:'CNY'})),
        ...(summary?{accountId:p.id,credentialCount:db.prepare('SELECT COUNT(*) count FROM business_credentials WHERE owner_id=?').get(p.id).count}:{}),
        scopes:keys.map(chatKey=>{
          const archiveList=archives.list(chatKey);
          // list() reads indexed metadata only. A home-page summary must not
          // load every selected persona body or enumerate all visible cards.
          const selected=summary?archives.activeSummary(chatKey):archives.active(chatKey);
          return {chatKey,kind:chatKey.split(':')[0],selected,archives:archiveList,
            ...(summary?{}:{personaOptions:visiblePersonas(p,chatKey)}),budget:guard.status(chatKey),funding:effectiveFunding(chatKey)};
        })};
    },
    personas(principal,chatKey){return {personas:visiblePersonas(principal,chatKey)};},
    createPersona(principal,fields){if(!exact(fields,['chatKey','name','content']))throw fail('人设字段无效');const p=scope(principal,fields.chatKey,true);const v=archives.createPersona({name:fields.name,content:fields.content});db.prepare('INSERT INTO business_personas VALUES(?,?,?,?,?,0)').run(v.id,p.id,fields.chatKey,null,1);return {persona:{...v,editable:true,historyCount:0}};},
    updatePersona(principal,fields){if(!exact(fields,['chatKey','id','expectedVersion','name','content']))throw fail('人设字段无效');const p=scope(principal,fields.chatKey,true),before=visiblePersonas(p,fields.chatKey).find(v=>v.id===fields.id);if(!before)throw fail('人设不可见',404);if(!before.editable)throw fail('请复制他人的角色后编辑',403);if(before.version!==fields.expectedVersion||db.prepare('SELECT 1 FROM business_personas WHERE origin_id=?').get(fields.id))throw fail('已有新版本，请刷新后基于最新版本编辑',409);const next=archives.createPersona({name:fields.name??before.name,content:fields.content??before.content,version:before.version+1,history:[{kind:'qq-agent-persona-revision',version:before.version,name:before.name,content:before.content}]});db.prepare('INSERT INTO business_personas VALUES(?,?,?,?,?,0)').run(next.id,(db.prepare('SELECT owner_id FROM business_personas WHERE id=?').get(fields.id)?.owner_id||p.id),fields.chatKey,fields.id,before.version+1);return {persona:{...next,editable:true,originId:fields.id},previousPersonaId:fields.id};},
    personaHistory(principal,{chatKey,id:personaId}){scope(principal,chatKey);const visible=visiblePersonas(principal,chatKey),first=visible.find(v=>v.id===personaId);if(!first)throw fail('人设不可见',404);if(!first.editable)throw fail('完整版本历史仅向角色拥有者和平台管理员开放',403);const versions=[],visited=new Set(),native=new Map(archives.personas().map(v=>[v.id,v]));let current=first;while(current&&!visited.has(current.id)){visited.add(current.id);const prior=versions.find(v=>v.version===current.version&&v.content===current.content);if(prior){prior.id=current.id;delete prior.legacy;}else versions.push({id:current.id,version:current.version,name:current.name,content:current.content});for(const h of native.get(current.id)?.history||[])if(Number.isSafeInteger(h?.version)&&h.version>=1&&typeof h.content==='string'&&typeof h.name==='string'&&!versions.some(v=>v.version===h.version&&v.content===h.content))versions.push({id:null,version:h.version,name:h.name,content:h.content,legacy:true});current=visible.find(v=>v.id===current.originId);}return {id:personaId,versions:versions.sort((a,b)=>b.version-a.version)};},
    createArchive(principal,fields){if(!exact(fields,['chatKey','personaId','expectedSelectionVersion']))throw fail('新档案字段无效');const p=scope(principal,fields.chatKey,true);if(!visiblePersonas(p,fields.chatKey).some(v=>v.id===fields.personaId))throw fail('人设不可见',403);const selected=archives.createArchive(fields);orchestrator?.archiveChanged?.(fields.chatKey);return {selected};},
    applyPersona(principal,fields){if(!exact(fields,['chatKey','personaId','expectedSelectionVersion','newConversation'])||fields.newConversation!==undefined&&typeof fields.newConversation!=='boolean')throw fail('应用人设字段无效');const p=scope(principal,fields.chatKey,true);if(!visiblePersonas(p,fields.chatKey).some(v=>v.id===fields.personaId))throw fail('人设不可见',403);const previous=!fields.newConversation&&archives.list(fields.chatKey).filter(a=>a.continuation==='ready'&&a.personaId===fields.personaId).sort((a,b)=>b.lastUsedAt-a.lastUsedAt||a.id.localeCompare(b.id))[0];if(previous)return {...service.selectArchive(p,{chatKey:fields.chatKey,archiveId:previous.id,expectedVersion:fields.expectedSelectionVersion}),reused:true};return {...service.createArchive(p,{chatKey:fields.chatKey,personaId:fields.personaId,expectedSelectionVersion:fields.expectedSelectionVersion}),reused:false};},
    messages(principal,{chatKey,archiveId,limit=100}){scope(principal,chatKey);if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw fail('消息条数无效');const state=archives.readChat(chatKey,archiveId);return {archiveId:state?.archiveId||null,messages:(state?.messages||[]).slice(-limit).map(({id,senderName,text,ts,self})=>({id,senderName,text,ts,self}))};},
    selectArchive(principal,fields){if(!exact(fields,['chatKey','archiveId','expectedVersion']))throw fail('切换档案字段无效');scope(principal,fields.chatKey,true);return {selected:switchConversationArchive({store,orchestrator,...fields})};},
    credentials(principal){const p=fresh(principal);return {credentials:db.prepare('SELECT * FROM business_credentials WHERE owner_id=? ORDER BY name,id').all(p.id).map(credentialView)};},
    saveCredential(principal,fields){const p=fresh(principal);if(!exact(fields,['id','expectedVersion','name','endpoint','model','apiKey','enabled'])||!label(fields.name)||fields.enabled!==undefined&&typeof fields.enabled!=='boolean'||fields.apiKey!==undefined&&typeof fields.apiKey!=='string')throw fail('API配置字段无效');const catalog=approved(fields.endpoint,fields.model);if(!catalog)throw fail('端点或模型不在平台批准且有完整报价的目录中');return transact(()=>{const old=fields.id?db.prepare('SELECT * FROM business_credentials WHERE id=? AND owner_id=?').get(fields.id,p.id):null;if(fields.id&&!old)throw fail('API配置不存在',404);if(old&&fields.expectedVersion!==old.version)throw fail('API配置已被修改',409);if(old&&old.endpoint!==catalog.endpoint&&!fields.apiKey?.trim())throw fail('更换API服务地址必须明确填写该服务的新Key');const secret=fields.apiKey?.trim()||(old?unseal(old):'');if(!secret||secret.length>8192||/[\x00-\x1f\x7f]/.test(secret))throw fail('请填写有效API Key');const row={id:old?.id||uid('credential'),owner_id:p.id,name:fields.name,endpoint:catalog.endpoint,model:catalog.model,version:(old?.version||0)+1,enabled:fields.enabled===false?0:1};const encrypted=seal(secret,aad(row));db.prepare('INSERT INTO business_credentials VALUES(?,?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET name=excluded.name,endpoint=excluded.endpoint,model=excluded.model,iv=excluded.iv,ciphertext=excluded.ciphertext,tag=excluded.tag,version=excluded.version,enabled=excluded.enabled,reason=NULL').run(row.id,row.owner_id,row.name,row.endpoint,row.model,encrypted.iv,encrypted.ciphertext,encrypted.tag,row.version,row.enabled);return {credential:credentialView({...row,...encrypted})};});},
    funding(principal,chatKey){scope(principal,chatKey);return effectiveFunding(chatKey);},
    setFunding(principal,fields){if(!exact(fields,['chatKey','mode','credentialRef','expectedVersion','dailyLimitCny'])||!['platform','byok','disabled'].includes(fields.mode)||fields.dailyLimitCny!==undefined&&!money(fields.dailyLimitCny))throw fail('出资配置无效');const p=scope(principal,fields.chatKey,true);return transact(()=>{const old=fundingRow(fields.chatKey);if(fields.expectedVersion!==undefined&&fields.expectedVersion!==(old?.version??0))throw fail('出资配置已变更',409);let mode=fields.mode;if(mode==='platform'&&p.role!=='admin'){if(fields.chatKey!=='private:'+p.boundQQ||!settings().trialEnabled)throw fail('平台体验仅支持绑定本人的私聊',403);if(fields.dailyLimitCny!==undefined&&fields.dailyLimitCny>settings().trialDailyLimitCny)throw fail('不能提高平台体验额度',403);mode='trial';}if(mode==='byok'&&!db.prepare('SELECT 1 FROM business_credentials WHERE id=? AND owner_id=? AND enabled=1').get(fields.credentialRef,p.id))throw fail('请使用自己已启用的API配置',403);db.prepare('INSERT INTO business_funding VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_key) DO UPDATE SET owner_id=excluded.owner_id,mode=excluded.mode,credential_id=excluded.credential_id,version=excluded.version,daily_limit_micros=excluded.daily_limit_micros,enabled=excluded.enabled').run(fields.chatKey,p.id,mode,mode==='byok'?fields.credentialRef:null,(old?.version??0)+1,mode==='trial'&&old?.mode==='trial'?old.daily_limit_micros:null,mode==='disabled'?0:1);if(mode!=='disabled'&&fields.dailyLimitCny!==undefined)updateConfig({productionBudget:{overrides:{[fields.chatKey]:fields.dailyLimitCny}}});orchestrator?.archiveChanged?.(fields.chatKey);return effectiveFunding(fields.chatKey);});},
    budgets(principal){const p=fresh(principal),guard=productionPaidCallGuard(),native=p.role==='admin'?productionBudgetOverview():null;return {currency:'CNY',estimated:true,...(native?{version:native.version,defaultDailyLimitCny:native.defaultDailyLimitCny,overrides:native.overrides}:{}),settings:p.role==='admin'?settings():{trialDailyLimitCny:settings().trialDailyLimitCny},...(p.role==='admin'?{trialPlatformBudget:guard.trialStatus()}:{}),conversations:auth.listScopes(p).map(chatKey=>({...guard.status(chatKey),funding:effectiveFunding(chatKey)}))};},
    updateBudget(principal,patch){const p=fresh(principal);if(p.role==='admin'){if(!exact(patch,['version','defaultDailyLimitCny','overrides','trialEnabled','trialDailyLimitCny','trialPlatformDailyLimitCny']))throw fail('额度字段无效');const s=settings();for(const k of ['trialDailyLimitCny','trialPlatformDailyLimitCny'])if(Object.hasOwn(patch,k)){if(!money(patch[k]))throw fail('体验额度无效');s[k]=patch[k];}if(Object.hasOwn(patch,'trialEnabled')){if(typeof patch.trialEnabled!=='boolean')throw fail('体验开关无效');s.trialEnabled=patch.trialEnabled;}if(Object.keys(patch).some(k=>['version','defaultDailyLimitCny','overrides'].includes(k)))updateProductionBudgetLimits(Object.fromEntries(Object.entries(patch).filter(([k])=>['version','defaultDailyLimitCny','overrides'].includes(k))));writeSettings(s);return service.budgets(p);}if(!exact(patch,['chatKey','dailyLimitCny'])||!money(patch.dailyLimitCny))throw fail('仅可修改自己出资聊天的每日额度');scope(p,patch.chatKey,true);const row=fundingRow(patch.chatKey);if(row?.owner_id!==p.id||row.mode!=='byok')throw fail('不能提高平台或他人的额度',403);updateConfig({productionBudget:{overrides:{[patch.chatKey]:patch.dailyLimitCny}}});return service.budgets(p);},
    usage(principal,{chatKey,date}={}){const p=fresh(principal),keys=chatKey?[scope(p,chatKey),chatKey][1]&&[chatKey]:auth.listScopes(p),guard=productionPaidCallGuard(),days=new Map();const add=(d,k,m)=>{const id=d+'|'+k,old=days.get(id)||{date:d,chatKey:k,amountCny:0};old.amountCny=(Math.round(old.amountCny*1e6)+m)/1e6;days.set(id,old);};for(const k of keys){for(const row of db.prepare('SELECT * FROM business_usage WHERE chat_key=?'+(date?' AND date=?':'')).all(...[k,...(date?[date]:[])]))if((json(row.payload_json).botId||'primary')==='primary')add(row.date,k,row.amount_micros);for(const row of guard.records({key:k,...(date?{date}:{})}))if(row.state==='settled'&&!row.operationId.startsWith('seed:'))add(row.date,k,Math.round(row.actualCny*1e6));}return {currency:'CNY',estimated:true,date:beijingBudgetDate(),conversations:[...days.values()].sort((a,b)=>b.date.localeCompare(a.date)),estimationBoundary:'历史口径保留、模型token及语音字符按标准价格的平台估算，非供应商账单；腾讯云免费资源包抵扣未同步，导入历史不重复叠加初始化seed。'};},
    // Offline migration only. No HTTP route exposes plaintext import bundles.
    importLegacyState(input,{dryRun=true}={}){
      if(!exact(input,['format','version','sourceId','credentials','funding','usage','settings'])||input.format!=='qq-bridge-business'||input.version!==1||!label(input.sourceId)||!['credentials','funding','usage'].every(k=>Array.isArray(input[k])&&input[k].length<=100000)||typeof dryRun!=='boolean')throw fail('旧业务导入格式无效');
      const report={dryRun,profilesMapped:0,profilesDisabled:0,fundingMapped:0,fundingDisabled:0,usageAdded:0,foreignUsageRetained:0,unchanged:0,disabledReasons:{},settingsImported:false};
      const tasks=[],profileIds=new Set(),profileOwners=new Map(),disabledProfiles=new Set(),recordIds=new Set();
      const remember=(kind,id,value)=>{const name='import:'+input.sourceId+':'+kind+':'+id,valueHash=hash(value),old=db.prepare('SELECT value_json FROM business_meta WHERE name=?').get(name);if(old){if(json(old.value_json)!==valueHash)throw fail('同来源记录发生冲突，拒绝覆盖',409);report.unchanged++;return false;}tasks.push(()=>db.prepare('INSERT INTO business_meta VALUES(?,?)').run(name,JSON.stringify(valueHash)));return true;};
      const disabled=reason=>report.disabledReasons[reason]=(report.disabledReasons[reason]||0)+1;
      for(const c of input.credentials){
        if(!exact(c,['id','ownerId','name','endpoint','model','apiKey','enabled','version','reason'])||!label(c.id)||!label(c.ownerId)||!label(c.name)||typeof c.endpoint!=='string'||!label(c.model)||typeof c.apiKey!=='string'||c.apiKey.length>8192||/[\x00-\x1f\x7f]/.test(c.apiKey)||typeof c.enabled!=='boolean'||!Number.isSafeInteger(c.version)||c.version<1||profileIds.has(c.id))throw fail('旧凭据字段无效');
        profileIds.add(c.id);profileOwners.set(c.id,c.ownerId);const catalog=approved(c.endpoint,c.model),reason=!catalog?'UNAPPROVED_PROVIDER_OR_PRICE':!c.apiKey?'MISSING_KEY':['FOREIGN_BOT_DATA_ONLY','DELETED','OWNER_SCOPE_NOT_AUTHORIZED'].includes(c.reason)?c.reason:!c.enabled?'LEGACY_DISABLED':c.reason?'LEGACY_PROVIDER_REJECTED':null;
        if(reason){disabledProfiles.add(c.id);report.profilesDisabled++;disabled(reason);}else report.profilesMapped++;
        if(!remember('credential',c.id,c))continue;
        if(db.prepare('SELECT 1 FROM business_credentials WHERE id=?').get(c.id))throw fail('凭据ID已存在且来源不一致',409);
        tasks.push(()=>{const row={id:c.id,owner_id:c.ownerId,endpoint:catalog?.endpoint||c.endpoint,model:c.model,version:c.version},sealed=seal(c.apiKey,aad(row));db.prepare('INSERT INTO business_credentials VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(c.id,c.ownerId,c.name,row.endpoint,c.model,sealed.iv,sealed.ciphertext,sealed.tag,c.version,reason?0:1,reason);});
      }
      for(const f of input.funding){
        if(!exact(f,['chatKey','ownerId','mode','credentialRef','version','enabled','botId','dailyLimitCny'])||!label(f.ownerId)||!['byok','trial','platform','disabled'].includes(f.mode)||!Number.isSafeInteger(f.version)||f.version<1||typeof f.enabled!=='boolean'||f.dailyLimitCny!==undefined&&!money(f.dailyLimitCny))throw fail('旧出资字段无效');
        const foreign=f.botId&&f.botId!=='primary';if(!foreign&&!key(f.chatKey))throw fail('旧出资聊天标识无效');
        if(f.mode==='byok'&&(!label(f.credentialRef)||(profileOwners.get(f.credentialRef)||db.prepare('SELECT owner_id FROM business_credentials WHERE id=?').get(f.credentialRef)?.owner_id)!==f.ownerId))throw fail('旧出资引用他人的凭据或凭据不存在',409);
        const reason=foreign?'FOREIGN_BOT_DATA_ONLY':!f.enabled?'LEGACY_DISABLED':!auth.canUseResourceOwner(f.ownerId,f.chatKey,{botId:'primary'})?'OWNER_SCOPE_NOT_AUTHORIZED':f.mode==='byok'&&disabledProfiles.has(f.credentialRef)?'DISABLED_CREDENTIAL':null;
        if(reason){report.fundingDisabled++;disabled(reason);}else report.fundingMapped++;
        if(!remember('funding',(f.botId||'primary')+':'+(f.chatKey||f.ownerId),f))continue;
        if(foreign)continue;
        if(db.prepare('SELECT 1 FROM business_funding WHERE chat_key=?').get(f.chatKey))throw fail('聊天出资已有运行配置，不覆盖',409);
        tasks.push(()=>db.prepare('INSERT INTO business_funding VALUES(?,?,?,?,?,?,?)').run(f.chatKey,f.ownerId,f.mode,f.credentialRef||null,f.version,f.dailyLimitCny===undefined?null:Math.round(f.dailyLimitCny*1e6),reason?0:1));
      }
      for(const row of input.usage){
        if(!exact(row,['id','chatKey','date','amountCny','model','ownerId','fundingMode','tokens','provider','botId'])||!label(row.id)||recordIds.has(row.id)||!key(row.chatKey)||typeof row.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.date)||new Date(row.date+'T00:00:00Z').toISOString().slice(0,10)!==row.date||typeof row.amountCny!=='number'||!Number.isFinite(row.amountCny)||row.amountCny<0||row.amountCny>1e6)throw fail('旧费用记录无效');
        recordIds.add(row.id);const payload=JSON.stringify(row),valueHash=hash(row),old=db.prepare('SELECT hash FROM business_usage WHERE source_id=? AND id=?').get(input.sourceId,row.id);
        if(old){if(old.hash!==valueHash)throw fail('同来源费用记录冲突',409);report.unchanged++;continue;}
        report.usageAdded++;if(row.botId&&row.botId!=='primary')report.foreignUsageRetained++;tasks.push(()=>db.prepare('INSERT INTO business_usage VALUES(?,?,?,?,?,?,?)').run(input.sourceId,row.id,row.chatKey,row.date,Math.ceil(row.amountCny*1e6-1e-7),payload,valueHash));
      }
      if(input.settings){const s={...settings(),...input.settings};if(!exact(input.settings,['trialEnabled','trialDailyLimitCny','trialPlatformDailyLimitCny','trialInitialSpent'])||typeof s.trialEnabled!=='boolean'||!money(s.trialDailyLimitCny)||!money(s.trialPlatformDailyLimitCny)||!s.trialInitialSpent||typeof s.trialInitialSpent!=='object'||Array.isArray(s.trialInitialSpent)||Object.entries(s.trialInitialSpent).some(([d,m])=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||!money(m)))throw fail('旧体验费用策略无效');if(remember('settings','platform',input.settings)){tasks.push(()=>writeSettings(s));report.settingsImported=true;}}
      if(!dryRun)transact(()=>{for(const task of tasks)task();});
      return report;
    },
    close(){if(installFunding)setPaidCallFundingServices(null);master.fill(0);db.close();},
  };
  return service;
}
