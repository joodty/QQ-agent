import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createPlatformAuth} from '../src/platform-auth.js';

test('automatic platform resource candidates require active explicit scopes or verified private bindings',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-resource-owners-')),file=path.join(dir,'platform.sqlite');let clock=Date.now();
 const auth=createPlatformAuth({file,publicOrigin:'https://console.example.test',now:()=>clock});
 t.after(()=>{auth.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'qq-resource-owners-')));fs.rmSync(dir,{recursive:true,force:true});});
 const id=n=>String(n).padStart(32,'0');
 const users=[1,2,3,4].map(n=>({id:id(n),username:'fixture'+n,role:n===1?'admin':'user',disabled:n===4,conversationKeys:n===2||n===4?['group:123']:[],botScopes:n===2||n===4?[{botId:'primary',key:'group:123'}]:[],password:{algorithm:'scrypt-v1',salt:'ab'.repeat(16),key:'cd'.repeat(64)},passwordVersion:1,createdAt:clock-100,updatedAt:clock-100}));
 auth.store.importBundle({format:'qq-agent-platform-accounts',version:1,sourceId:'fixture-resources',auth:{version:1,users,sessions:[]},bindings:[{userId:id(2),qq:'456',verifiedAt:clock-10},{userId:id(3),qq:'789',verifiedAt:clock-10}],challenges:[],delegations:[],conversations:[]},{dryRun:false});
 assert.deepEqual(auth.resourceOwners('group:999'),[]);
 assert.deepEqual(auth.resourceOwners('group:123').map(row=>row.id),[id(2)]);
 assert.deepEqual(auth.resourceOwners('private:456').map(row=>row.id),[id(2)]);
 assert.deepEqual(auth.resourceOwners('private:456',{botId:'other-bot'}),[]);
 assert.deepEqual(auth.resourceKeys(),['group:123','private:456','private:789']);
 assert.ok(auth.resourceOwners('group:123')[0].permissionVersion);
 auth.store.grant(id(3),'group:321','primary',{automatic:true,ttlMs:120000});
 assert.deepEqual(auth.resourceOwners('group:321').map(row=>row.id),[id(3)]);
 clock+=120001;
 assert.deepEqual(auth.resourceOwners('group:321'),[]);assert.ok(!auth.resourceKeys().includes('group:321'));
 const db=new DatabaseSync(file);db.prepare('UPDATE accounts SET disabled=1 WHERE id=?').run(id(2));db.close();
 assert.deepEqual(auth.resourceOwners('group:123'),[]);assert.deepEqual(auth.resourceOwners('private:456'),[]);
 assert.deepEqual(auth.resourceKeys(),['private:789']);
});
