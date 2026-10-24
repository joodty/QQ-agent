// Structural/accessibility and CSS breakpoint contracts. JSDOM does not render
// pixels; these tests do not substitute for real mobile/browser visual review.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM,VirtualConsole} from 'jsdom';

const html=fs.readFileSync(new URL('../ui/workspace.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../ui/platform.css',import.meta.url),'utf8');
function fixture(){
  const errors=[],console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM(html,{url:'https://workspace.example.test/workspace.html',virtualConsole:console});
  const style=dom.window.document.createElement('style');style.textContent=css;dom.window.document.head.append(style);
  assert.equal(errors.length,0,errors.map(error=>error.message).join('\n'));
  return {dom,document:dom.window.document,rules:style.sheet.cssRules};
}
function atWidth(element,rules,width){
  const result={};
  const visit=entries=>{for(const rule of entries){
    if(rule.media){
      const query=rule.media.mediaText;
      if(/prefers-|print/.test(query))continue;
      const maximum=/max-width:\s*(\d+)px/.exec(query),minimum=/min-width:\s*(\d+)px/.exec(query);
      if((!maximum||width<=Number(maximum[1]))&&(!minimum||width>=Number(minimum[1])))visit(rule.cssRules);
    }else if(rule.selectorText&&rule.style){
      const matches=rule.selectorText.split(',').some(selector=>{try{return element.matches(selector.trim());}catch{return false;}});
      if(matches)for(let i=0;i<rule.style.length;i++){const name=rule.style[i];result[name]=rule.style.getPropertyValue(name);}
    }
  }};visit(rules);return result;
}

test('workspace shell has unique landmarks and keeps account actions outside business navigation',()=>{
  const {dom,document:d}=fixture();try{
    const ids=[...d.querySelectorAll('[id]')].map(node=>node.id);assert.equal(new Set(ids).size,ids.length);
    for(const id of ['main','feedback','page-title','user-label','page-kicker','context-navigation','area-switch','breadcrumb','account-menu','account-menu-toggle'])assert.ok(d.getElementById(id),id);
    assert.equal(d.querySelector('main').id,'main');assert.equal(d.querySelector('.skip-link').getAttribute('href'),'#main');assert.equal(d.getElementById('main').getAttribute('tabindex'),'-1');
    assert.equal(d.getElementById('feedback').getAttribute('role'),'status');assert.equal(d.getElementById('feedback').getAttribute('aria-live'),'polite');
    for(const id of ['context-navigation','area-switch','breadcrumb']){assert.equal(d.getElementById(id).tagName,'NAV');assert.ok(d.getElementById(id).getAttribute('aria-label'));}
    assert.deepEqual([...d.querySelectorAll('#context-navigation a')].map(a=>a.getAttribute('href')),['#workbench','/my-bots.html','#cost-overview','#keys']);
    assert.equal(d.querySelector('#area-switch a[href="#admin/overview"]').hidden,true);
    for(const target of ['#account','#help']){assert.ok(d.querySelector('#account-menu a[href="'+target+'"]'));assert.equal(d.querySelector('.sidebar a[href="'+target+'"]'),null);}
    for(const action of ['theme','logout'])assert.ok(d.querySelector('#account-menu button[data-action="'+action+'"]'));
  }finally{dom.window.close();}
});

test('account menu has an explicit accessible name, state and focusable native actions',()=>{
  const {dom,document:d}=fixture();try{
    const opener=d.getElementById('account-menu-toggle'),menu=d.getElementById('account-menu');
    assert.equal(opener.tagName,'BUTTON');assert.equal(opener.type,'button');assert.equal(opener.dataset.action,'toggle-account-menu');assert.equal(opener.getAttribute('aria-haspopup'),'menu');assert.equal(opener.getAttribute('aria-controls'),menu.id);assert.equal(opener.getAttribute('aria-expanded'),'false');assert.ok(opener.textContent.trim());
    assert.equal(menu.hidden,true);assert.equal(menu.getAttribute('role'),'menu');assert.ok(menu.getAttribute('aria-label'));
    for(const item of menu.querySelectorAll('[role=menuitem]'))assert.ok(item.tagName==='BUTTON'&&item.type==='button'||item.tagName==='A'&&item.hasAttribute('href'));
    assert.equal(opener.closest('aside'),null);assert.equal(opener.closest('[hidden]'),null);
  }finally{dom.window.close();}
});

test('mobile breakpoints remove the large sidebar and retain touch-sized account and scope controls',()=>{
  const {dom,document:d,rules}=fixture();try{
    for(const width of [320,375,700]){
      const workspace=atWidth(d.querySelector('.workspace'),rules,width),sidebar=atWidth(d.querySelector('.sidebar'),rules,width),navigation=atWidth(d.getElementById('context-navigation'),rules,width),account=atWidth(d.getElementById('account-menu-toggle'),rules,width),area=atWidth(d.querySelector('#area-switch a'),rules,width);
      assert.equal(workspace.display,'block');assert.equal(sidebar.position,'static');assert.equal(sidebar.height,'auto');assert.equal(navigation['flex-direction'],'row');assert.equal(navigation['overflow-x'],'auto');
      assert.notEqual(account.display,'none');assert.ok(parseInt(account['min-height'])>=44);assert.ok(parseInt(area['min-height'])>=44);
      assert.notEqual(atWidth(d.querySelector('.user-actions'),rules,width).display,'none');
    }
    assert.equal(atWidth(d.querySelector('.workspace'),rules,1024).display,'grid');
    assert.equal(atWidth(d.querySelector('.sidebar'),rules,1024).position,'sticky');
    const tabs=d.createElement('nav');tabs.className='chat-tabs';d.getElementById('main').append(tabs);
    assert.equal(atWidth(tabs,rules,375)['overflow-x'],'auto');assert.equal(atWidth(tabs,rules,375)['flex-direction'],'row');
    assert.match(css,/:focus-visible\s*\{/);assert.match(css,/@media\s*\(prefers-reduced-motion:reduce\)/);
  }finally{dom.window.close();}
});

test('shell loads only same-origin application assets and preserves the voice-picker layout',()=>{
  const {dom,document:d,rules}=fixture();try{
    for(const node of d.querySelectorAll('script[src],link[rel=stylesheet]')){const url=new URL(node.getAttribute('src')||node.getAttribute('href'),dom.window.location);assert.equal(url.origin,dom.window.location.origin);}
    assert.equal(d.querySelectorAll('script:not([src])').length,0);assert.doesNotMatch(css,/@import|https?:\/\/|url\(/);
    const overlay=d.createElement('div');overlay.className='speech-voice-overlay';const dialog=d.createElement('section');dialog.className='speech-voice-dialog';overlay.append(dialog);d.body.append(overlay);
    assert.equal(atWidth(overlay,rules,375).position,'fixed');assert.equal(atWidth(dialog,rules,375).height,'100dvh');assert.equal(atWidth(dialog,rules,375).display,'flex');
    d.documentElement.dataset.theme='dark';assert.match(css,/\[data-theme=dark\]/);
  }finally{dom.window.close();}
});
