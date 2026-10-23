import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-store-list-metadata-'));process.env.QQ_AGENT_DATA_DIR=root;
const {ChatStore}=await import('../src/store.js'),{ConversationArchives}=await import('../src/conversation-archives.js');
test.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'qq-store-list-metadata-')));fs.rmSync(root,{recursive:true,force:true});});

test('listing chat identities preserves cache, legacy files, groups and private archives without loading any message body',()=>{
 const messages=path.join(root,'messages');fs.mkdirSync(messages,{recursive:true});
 fs.writeFileSync(path.join(messages,'group_101.json'),'{corrupt legacy history');fs.writeFileSync(path.join(messages,'private_101.json'),JSON.stringify({chatKey:'private:101',nextLocalId:2,messages:[{id:1,text:'legacy body'}]}));fs.writeFileSync(path.join(messages,'unrelated.json'),'{}');
 let activeReads=0,bodyReads=0;
 const archives={listChats:()=>['group:101','private:202'],active(){activeReads++;throw Error('unexpected selected body read');},readChat(){bodyReads++;throw Error('unexpected history read');}};
 const store=new ChatStore(0,{archives});store.chats.set('private:303',{chatKey:'private:303',nextLocalId:1,messages:[]});
 const before=[...store.chats.keys()],nativeRead=fs.readFileSync;let diskBodyReads=0;
 fs.readFileSync=function(file,...args){if(typeof file==='string'&&file.startsWith(messages+path.sep))diskBodyReads++;return nativeRead.call(this,file,...args);};
 try {assert.deepEqual(new Set(store.listChats()),new Set(['private:303','group:101','private:101','private:202']));assert.deepEqual(new Set(store.listChats()),new Set(['private:303','group:101','private:101','private:202']));}
 finally {fs.readFileSync=nativeRead;}
 assert.deepEqual([...store.chats.keys()],before);assert.equal(activeReads,0);assert.equal(bodyReads,0);assert.equal(diskBodyReads,0);
 assert.throws(()=>store.getChatMeta('group:101'),/unexpected selected body read/);assert.equal(activeReads,1);
});

test('selected archive metadata is independent of list pagination and leaves explicit body corruption checks intact',()=>{
 const file=path.join(root,'selected.sqlite'),archives=new ConversationArchives({file});
 try {
  const persona=archives.createPersona({id:'fixture-persona',name:'Fixture selected',content:'ordinary prompt'});archives.createArchive({chatKey:'group:404',personaId:persona.id,expectedSelectionVersion:0,archiveId:'zz-selected'});
  const db=new DatabaseSync(file);
  try {
   db.exec('BEGIN IMMEDIATE');const insert=db.prepare('INSERT INTO conversation_archives VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
   for(let i=0;i<10000;i++)insert.run('primary','aa-'+String(i).padStart(5,'0'),'runtime','group:404',persona.id,'ready',null,1,1,1,'{"chatKey":"group:404","nextLocalId":1,"messages":[]}','[]',0,0);
   // Metadata navigation remains available while an explicit history read must
   // still validate the corrupt body; a list must not silently repair it.
   db.prepare("UPDATE conversation_archives SET chat_json=? WHERE id='zz-selected'").run('{corrupt selected history');db.exec('COMMIT');
  } finally {db.close();}
  assert.equal(archives.list('group:404').length,10000);assert.equal(archives.list('group:404').some(a=>a.selected),false);
  const selected=archives.activeSummary('group:404');assert.equal(selected.archiveId,'zz-selected');assert.equal(selected.selectionVersion,1);assert.deepEqual(selected.persona,{id:persona.id,name:'Fixture selected',version:1});assert.equal(selected.persona.content,undefined);
  const store=new ChatStore(0,{archives});assert.ok(store.listChats().includes('group:404'));assert.throws(()=>store.getChatMeta('group:404'),{statusCode:503});assert.throws(()=>archives.readChat('group:404'),{statusCode:503});
  const check=new DatabaseSync(file,{readOnly:true});try{assert.equal(check.prepare("SELECT chat_json FROM conversation_archives WHERE id='zz-selected'").get().chat_json,'{corrupt selected history');}finally{check.close();}
 } finally {archives.close();}
});
