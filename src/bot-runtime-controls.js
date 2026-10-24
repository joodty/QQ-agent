// Narrow runtime contract for owned bots. No URLs, keys, arbitrary config or
// native console capability may be supplied by a browser through this module.
import {validateBotPreferenceOverrides} from './bot-preferences.js';

const failure=(message,statusCode=400)=>Object.assign(Error(message),{statusCode});
export function createBotRuntimeControls({config,updateConfig,store,orchestrator,onebot,speechService,speechPrincipal,hosted=false}={}) {
  const keys=()=>[...new Set([...(store?.listChats?.()||[]),...(config().allow?.groups||[]).map(id=>'group:'+id),...(config().allow?.private||[]).map(id=>'private:'+id)])];
  return {
    async apply(effective,{principal=speechPrincipal,assertCurrent=()=>true,expectedQQ}={}) {
      // The central preference service validates this complete value. Validate
      // again at the independently authenticated worker boundary.
      const value=validateBotPreferenceOverrides(effective,{complete:true});
      if(Object.values(value).some(v=>v===null))throw failure('机器人设置不完整');
      if(expectedQQ&&String(onebot.selfId||'')!==String(expectedQQ))throw failure('QQ实例身份尚未核实',409);
      if(value.voiceEnabled&&(!speechService||!speechService.platformOverview(principal,{publicOnly:true,compact:true}).configured))throw failure('语音服务尚未配置，请联系管理员',503);
      assertCurrent();
      const before=config(),all=new Set([...keys(),...value.groupIds.map(id=>'group:'+id),...value.privateIds.map(id=>'private:'+id)]);
      // Cancel queued/running decisions before changing their trigger policy.
      for(const key of all)orchestrator.archiveChanged(key);
      const patch={botControls:value,allow:{groups:value.groupIds,private:value.privateIds},allowAllWhenEmpty:false,
        proactive:{enabled:false},chatActive:{enabled:false},persona:{roleText:value.personaText}};
      if(hosted){
        if(!before.productionBudget?.enabled||!Number.isFinite(before.productionBudget.totalDailyLimitCny)||before.productionBudget.totalDailyLimitCny<=0)throw failure('实例总额度尚未配置',503);
        patch.productionBudget={funding:{__replace__:Object.fromEntries([...value.groupIds.map(id=>'group:'+id),...value.privateIds.map(id=>'private:'+id)].map(key=>[key,{mode:'platform',enabled:value.enabled}]))}};
      }
      updateConfig(patch);
      orchestrator.setPaused(!value.enabled||before.platform?.apiAccessPending===true,'owner-preferences');
      // Existing primary subsidies and historical speech limits are preserved.
      // New workers receive only the server's fixed, bounded speech grant.
      if(speechService){
        const limits=before.hostedFundingLimits||{};
        if(hosted){
          const p=speechService.platformOverview(principal,{compact:true});
          speechService.updatePlatform(principal,{expectedVersion:p.version,enabled:value.voiceEnabled,
            dailyLimitCny:limits.speechPlatformDailyLimitCny??limits.speechDailyLimitCny??0,
            cooldownMs:limits.speechCooldownMs??60000,voiceType:value.voiceType,speed:value.speed,volume:value.volume,autoVoicePercent:value.autoVoicePercent});
        }
        for(const key of all){
          assertCurrent();
          if(hosted){
            const p=speechService.platformOverview(principal);
            const grant=p.subsidies.find(row=>row.chatKey===key)||{version:0};
            const allowed=value.enabled&&(key.startsWith('group:')?value.groupReplies&&value.groupIds.includes(key.slice(6)):value.privateReplies&&value.privateIds.includes(key.slice(8)));
            const limit=limits.speechDailyLimitCny??0;
            speechService.updateSubsidy(principal,{chatKey:key,expectedVersion:grant.version,enabled:allowed&&limit>0,allowedFundingModes:['platform'],dailyLimitCny:limit});
          }
          const current=speechService.settings(principal,key,{compact:true});
          const enabled=value.voiceEnabled&&value.enabled&&(key.startsWith('group:')?value.groupReplies&&value.groupIds.includes(key.slice(6)):value.privateReplies&&value.privateIds.includes(key.slice(8)));
          speechService.updateSettings(principal,{chatKey:key,expectedVersion:current.settings.version,enabled,
            voiceType:value.voiceType,speed:value.speed,volume:value.volume,autoVoicePercent:value.autoVoicePercent});
        }
      }
      assertCurrent();return {applied:true};
    },
    identity(){return {ok:true,botId:process.env.QQ_AGENT_HOSTED_BOT_ID||'primary',expectedQQ:process.env.QQ_AGENT_HOSTED_EXPECTED_QQ||null,actualQQ:String(onebot.selfId||''),qqOnline:onebot.connected===true,agentReady:onebot.connected===true,modelConfigured:Boolean(config().api?.apiKey&&config().api?.model)};}
  };
}
