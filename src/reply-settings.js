// One group/private settings surface over the existing context-tier trigger.
// No extra random gate, paid call, scheduler or alternate chat executor.
import {getConfig,updateConfig,storeConfigForChat} from './config.js';
const fail=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
const key=value=>typeof value==='string'&&/^(group|private):[1-9]\d*$/.test(value)&&Number.isSafeInteger(Number(value.split(':')[1]));
const percent=value=>Number.isInteger(value)&&value>=0&&value<=100;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function saved(chatKey){
  const rows=getConfig().store?.replyByChat;
  if(rows!==undefined&&!object(rows))throw fail('聊天回复设置损坏，已停止修改',503);
  const row=rows?.[chatKey];if(row===undefined)return {version:0,replyPercent:null};
  if(!object(row)||Object.keys(row).length!==2||!Number.isSafeInteger(row.version)||row.version<1||!Object.hasOwn(row,'replyPercent')||row.replyPercent!==null&&!percent(row.replyPercent))throw fail('聊天回复设置损坏，已停止修改',503);
  return row;
}
export function createReplySettings({auth,onChanged=()=>{}}={}){
  if(!auth||typeof auth.verifyPrincipal!=='function'||typeof onChanged!=='function')throw fail('聊天回复设置尚未启用',503);
  const access=(principal,chatKey,write=false)=>{const person=auth.verifyPrincipal(principal);if(!key(chatKey)||!auth.canAccess(person,chatKey,{botId:'primary',write}))throw fail('没有这个聊天的管理权限',403);return person;};
  const projection=chatKey=>{
    const row=saved(chatKey),inherited=storeConfigForChat(chatKey,{ignoreReplyOverride:true}),effective=storeConfigForChat(chatKey);
    const inheritedReplyPercent=chatKey.startsWith('private:')?100:inherited.contextTier>=4?100:inherited.contextTier>=3?inherited.randomPercent:0;
    return {chatKey,version:row.version,replyPercent:row.replyPercent,effectiveReplyPercent:row.replyPercent===null?inheritedReplyPercent:effective.replyPercent??0,inheritedReplyPercent,source:row.replyPercent===null?'inherited':'chat',semantics:'仅控制日常消息随机触发；群内明确召唤、关键词与拍一拍沿用原规则。显式概率在活跃期也生效，定时主动消息独立。0不是关闭群聊明确召唤。'};
  };
  return {
    get(principal,chatKey){access(principal,chatKey);return projection(chatKey);},
    update(principal,fields){
      if(!object(fields)||Object.keys(fields).length!==3||Object.keys(fields).some(name=>!['chatKey','expectedVersion','replyPercent'].includes(name))||!key(fields.chatKey)||!Number.isSafeInteger(fields.expectedVersion)||fields.expectedVersion<0||fields.replyPercent!==null&&!percent(fields.replyPercent))throw fail('回复概率须为0至100的整数，或留空沿用默认');
      access(principal,fields.chatKey,true);const before=saved(fields.chatKey);
      if(before.version!==fields.expectedVersion)throw fail('这个聊天的回复设置已变化，请刷新后再保存',409);
      if(before.version>=Number.MAX_SAFE_INTEGER)throw fail('回复设置版本已达到上限',503);
      // Keep a versioned null tombstone so clear -> set does not reset CAS/ABA.
      try{updateConfig({store:{replyByChat:{[fields.chatKey]:{version:before.version+1,replyPercent:fields.replyPercent}}}});}catch{throw fail('回复设置保存失败，原配置已保留',503);}
      try{onChanged(fields.chatKey);}catch{}
      return projection(fields.chatKey);
    }
  };
}
