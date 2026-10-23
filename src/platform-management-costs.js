// Read-only cross-conversation reporting. Only the primary ledger counts money;
// speech/trial auxiliary holds and imported initial-spent seeds are excluded.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {beijingBudgetDate} from './conversation-budget.js';
const fail=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const key=x=>typeof x==='string'&&/^(group|private):[1-9]\d*$/.test(x)&&Number.isSafeInteger(Number(x.split(':')[1]));
const date=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&Number.isFinite(Date.parse(x+'T00:00:00Z'))&&new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
const empty=()=>({modelMicros:0,speechMicros:0,legacyMicros:0,reservedMicros:0,unknownMicros:0});
const names=Object.keys(empty());
function add(target,source){for(const name of names){const value=source[name]??0;if(!Number.isSafeInteger(value)||value<0||!Number.isSafeInteger(target[name]+value))throw fail('费用统计数据异常',503);target[name]+=value;}}
const view=value=>{const total=value.modelMicros+value.speechMicros+value.legacyMicros;if(!Number.isSafeInteger(total))throw fail('费用统计数据异常',503);return {modelCny:value.modelMicros/1e6,speechCny:value.speechMicros/1e6,legacyCny:value.legacyMicros/1e6,totalCny:total/1e6,reservedCny:value.reservedMicros/1e6,unknownCny:value.unknownMicros/1e6};};
const sql=`WITH attrs AS MATERIALIZED (
 SELECT a.key id,json_extract(a.value,'$.key') chatKey,json_extract(a.value,'$.kind') kind
 FROM paid_documents d,json_each(d.body) a WHERE d.name='call-attribution'
), records AS MATERIALIZED (
 SELECT json_extract(r.value,'$.id') id,json_extract(r.value,'$.key') chatKey,json_extract(r.value,'$.date') date,
 json_extract(r.value,'$.operationId') operationId,json_extract(r.value,'$.state') state,
 json_extract(r.value,'$.amountMicros') amount,json_extract(r.value,'$.actualMicros') actual,
 json_type(r.value,'$.amountMicros') amountType,json_type(r.value,'$.actualMicros') actualType
 FROM paid_documents d,json_each(d.body,'$.records') r WHERE d.name='conversation-budget'
 AND json_extract(r.value,'$.date') BETWEEN ? AND ?
 AND json_extract(r.value,'$.operationId') NOT LIKE 'seed:%'
 AND (? IS NULL OR json_extract(r.value,'$.key') IN (SELECT value FROM json_each(?)))
)
SELECT r.chatKey,r.date,
 SUM(COALESCE(r.amountType,'missing')!='integer' OR r.amount<0 OR (r.state='settled' AND (COALESCE(r.actualType,'missing')!='integer' OR r.actual<0)) OR r.state IS NULL OR r.state NOT IN ('reserved','dispatched','unknown','settled','released') OR (r.operationId LIKE 'service:speech:%' AND (a.id IS NULL OR COALESCE(a.kind,'missing')!='speech')) OR (a.kind='speech' AND r.operationId NOT LIKE 'service:speech:%')) invalid,
 SUM(CASE WHEN r.state='settled' AND r.operationId NOT LIKE 'service:speech:%' THEN r.actual ELSE 0 END) modelMicros,
 SUM(CASE WHEN r.state='settled' AND r.operationId LIKE 'service:speech:%' THEN r.actual ELSE 0 END) speechMicros,
 SUM(CASE WHEN r.state IN ('reserved','dispatched','unknown') THEN r.amount ELSE 0 END) reservedMicros,
 SUM(CASE WHEN r.state='unknown' THEN r.amount ELSE 0 END) unknownMicros
 FROM records r LEFT JOIN attrs a ON a.id=r.id AND a.chatKey=r.chatKey GROUP BY r.chatKey,r.date ORDER BY r.date DESC,r.chatKey`;
// Validate critical primary fields before applying the date/scope/seed filters.
// Otherwise SQL NULL comparisons could silently hide a corrupted charged row.
const invalidPrimarySql=`WITH rows AS MATERIALIZED (
 SELECT r.value,json_extract(r.value,'$.key') chatKey,json_extract(r.value,'$.date') day,
 json_extract(r.value,'$.id') id,json_extract(r.value,'$.operationId') operationId,
 json_extract(r.value,'$.state') state FROM paid_documents d,json_each(d.body,'$.records') r WHERE d.name='conversation-budget'
)
SELECT COUNT(*) count,COUNT(DISTINCT id) uniqueIds,SUM(
 json_type(value) IS NOT 'object' OR json_type(value,'$.id') IS NOT 'text' OR length(id)<1
 OR json_type(value,'$.key') IS NOT 'text' OR NOT COALESCE(
 substr(chatKey,1,instr(chatKey,':')-1) IN ('group','private') AND length(substr(chatKey,instr(chatKey,':')+1)) BETWEEN 1 AND 16
 AND substr(chatKey,instr(chatKey,':')+1) GLOB '[1-9]*' AND substr(chatKey,instr(chatKey,':')+1) NOT GLOB '*[^0-9]*'
 AND CAST(substr(chatKey,instr(chatKey,':')+1) AS INTEGER)<=9007199254740991,0)
 OR json_type(value,'$.date') IS NOT 'text' OR NOT COALESCE(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND strftime('%Y-%m-%d',day||'T00:00:00Z')=day,0)
 OR json_type(value,'$.operationId') IS NOT 'text' OR length(operationId) NOT BETWEEN 1 AND 200
 OR json_type(value,'$.amountMicros') IS NOT 'integer' OR json_extract(value,'$.amountMicros') NOT BETWEEN 1 AND 1000000000000
 OR NOT COALESCE(state IN ('reserved','dispatched','unknown','settled','released'),0)
 OR (state='settled' AND (json_type(value,'$.actualMicros') IS NOT 'integer' OR json_extract(value,'$.actualMicros') NOT BETWEEN 0 AND 1000000000000))
 OR (state!='settled' AND json_type(value,'$.actualMicros') IS NOT 'null')
) invalid FROM rows`;

