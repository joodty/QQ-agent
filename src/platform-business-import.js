// Pure offline normalization. Caller owns private source reads and private bundle output.
// This module has no filesystem/network/runtime dependency on the retired Bridge.
import crypto from 'node:crypto';
const fail=()=>Object.assign(Error('旧业务原文、密钥或引用无效，拒绝迁移'),{code:'INVALID_LEGACY_BUSINESS',statusCode:400});
const label=x=>typeof x==='string'&&x.length>0&&x.length<=200&&!/[\x00-\x1f\x7f]/.test(x);
export function normalizeLegacyBusiness({sourceId,tenant,masterKey,usage=[],trialInitialSpent={}}={}){
  if(!label(sourceId)||!tenant||tenant.version!==1||!Array.isArray(tenant.profiles)||!Array.isArray(tenant.funding)||!Array.isArray(tenant.bindings)||!Array.isArray(tenant.trialOverrides)||!tenant.trial||!Array.isArray(usage))throw fail();
  if(tenant.profiles.length&&(!Buffer.isBuffer(masterKey)||masterKey.length!==32||crypto.createHash('sha256').update(masterKey).digest('hex')!==tenant.masterKeyId))throw fail();
  const ids=new Map(),credentials=tenant.profiles.map(p=>{
    if(!label(p.id)||!label(p.ownerUserId)||!label(p.name)||p.provider!=='deepseek'||!label(p.model)||!Number.isSafeInteger(p.version)||p.version<1||typeof p.enabled!=='boolean'||typeof p.deleted!=='boolean'||p.encrypted?.version!==1||ids.has(p.id))throw fail();
    let apiKey;
    try{const cipher=crypto.createDecipheriv('aes-256-gcm',masterKey,Buffer.from(p.encrypted.iv,'hex'));cipher.setAAD(Buffer.from('qq-tenant-profile-v1/'+p.ownerUserId+'/'+p.id));cipher.setAuthTag(Buffer.from(p.encrypted.tag,'hex'));apiKey=Buffer.concat([cipher.update(Buffer.from(p.encrypted.ciphertext,'hex')),cipher.final()]).toString('utf8');if(!/^sk-[A-Za-z0-9_-]{16,256}$/.test(apiKey))throw fail();}catch{throw fail();}
    ids.set(p.id,p.ownerUserId);
    return {id:p.id,ownerId:p.ownerUserId,name:p.name,endpoint:'https://api.deepseek.com',model:p.model,apiKey,enabled:p.enabled&&!p.deleted,version:p.version,reason:p.invalidReason||null};
  });
  const bindings=new Map(tenant.bindings.map(b=>[b.userId,b.qq]));
  const funding=tenant.funding.map(f=>{
    if(!label(f.ownerUserId)||!Number.isSafeInteger(f.version)||f.version<1||f.profileId!==null&&ids.get(f.profileId)!==f.ownerUserId)throw fail();
    const override=tenant.trialOverrides.find(r=>r.userId===f.ownerUserId),trialEnabled=tenant.trial.enabled&&(override?.enabled??true);
    return {botId:f.botId,chatKey:f.key,ownerId:f.ownerUserId,mode:f.profileId?'byok':'trial',credentialRef:f.profileId,version:f.version,enabled:f.profileId?true:Boolean(trialEnabled),...(f.profileId?{}:{dailyLimitCny:override?.dailyLimitCny??tenant.trial.dailyLimitCny})};
  });
  // The old product implicitly offered a bound user's trial without a funding row.
  for(const [ownerId,qq]of bindings)if(!funding.some(f=>f.botId==='primary'&&f.chatKey==='private:'+qq)){
    const override=tenant.trialOverrides.find(r=>r.userId===ownerId);
    funding.push({botId:'primary',chatKey:'private:'+qq,ownerId,mode:'trial',credentialRef:null,version:override?.version||1,enabled:Boolean(tenant.trial.enabled&&(override?.enabled??true)),dailyLimitCny:override?.dailyLimitCny??tenant.trial.dailyLimitCny});
  }
  return {format:'qq-bridge-business',version:1,sourceId,credentials,funding,usage:structuredClone(usage),settings:{trialEnabled:tenant.trial.enabled,trialDailyLimitCny:tenant.trial.dailyLimitCny,trialPlatformDailyLimitCny:tenant.trial.totalDailyLimitCny,trialInitialSpent:structuredClone(trialInitialSpent)}};
}
