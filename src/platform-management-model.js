// Narrow administrator configuration for the existing shared Agent/paid guard.
// No model probe, alternate executor, browser-supplied price or secret echo.
import crypto from 'node:crypto';
import {getConfig,updateConfig,deepMerge} from './config.js';
import {validateProductionBudgetConfig} from './paid-call-guard.js';
import {resolveApiKey} from './llm.js';
import {thinkingEffortOptions} from './thinking.js';
import {COMMANDCODE_GO_MODELS,COMMANDCODE_GO_USD_TO_CNY} from './commandcode-go-models.js';
import {FREE_MODEL} from './verified-free-model.js';
const fail=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const endpoint=x=>{if(typeof x!=='string'||x.length>2048)throw fail('请选择平台批准的模型服务');let url;try{url=new URL(x);}catch{throw fail('请选择平台批准的模型服务');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw fail('模型服务必须是批准的HTTPS地址');return url.href.replace(/\/+$/,'');};
const version=cfg=>crypto.createHash('sha256').update(JSON.stringify({goCatalogue:COMMANDCODE_GO_MODELS,api:cfg.api,providers:cfg.providers,dshProviderKeys:cfg.dshProviderKeys,policy:{endpoint:cfg.productionBudget?.endpoint,model:cfg.productionBudget?.model,prices:cfg.productionBudget?.prices,verifiedResponseModels:cfg.productionBudget?.verifiedResponseModels,imageTokensPerImage:cfg.productionBudget?.imageTokensPerImage,approvedProviders:cfg.productionBudget?.approvedProviders}})).digest('hex');
function goCatalogue(){
 return COMMANDCODE_GO_MODELS.map(row=>{
  const quote=row.usd,complete=quote&&['input','output','cacheRead','cacheWrite'].every(key=>typeof quote[key]==='number'&&Number.isFinite(quote[key])&&quote[key]>=0);
  const disabledReason=(row.id===FREE_MODEL?null:row.disabledReason)||(!complete?'官方报价资料不完整':quote.cacheWrite>0?'缓存写入费用尚未纳入当前费用保护':quote.input===0&&quote.output===0&&row.id!==FREE_MODEL?'免费模型的报价验证尚未接入':null);
  return {endpoint:'https://api.commandcode.ai/alpha',model:row.id,name:row.name,verified:row.verified===true||row.id===FREE_MODEL,disabledReason,contextLength:row.contextLength,
   ...(complete?{prices:{inputCnyPerMillion:quote.input*COMMANDCODE_GO_USD_TO_CNY,outputCnyPerMillion:quote.output*COMMANDCODE_GO_USD_TO_CNY,cacheHitCnyPerMillion:quote.cacheRead*COMMANDCODE_GO_USD_TO_CNY,reasoningIncluded:true}}:{}),
   responseModels:[row.id.split('/').at(-1),...(row.aliases||[])],imageTokensPerImage:1024};
 });
}
export function createPlatformModelManagement({auth,config=getConfig,saveConfig=updateConfig,providers,onChanged=()=>{}}={}){
 if(!auth||typeof config!=='function'||typeof saveConfig!=='function'||typeof providers!=='function')throw fail('平台模型管理未配置',503);
 const admin=principal=>{const p=auth.verifyPrincipal(principal);if(p.role!=='admin')throw fail('仅平台管理员可管理默认模型服务',403);return p;};
 const catalogue=()=>{
  const configured=providers().map(value=>({endpoint:endpoint(value.endpoint),model:value.model,prices:{...value.prices},responseModels:[...(value.responseModels||[])],imageTokensPerImage:value.imageTokensPerImage??1024}));
  const entries=configured.some(row=>row.endpoint==='https://api.commandcode.ai/alpha')?[...goCatalogue().map(row=>({...row,...configured.find(value=>value.endpoint===row.endpoint&&value.model===row.model)})),...configured]:configured;
  return entries.filter((value,index,all)=>all.findIndex(other=>other.endpoint===value.endpoint&&other.model===value.model)===index);
 };
 const projection=cfg=>({version:version(cfg),endpoint:cfg.api?.baseUrl||cfg.productionBudget?.endpoint||'',model:cfg.api?.model||cfg.productionBudget?.model||'',hasKey:Boolean(resolveApiKey(cfg)),thinkingEffort:cfg.api?.thinkingEffort||'',thinkingEffortOptions:thinkingEffortOptions(cfg.api),providers:catalogue().map(({endpoint,model,prices,name,verified,disabledReason,contextLength})=>({endpoint,model,prices,currency:'CNY',...(name?{name,verified,disabledReason,contextLength}:{}),thinkingEffortOptions:thinkingEffortOptions({baseUrl:endpoint,model})}))});
 return {
  get(principal){admin(principal);validateProductionBudgetConfig(config());return projection(config());},
  update(principal,fields){
   admin(principal);
   if(!plain(fields)||Object.keys(fields).some(name=>!['expectedVersion','endpoint','model','apiKey','thinkingEffort'].includes(name))||typeof fields.expectedVersion!=='string'||typeof fields.model!=='string'||fields.model.length>200||fields.apiKey!==undefined&&typeof fields.apiKey!=='string'||fields.thinkingEffort!==undefined&&typeof fields.thinkingEffort!=='string')throw fail('平台模型字段无效');
   const before=config();if(fields.expectedVersion!==version(before))throw fail('模型服务已变化，请刷新后重新保存',409);
   const wantedEndpoint=endpoint(fields.endpoint),approved=catalogue(),choice=approved.find(value=>value.endpoint===wantedEndpoint&&value.model===fields.model);if(!choice)throw fail('端点和模型须来自平台批准且报价完整的目录');
   if(choice.disabledReason)throw fail(choice.disabledReason);
   const allowedThinking=thinkingEffortOptions({baseUrl:choice.endpoint,model:choice.model});
   if(fields.thinkingEffort!==undefined&&!allowedThinking.includes(fields.thinkingEffort))throw fail('请选择该模型支持的思考强度');
   const changedTarget=choice.endpoint!==endpoint(before.api?.baseUrl||before.productionBudget.endpoint)||choice.model!==before.api?.model;
   const nextThinking=fields.thinkingEffort??(!changedTarget||allowedThinking.includes(before.api?.thinkingEffort||'')?(before.api?.thinkingEffort||''):'');
   const submitted=fields.apiKey?.trim()||'';if(fields.apiKey!==undefined&&(fields.apiKey.length>8192||/[\x00-\x1f\x7f]/.test(fields.apiKey))||submitted==='******')throw fail('请填写有效API Key');
   if(wantedEndpoint!==endpoint(before.api?.baseUrl||before.productionBudget.endpoint)&&!submitted)throw fail('更换模型服务地址时必须重新输入该服务的API Key');
   const secret=submitted||resolveApiKey(before);
   if(!secret)throw fail('请先填写平台模型的API Key');
   const patch={api:{baseUrl:choice.endpoint,model:choice.model,provider:'',apiKey:secret,thinkingEffort:nextThinking,...(fields.thinkingEffort!==undefined||changedTarget?{thinkingMode:'auto'}:{})},productionBudget:{endpoint:choice.endpoint,model:choice.model,prices:{...choice.prices},verifiedResponseModels:[...choice.responseModels],imageTokensPerImage:choice.imageTokensPerImage,approvedProviders:approved.filter(row=>!row.disabledReason)}};
   validateProductionBudgetConfig(deepMerge(before,patch));
   try{saveConfig(patch);}catch{throw fail('模型服务保存失败，原配置已保留',503);}
   // Updating the shared config affects the original engine on its next read.
   // Existing paid admissions recheck their price/funding fingerprint; notify
   // running chats as well without making BYOK a second execution path.
   try{onChanged();}catch{}
   return projection(config());
  }
 };
}
