import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

/** Real local auth/business HTTP for DOM/browser tests. Every identity and Key is synthetic. */
export async function createWorkspaceFixture({empty=false,admin=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-workspace-ui-'));process.env.QQ_AGENT_DATA_DIR=root;
 const {createPlatformAuth}=await import('../src/platform-auth.js'),{createPlatformBusiness}=await import('../src/platform-business.js'),{ConversationArchives}=await import('../src/conversation-archives.js'),{ChatStore}=await import('../src/store.js'),{getConfig,setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js'),{closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js'),{createPlatformResourceRoutes}=await import('../src/routes.js');
 const cfg={...structuredClone(DEFAULT_CONFIG),ownerQQ:'999',api:{...DEFAULT_CONFIG.api,baseUrl:'https://api.deepseek.com',apiKey:'fixture-model-key',model:'deepseek-flash'},allow:{groups:['789'],private:['999']},deny:{groups:[],private:[]},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{'group:789':{mode:'platform',enabled:true},'private:999':{mode:'platform',enabled:true}},outputCap:512,imageTokensPerImage:1024}};
 setRuntimeConfig(cfg);fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(cfg));
 let auth,business,routes;const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
 const calls=[];const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  try{
   if(url.pathname.startsWith('/api/')){
    calls.push({method:req.method,path:url.pathname});
    if(await auth.handleHttp(req,res,url))return;
    const principal=auth.authenticate(req.headers.cookie||'');if(!principal)return json(res,401,{error:'请先登录'});
    const route=routes.find(route=>route.method===req.method&&route.pattern===url.pathname);
    if(!route)return json(res,404,{error:'Fixture route not found'});
    return await route.handler({req,res,url,principal,json});
   }
   const name=url.pathname==='/'?'workspace.html':url.pathname.slice(1);
   if(!['workspace.html','login.html','help.html','platform.js','platform.css'].includes(name)){res.writeHead(404);res.end();return;}
   res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});res.end(fs.readFileSync(new URL('../ui/'+name,import.meta.url)));
  }catch(error){json(res,error.statusCode||error.status||500,{error:error.message});}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 auth=createPlatformAuth({file:path.join(root,'platform.sqlite'),publicOrigin:origin,getConversationKeys:()=>['group:789','private:999'],verifyGroupMember:async({groupId,qq})=>({role:'admin',user_id:qq,group_id:groupId,botInGroup:true})});
 await auth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});
 const registration=await auth.register({username:'fixture_user',password:'fixture-user-pass-2026'});
 const cookie=auth.cookie(registration.token).split(';')[0],user=auth.authenticate(cookie);
 if(!empty){const proof=auth.issueBinding(user,{qq:'777'});auth.consumeBinding({private:true,qq:'777',text:proof.command});auth.store.grant(user.id,'group:789');}
 const archives=new ConversationArchives({file:path.join(root,'conversation-archives.sqlite')}),store=new ChatStore(0,{archives});
 business=createPlatformBusiness({file:path.join(root,'platform-business.sqlite'),keyFile:path.join(root,'platform-business.key'),archives,store,orchestrator:{archiveChanged(){}},auth,config:getConfig});
 routes=createPlatformResourceRoutes({platformAuth:auth,platformBusiness:business,onebot:{selfId:'888'},orchestrator:{chatNameCache:new Map([['789','朋友们的读书和日常闲聊群']])},readBody:async req=>{let text='';for await(const part of req)text+=part;return JSON.parse(text||'{}');}});
 const activeCookie=admin?auth.cookie((await auth.login({username:'fixture_admin',password:'fixture-admin-pass-2026'})).token).split(';')[0]:cookie;
 const principal=auth.authenticate(activeCookie);
 return {root,server,origin,auth,business,archives,store,principal,cookie:activeCookie,calls,
  async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));business.close();auth.close();archives.close();closeProductionPaidCallGuard();assertSafe();fs.rmSync(root,{recursive:true,force:true});}
 };
 function assertSafe(){if(!root.startsWith(path.join(os.tmpdir(),'qq-agent-workspace-ui-')))throw Error('Unsafe fixture path');}
}
