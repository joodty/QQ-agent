// Offline import into the standalone platform. Input may contain API keys: keep it private.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync,backup } from 'node:sqlite';
const flags={'--data-dir':'dataDir','--input':'input','--public-origin':'publicOrigin'};
async function main(argv){
  const options={apply:false};
  for(let i=0;i<argv.length;i++){if(argv[i]==='--apply'){options.apply=true;continue;}const k=flags[argv[i]];if(!k||!argv[i+1]||options[k])throw Error();options[k]=argv[++i];}
  if(!path.isAbsolute(options.dataDir||'')||!path.isAbsolute(options.input||'')||!options.publicOrigin)throw Error();
  const info=fs.lstatSync(options.input);if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024||process.platform!=='win32'&&(info.mode&0o077))throw Error();
  const bundle=JSON.parse(fs.readFileSync(options.input,'utf8').replace(/^\uFEFF/,''));
  const original=path.resolve(options.dataDir);let target=original,temp=null,auth,archives,business;
  try{
    // Default dry-run never upgrades or writes the live target. SQLite backup is
    // a consistent per-database snapshot and does not copy incomplete WAL bytes.
    if(!options.apply){temp=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-business-import-'));fs.chmodSync(temp,0o700);target=temp;
      for(const name of ['config.json','platform-business.key']){const src=path.join(original,name);if(fs.existsSync(src))fs.writeFileSync(path.join(target,name),fs.readFileSync(src),{flag:'wx',mode:0o600});}
      for(const name of ['platform.sqlite','conversation-archives.sqlite','platform-business.sqlite','paid-calls.sqlite']){const src=path.join(original,name);if(!fs.existsSync(src))continue;const db=new DatabaseSync(src,{readOnly:true});try{await backup(db,path.join(target,name));}finally{db.close();}fs.chmodSync(path.join(target,name),0o600);}
    }
    if(!fs.existsSync(path.join(target,'platform.sqlite'))||!fs.existsSync(path.join(target,'conversation-archives.sqlite')))throw Error();
    // Prevent the legacy config recovery loader from renaming a malformed input.
    JSON.parse(fs.readFileSync(path.join(target,'config.json'),'utf8').replace(/^\uFEFF/,''));
    process.env.QQ_AGENT_DATA_DIR=target;process.env.QQ_AGENT_REQUIRE_BUDGET='1';
    const {getConfig}=await import('../src/config.js');
    const {ConversationArchives}=await import('../src/conversation-archives.js');
    const {ChatStore}=await import('../src/store.js');
    const {createPlatformAuth}=await import('../src/platform-auth.js');
    const {createPlatformBusiness}=await import('../src/platform-business.js');
    archives=new ConversationArchives({file:path.join(target,'conversation-archives.sqlite')});
    auth=createPlatformAuth({file:path.join(target,'platform.sqlite'),publicOrigin:options.publicOrigin,getConversationKeys:()=>archives.listChats()});
    business=createPlatformBusiness({file:path.join(target,'platform-business.sqlite'),keyFile:path.join(target,'platform-business.key'),archives,store:new ChatStore(0,{archives}),auth,config:getConfig});
    const report=business.importLegacyState(bundle,{dryRun:!options.apply});
    process.stdout.write(JSON.stringify({ok:true,...report})+'\n');
  }finally{
    business?.close();auth?.close();archives?.close();
    if(temp){const resolved=path.resolve(temp);if(!resolved.startsWith(path.join(os.tmpdir(),'qq-agent-business-import-')))throw Error();fs.rmSync(resolved,{recursive:true,force:true});}
  }
}
main(process.argv.slice(2)).catch(()=>{process.stderr.write(JSON.stringify({ok:false,code:'BUSINESS_IMPORT_FAILED',message:'导入被拒绝；未输出源数据、凭据或堆栈。请检查参数、私有文件权限、来源版本和引用。'})+'\n');process.exitCode=1;});
