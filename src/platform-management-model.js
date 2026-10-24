// Narrow administrator configuration for the existing shared Agent/paid guard.
// No model probe, alternate executor, browser-supplied price or secret echo.
import crypto from 'node:crypto';
import {getConfig,updateConfig,deepMerge} from './config.js';
import {validateProductionBudgetConfig} from './paid-call-guard.js';
import {resolveApiKey} from './llm.js';
import {thinkingEffortOptions} from './thinking.js';
const fail=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x);
const endpoint=x=>{if(typeof x!=='string'||x.length>2048)throw fail('请选择平台批准的模型服务');let url;try{url=new URL(x);}catch{throw fail('请选择平台批准的模型服务');}if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw fail('模型服务必须是批准的HTTPS地址');return url.href.replace(/\/+$/,'');};
const version=cfg=>crypto.createHash('sha256').update(JSON.stringify({api:cfg.api,providers:cfg.providers,dshProviderKeys:cfg.dshProviderKeys,policy:{endpoint:cfg.productionBudget?.endpoint,model:cfg.productionBudget?.model,prices:cfg.productionBudget?.prices,verifiedResponseModels:cfg.productionBudget?.verifiedResponseModels,imageTokensPerImage:cfg.productionBudget?.imageTokensPerImage,approvedProviders:cfg.productionBudget?.approvedProviders}})).digest('hex');
export function createPlatformModelManagement({auth,config=getConfig,saveConfig=updateConfig,providers,onChanged=()=>{}}={}){
 if(!auth||typeof config!=='function'||typeof saveConfig!=='function'||typeof providers!=='function')throw fail('平台模型管理未配置',503);
 const admin=principal=>{const p=auth.verifyPrincipal(principal);if(p.role!=='admin')throw fail('仅平台管理员可管理默认模型服务',403);return p;};
 const catalogue=()=>providers().map(value=>({endpoint:endpoint(value.endpoint),model:value.model,prices:{...value.prices},responseModels:[...(value.responseModels||[])],imageTokensPerImage:value.imageTokensPerImage??1024})).filter((value,index,all)=>all.findIndex(other=>other.endpoint===value.endpoint&&other.model===value.model)===index);
 const projection=cfg=>({version:version(cfg),endpoint:cfg.api?.baseUrl||cfg.productionBudget?.endpoint||'',model:cfg.api?.model||cfg.productionBudget?.model||'',hasKey:Boolean(resolveApiKey(cfg)),thinkingEffort:cfg.api?.thinkingEffort||'',thinkingEffortOptions:thinkingEffortOptions(cfg.api),providers:catalogue().map(({endpoint,model,prices})=>({endpoint,model,prices,currency:'CNY',thinkingEffortOptions:thinkingEffortOptions({baseUrl:endpoint,model})}))});
 return {
  get(principal){admin(principal);validateProductionBudgetConfig(config());return projection(config());},
  update(principal,fields){
   admin(principal);
   if(!plain(fields)||Object.keys(fields).some(name=>!['expectedVersion','endpoint','model','apiKey','thinkingEffort'].includes(name))||typeof fields.expectedVersion!=='string'||typeof fields.model!=='string'||fields.model.length>200||fields.apiKey!==undefined&&typeof fields.apiKey!=='string'||fields.thinkingEffort!==undefined&&typeof fields.thinkingEffort!=='string')throw fail('平台模型字段无效');
   const before=config();if(fields.expectedVersion!==version(before))throw fail('模型服务已变化，请刷新后重新保存',409);
   const wantedEndpoint=endpoint(fields.endpoint),approved=catalogue(),choice=approved.find(value=>value.endpoint===wantedEndpoint&&value.model===fields.model);if(!choice)throw fail('端点和模型须来自平台批准且报价完整的目录');
   const allowedThinking=thinkingEffortOptions({baseUrl:choice.endpoint,model:choice.model});
   if(fields.thinkingEffort!==undefined&&!allowedThinking.includes(fields.thinkingEffort))throw fail('请选择该模型支持的思考强度');
   const changedTarget=choice.endpoint!==endpoint(before.api?.baseUrl||before.productionBudget.endpoint)||choice.model!==before.api?.model;
   const nextThinking=fields.thinkingEffort??(!changedTarget||allowedThinking.includes(before.api?.thinkingEffort||'')?(before.api?.thinkingEffort||''):'');
   const submitted=fields.apiKey?.trim()||'';if(fields.apiKey!==undefined&&(fields.apiKey.length>8192||/[\x00-\x1f\x7f]/.test(fields.apiKey))||submitted==='******')throw fail('请填写有效API Key');
   if(wantedEndpoint!==endpoint(before.api?.baseUrl||before.productionBudget.endpoint)&&!submitted)throw fail('更换模型服务地址时必须重新输入该服务的API Key');
   const secret=submitted||resolveApiKey(before);
   if(!secret)throw fail('请先填写平台模型的API Key');
   const patch={api:{baseUrl:choice.endpoint,model:choice.model,provider:'',apiKey:secret,thinkingEffort:nextThinking,...(fields.thinkingEffort!==undefined||changedTarget?{thinkingMode:'auto'}:{})},productionBudget:{endpoint:choice.endpoint,model:choice.model,prices:{...choice.prices},verifiedResponseModels:[...choice.responseModels],imageTokensPerImage:choice.imageTokensPerImage,approvedProviders:approved}};
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