export function createPlatformCostSummary({file,auth,legacyUsage=()=>[],now=Date.now}={}){
 if(!path.isAbsolute(file||'')||!auth||typeof legacyUsage!=='function')throw fail('费用统计服务未配置',503);
 return {
  summary(principal,input={},platform=false){
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(name=>name!=='days')||![7,30].includes(input.days??7))throw fail('请选择最近7天或30天');
   const person=auth.verifyPrincipal(principal);if(platform&&person.role!=='admin')throw fail('仅平台管理员可查看整个平台费用',403);
   const scopes=platform?null:auth.listScopes(person,{botId:'primary'}).filter(chatKey=>auth.canAccess(person,chatKey,{botId:'primary'}));
   if(scopes&&(scopes.length>10000||scopes.some(chatKey=>!key(chatKey))))throw fail('费用统计授权范围无效',503);
   const to=beijingBudgetDate(now()),from=new Date(Date.parse(to+'T00:00:00Z')-((input.days??7)-1)*86400000).toISOString().slice(0,10);let rows=[],db;
   try {
    if(fs.existsSync(file)&&(!scopes||scopes.length)){
     const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw Error('file');db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000; BEGIN');
     if(db.prepare('PRAGMA application_id').get().application_id!==0x51425047||db.prepare('PRAGMA user_version').get().user_version!==1)throw Error('identity');
     const docs=db.prepare("SELECT name,json_valid(body) valid,json_type(body) type,json_extract(body,'$.version') version,json_extract(body,'$.botId') botId,json_type(body,'$.records') recordsType,json_array_length(body,'$.records') count FROM paid_documents WHERE name IN ('conversation-budget','call-attribution')").all();
     for(const doc of docs)if(!doc.valid||doc.type!=='object'||doc.name==='conversation-budget'&&(doc.version!==1||doc.botId!=='primary'||doc.recordsType!=='array'||doc.count>100000))throw Error('document');
     const validation=db.prepare(invalidPrimarySql).get();if(validation.invalid||validation.count!==validation.uniqueIds)throw Error('primary-record');
     const keys=scopes===null?null:JSON.stringify(scopes);rows=db.prepare(sql).all(from,to,keys,keys);db.exec('COMMIT');
    }
   }catch{throw fail('暂时无法读取费用统计，请稍后重试',503);}finally{db?.close();}
   const total=empty(),days=new Map(),chats=new Map(),authorized=scopes===null?null:new Set(scopes);
   const append=row=>{if(!key(row.chatKey)||!date(row.date)||row.date<from||row.date>to||authorized&&!authorized.has(row.chatKey)||row.invalid)throw fail('费用统计数据异常',503);if(!days.has(row.date))days.set(row.date,empty());if(!chats.has(row.chatKey))chats.set(row.chatKey,empty());add(total,row);add(days.get(row.date),row);add(chats.get(row.chatKey),row);};
   for(const row of rows)append(row);
   try{for(const row of legacyUsage({from,to,keys:scopes}))append({date:row.date,chatKey:row.chatKey,legacyMicros:row.amountMicros});}catch(error){throw fail(error.statusCode?error.message:'暂时无法读取导入费用',503);}
   // No async gap or cached grant is used between the fresh identity checks,
   // scope projection and the two synchronous read snapshots.
   const latest=auth.verifyPrincipal(person);
   if(platform&&latest.role!=='admin'||!platform&&[...chats.keys()].some(chatKey=>!auth.canAccess(latest,chatKey,{botId:'primary'})))throw fail('费用统计授权已变化，请刷新后重试',403);
   return {scope:platform?'platform':'authorized',currency:'CNY',estimated:true,timezone:'Asia/Shanghai',from,to,totals:view(total),daily:[...days].sort(([a],[b])=>b.localeCompare(a)).map(([date,value])=>({date,...view(value)})),conversations:[...chats].sort((a,b)=>view(b[1]).totalCny-view(a[1]).totalCny||a[0].localeCompare(b[0])).slice(0,200).map(([chatKey,value])=>({chatKey,...view(value)})),conversationCount:chats.size,conversationsTruncated:chats.size>200,estimationBoundary:'总额仅包含已结算模型费、语音费与导入旧费用；旧费用无法可靠拆分。只计主账，辅助额度与初始化seed不重复计入。在途预留包含未知费用，未知是预留的子集，不再叠加进总额。北京时间按请求创建日统计，均为估算，非供应商实收账单，腾讯资源包抵扣未同步。'};
  }
 };
}
