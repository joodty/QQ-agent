import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';
import {waitFor} from './_harness.mjs';

const deferred=()=>{let resolve,done=false;const promise=new Promise(complete=>resolve=value=>{done=true;complete(value);});return {promise,resolve,get done(){return done;}};};
const tick=()=>new Promise(setImmediate);
const chat=(key,tab)=>'#chat/'+encodeURIComponent(key)+'/'+tab;

test('completed writes remain on their original chat while obsolete UI continuations are discarded',async t=>{
 const f=await createWorkspaceFixture();t.after(()=>f.close());
 const a=f.business.createPersona(f.principal,{chatKey:'group:789',name:'Original group character',content:'Original group personality.'}).persona;
 const b=f.business.createPersona(f.principal,{chatKey:'private:777',name:'Original private character',content:'Original private personality.'}).persona;
 f.business.applyPersona(f.principal,{chatKey:'group:789',personaId:a.id,expectedSelectionVersion:0});
 f.business.applyPersona(f.principal,{chatKey:'private:777',personaId:b.id,expectedSelectionVersion:0});
 const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8'),script=fs.readFileSync(new URL('../ui/platform.js',import.meta.url),'utf8'),errors=[];
 async function mount(hash){
  const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));const dom=new JSDOM(html,{url:f.origin+'/workspace.html'+hash,runScripts:'outside-only',virtualConsole:console});t.after(()=>dom.window.close());
  const w=dom.window;w.AbortController=globalThis.AbortController;w.matchMedia=()=>({matches:false});const wire={cookie:f.cookie,hook:null},trace=[];
  w.fetch=(route,options={})=>{const url=new URL(route,f.origin);trace.push({path:url.pathname,method:options.method||'GET'});const forward=()=>fetch(url,{...options,headers:{...options.headers,cookie:wire.cookie,origin:f.origin}});return wire.hook?wire.hook(url,options,forward):forward();};
  w.eval(script);return {w,d:w.document,wire,trace};
 }
 const input=(x,id,value)=>{const element=x.d.getElementById(id);element.value=value;element.dispatchEvent(new x.w.Event('input',{bubbles:true}));};
 function holdWrite(x,path){const committed=deferred(),release=deferred(),parsed=deferred();let calls=0;x.wire.hook=async(url,options,forward)=>{if(url.pathname===path&&options.method==='PUT'){calls++;const response=await forward();assert.equal(response.status,200);committed.resolve();await release.promise;const read=response.json.bind(response);response.json=async()=>{const value=await read();parsed.resolve();return value;};return response;}return forward();};return {committed,release,parsed,calls:()=>calls};}
 async function finish(hold){hold.release.resolve();await waitFor(()=>hold.parsed.done,3000,'response parsed');await tick();}

 await t.test('saving group A then entering private B cannot refill B with the saved A personality',async()=>{
  const x=await mount(chat('group:789','personas'));await waitFor(()=>x.d.getElementById('persona-content'));
  const hold=holdWrite(x,'/api/platform/personas');input(x,'persona-content','Saved content belongs only to group A.');const old=x.d.getElementById('persona-form');old.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>hold.committed.done,3000,'write committed');
  x.w.location.hash=chat('private:777','personas');await waitFor(()=>x.d.getElementById('persona-form')&&x.d.getElementById('persona-form')!==old);assert.equal(x.d.getElementById('persona-content').value,'Original private personality.');input(x,'persona-content','Private B unsaved draft.');
  const form=x.d.getElementById('persona-form'),requests=x.trace.length;await finish(hold);assert.equal(x.d.getElementById('persona-form'),form);assert.equal(x.d.getElementById('persona-content').value,'Private B unsaved draft.');assert.equal(x.trace.length,requests);assert.equal(hold.calls(),1);
  assert.ok(f.business.personas(f.principal,'group:789').personas.some(persona=>persona.content==='Saved content belongs only to group A.'));assert.equal(f.archives.active('private:777').persona.id,b.id);
 });
 await t.test('a completed A speech save does not delete B draft, repaint B or close its picker',async()=>{
  const x=await mount(chat('group:789','speech'));await waitFor(()=>x.d.querySelector('form[data-action="save-speech-settings"]'));
  const hold=holdWrite(x,'/api/platform/speech/settings');input(x,'speech-chat-speed','0.5');const old=x.d.querySelector('form[data-action="save-speech-settings"]');old.dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>hold.committed.done,3000,'write committed');
  x.w.location.hash=chat('private:777','speech');await waitFor(()=>x.d.querySelector('form[data-action="save-speech-settings"]')&&x.d.querySelector('form[data-action="save-speech-settings"]')!==old);
  input(x,'speech-chat-speed','1.5');x.d.querySelector('form[data-action="save-speech-settings"] [data-action="choose-speech-voice"]').click();const picker=x.d.querySelector('[role="dialog"]'),form=x.d.querySelector('form[data-action="save-speech-settings"]');await finish(hold);
  assert.equal(x.d.querySelector('[role="dialog"]'),picker);assert.equal(x.d.querySelector('form[data-action="save-speech-settings"]'),form);assert.equal(x.d.getElementById('speech-chat-speed').value,'1.5');assert.equal(hold.calls(),1);assert.equal(f.speech.settings(f.principal,'group:789').settings.speed,.5);assert.equal(f.speech.settings(f.principal,'private:777').settings.overrides.speed,null);
  x.d.querySelector('[data-voice-close]').click();x.w.location.hash='workbench';await waitFor(()=>x.d.querySelector('.chat-list'));x.w.location.hash=chat('private:777','speech');await waitFor(()=>x.d.getElementById('speech-chat-speed')?.value==='1.5');
 });
 await t.test('switching to another account while its predecessor saves cannot overwrite the new account editor',async()=>{
  const x=await mount(chat('group:789','personas'));await waitFor(()=>x.d.getElementById('persona-content'));const latest=f.business.personas(f.principal,'group:789').personas.find(persona=>persona.originId===a.id),selector=x.d.getElementById('persona-selector');selector.value=latest.id;selector.dispatchEvent(new x.w.Event('change',{bubbles:true}));const hold=holdWrite(x,'/api/platform/personas');input(x,'persona-content','Old account saved private revision.');x.d.getElementById('persona-form').dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true}));await waitFor(()=>hold.committed.done,3000,'write committed');
  const registration=await f.auth.register({username:'fixture_write_second',password:'fixture-write-second-pass'}),cookie=f.auth.cookie(registration.token).split(';')[0],user=f.auth.authenticate(cookie),proof=f.auth.issueBinding(user,{qq:'778'});f.auth.consumeBinding({private:true,qq:'778',text:proof.command});f.auth.store.grant(user.id,'group:789');x.wire.cookie=cookie;
  x.d.querySelector('[data-action="refresh"]').click();await waitFor(()=>x.w.location.hash==='#workbench'&&x.d.querySelector('.chat-list')&&x.d.getElementById('user-label').textContent.includes('fixture_write_second'));
  x.w.location.hash=chat('group:789','personas');await waitFor(()=>x.d.getElementById('persona-content'));input(x,'persona-content','New account unsaved group draft.');const form=x.d.getElementById('persona-form'),requests=x.trace.length;await finish(hold);
  assert.equal(x.d.getElementById('persona-form'),form);assert.equal(x.d.getElementById('persona-content').value,'New account unsaved group draft.');assert.equal(x.trace.length,requests);assert.equal(hold.calls(),1);assert.doesNotMatch(x.d.getElementById('main').textContent,/Old account saved private revision/);
 });
 assert.deepEqual(errors,[]);
});
