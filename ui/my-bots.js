/* Same-origin cookie authentication; no machine credentials enter this page. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const state = { user: null, requests: [], enabled: false, capacity: {}, selected: '', active: '', login: null, preference: null, defaults: null, busy: false, dirty: false, tab: 'mine', selection: 0 };
  const fields = [
    ['enabled','启用机器人','boolean'], ['mentionOnly','仅被 @ 时回复','boolean'],
    ['replyPercent','普通消息回复概率','range',0,100,1], ['privateReplies','回复私聊','boolean'], ['groupReplies','回复群聊','boolean'],
    ['groupIds','允许回复的群号','list'], ['privateIds','允许回复的私聊 QQ','list'], ['personaText','机器人人设','text'],
    ['voiceEnabled','启用语音回复','boolean'], ['autoVoicePercent','回复后的自动语音概率','range',0,100,1],
    ['contextMessages','上下文消息数','number',0,500,1], ['voiceType','音色编号','number',1,99999999,1],
    ['speed','语速','number',-1,2,0.01], ['volume','音量','number',-5,5,0.01]
  ];
  const statuses = {pending:'待启动',starting:'正在启动',waiting_scan:'等待本人扫码',connecting:'正在核验登录',ready:'已连接',expired:'二维码已过期',stopped:'已停止',failed:'接入失败',mismatch:'扫码 QQ 与申请不符',cleanup_pending:'正在停止，待核对'};
  const application = {pending:'偏好已保存，正在等待应用。',applied:'偏好已应用到机器人。',failed:'偏好已保存，但应用失败。请检查连接后重新保存重试。',not_connected:'偏好已保存，机器人尚未连接运行。连接后请检查应用状态。'};
  function feedback(message, error = false) { $('feedback').hidden = false; $('feedback').classList.toggle('error',error); $('feedback').setAttribute('role',error?'alert':'status'); $('feedback').textContent = message; }
  async function api(path, body, method = 'POST') {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(),75000);
    try {
      const response = await fetch(path,{credentials:'same-origin',cache:'no-store',signal:controller.signal,...(body === undefined ? {} : {method,headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      if(response.status === 401){state.requests=[];state.login=null;$('requests').textContent='登录已失效，请重新登录。';$('login-panel').hidden=true;$('preferences').textContent='请重新登录。';location.replace('/login.html?returnTo='+encodeURIComponent('/my-bots.html'));throw Error('登录已失效，请重新登录。');}
      let data;try{data=await response.json();}catch{throw Error('服务器返回无效，请稍后重试。');}
      if(!response.ok || data.ok === false) throw Error(data.error?.message || (typeof data.error === 'string' ? data.error : data.message) || '操作未完成，请稍后重试。');
      return data;
    } catch(error) { if(error.name === 'AbortError') throw Error('请求超时，结果尚未确认。请刷新状态后再操作。'); throw error; }
    finally {clearTimeout(timer);}
  }
  function setBusy(value) {
    state.busy=value;
    if(value){state.controls=[...document.querySelectorAll('input,select,textarea')].map(control=>[control,control.disabled]);state.controls.forEach(([control])=>{control.disabled=true;});}
    else{for(const [control,disabled] of state.controls||[])if(control.isConnected)control.disabled=disabled;document.querySelectorAll('form[data-preferences]').forEach(updateControls);$('bot-select').disabled=!state.selected;}
    document.querySelectorAll('button').forEach(button=>{button.disabled=value;});$('request-form').querySelector('button').disabled=value||!state.enabled||state.capacity.available===0;
  }
  async function task(work) {if(state.busy)return;setBusy(true);try{await work();}catch(error){feedback(error.message,true);}finally{setBusy(false);}}
  function renderRequests() {
    const c=state.capacity;
    $('capacity').textContent=!state.enabled?'平台暂未开启私人 QQ 接入。':`可用名额：${c.available ?? '待核对'} / ${c.max ?? '待核对'}。${c.available===0?'当前容量已满，请稍后再试。':''}`;
    $('requests').innerHTML=state.requests.map(r=>{
      const terminal=['stopped','failed'].includes(r.status), actions=r.status==='mismatch'?[['cancel','停止接入']]:r.status==='cleanup_pending'?[['cancel','重试停止']]:terminal?[['reconnect','重新连接']]:r.status==='pending'?[['start','启动并获取二维码'],['cancel','取消申请']]:[['status','检查登录状态'],...(r.status==='expired'?[['refresh','刷新二维码']]:[]),...(r.status==='ready'?[['reconnect','重新连接']]:[]),['cancel','停止接入']];
      return `<article class="request-card"><h3>${escape(r.name)}</h3><p class="small">QQ ${escape(r.expectedQQ)} · <strong>${escape(statuses[r.status]||'状态待核对')}</strong></p>${r.reason?`<p class="inline-error">${escape(r.reason)}</p>`:''}${r.primary?'':`<div class="bot-actions">${actions.map(([action,label])=>`<button type="button" data-request="${escape(r.id)}" data-operation="${action}">${label}</button>`).join('')}</div>`}</article>`;
    }).join('')||'<p class="muted">还没有接入记录。先填写名称和本人 QQ 号，再发起接入。</p>';
    const old=state.selected, bots=state.requests.filter(r=>r.botId);
    $('bot-select').innerHTML=bots.map(r=>`<option value="${escape(r.botId)}">${escape(r.name)} · ${escape(r.expectedQQ)}</option>`).join('')||'<option value="">暂无可配置的机器人</option>';
    state.selected=bots.some(r=>r.botId===old)?old:(bots[0]?.botId||'');$('bot-select').value=state.selected;$('bot-select').disabled=!bots.length;
  }
  function renderLogin() {
    const login=state.login,r=state.requests.find(r=>r.id===state.active);$('login-panel').hidden=!login||!r;if(!login||!r)return;
    const raw=login.qrImage||login.qrDataUrl||login.imageDataUrl||login.image;
    const expired=Number.isFinite(login.expiresAt)&&login.expiresAt<=Date.now(), validImage=typeof raw==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(raw)&&raw.length<2*1024*1024;
    const waiting=login.state==='waiting_scan'&&!expired;
    $('login-content').innerHTML=`<div class="login-layout">${waiting&&validImage?`<img class="qr-image" src="${escape(raw)}" width="240" height="240" alt="使用申请的本人 QQ 扫描此登录二维码">`:''}<div class="login-copy"><p><strong>${escape(expired?'二维码已过期':statuses[login.state]||'状态待核对')}</strong></p><p>本次申请：${escape(r.name)} · QQ ${escape(r.expectedQQ)}</p>${waiting?`<p>${validImage?'请打开对应 QQ 扫码，并在手机上确认登录。':'二维码尚未返回，请稍后检查登录状态。'}</p>`:''}${login.expiresAt?`<p class="small muted">二维码到期时间：${escape(new Date(login.expiresAt).toLocaleTimeString('zh-CN'))}</p>`:''}<p class="small muted">${login.state==='mismatch'?'扫码账号不符，实例已暂停。请停止此申请后，用正确 QQ 重新申请。':'关闭页面不会自动停止接入；需要停止时请操作“停止接入”。'}</p><div class="bot-actions"><button type="button" data-request="${escape(r.id)}" data-operation="status">检查登录状态</button>${expired||login.state==='expired'?`<button type="button" data-request="${escape(r.id)}" data-operation="refresh">刷新二维码</button>`:''}</div></div></div>`;
  }
  async function loadRequests() {const data=await api('/api/platform/hosted-bots');state.requests=[...(data.primaryBot?[data.primaryBot]:[]),...(data.requests||[])];state.enabled=data.enabled===true;state.capacity=data.capacity||{};renderRequests();renderLogin();}
  function renderPreferences(target, data, defaultsMode=false) {
    const effective=defaultsMode?data.defaults:data.effective, inherited=data.platformDefaults||{}, overrides=data.overrides||{};
    if(!effective || !Number.isInteger(data.version)){target.textContent='偏好数据尚不可用，请刷新后重试。';return;}
    target.innerHTML=`${defaultsMode?'<h2>平台默认偏好</h2><p>普通账号与管理员都可为自己的机器人覆盖这些默认项。群与私聊名单默认留空，只有名单中的对象允许回复。</p>':'<p class="preference-intro muted">每项可继承平台默认，也可为当前机器人单独设置。回复概率先决定是否回复，语音概率决定回复后是否改用语音。</p>'}<form data-preferences="${defaultsMode?'defaults':'bot'}"><div class="preference-grid">${fields.map(([key,label,type,min,max,step])=>{
      const inheritedField=!defaultsMode&&overrides[key]==null,value=effective[key],id=(defaultsMode?'default-':'pref-')+key;
      let control;
      if(type==='boolean')control=`<select id="${id}" name="${key}"><option value="true" ${value===true?'selected':''}>开启</option><option value="false" ${value===false?'selected':''}>关闭</option></select>`;
      else if(type==='list'||type==='text')control=`<textarea id="${id}" name="${key}" rows="${type==='list'?3:5}" maxlength="${type==='list'?2000:12000}" ${type==='text'?'required':''}>${escape(type==='list'?(Array.isArray(value)?value.join('\n'):''):value)}</textarea>`;
      else control=`<div class="preference-value"><input id="${id}" name="${key}" type="${type}" min="${min}" max="${max}" step="${step}" value="${escape(value)}" required ${type==='range'?`aria-describedby="${id}-note"`:''}>${type==='range'?`<output for="${id}" id="${id}-output">${escape(value)}%</output>`:''}</div>`;
      return `${key==='contextMessages'?'</div><details class="preference-advanced"><summary>更多设置：上下文与语音细节</summary><div class="preference-grid">':''}<div class="preference-field" data-field="${key}"><label for="${id}">${label}</label>${control}${!defaultsMode?`<label class="check-label"><input type="checkbox" data-inherit="${key}" ${inheritedField?'checked':''}>使用平台默认 <span class="small">${escape(Array.isArray(inherited[key])?(inherited[key].length+' 项'):typeof inherited[key]==='boolean'?(inherited[key]?'开启':'关闭'):key==='personaText'?'默认人设':inherited[key])}${type==='range'?'%':''}</span></label>`:''}<small id="${id}-note">${key==='replyPercent'?'仅被 @ 时回复开启后，普通消息概率不参与判断。':type==='list'?'每行一个 QQ 号；留空表示不允许回复任何此类对象。':key==='voiceType'?'填写平台支持的音色编号；默认音色由平台选定。':key==='voiceEnabled'?'语音仍需平台额度与服务可用。':key==='personaText'?'用于当前机器人的聊天人设。':''}</small></div>`;
    }).join('')}</div></details><div class="preference-footer"><button class="primary" type="submit">${defaultsMode?'保存平台默认':'保存我的偏好'}</button>${!defaultsMode?'<button type="button" data-reset-preferences>全部恢复默认</button>':''}<span class="small muted" data-application role="status">${escape(application[data.application?.status]||'尚未保存本次修改。')}</span></div></form>`;
    updateControls(target.querySelector('form'));state.dirty=false;
  }
  function updateControls(form) {
    if(!form)return;
    for(const [key,,type] of fields){const control=form.elements[key],inherit=form.querySelector(`[data-inherit="${key}"]`);control.disabled=Boolean(inherit?.checked);if(type==='range'){form.querySelector(`#${control.id}-output`).textContent=control.value+'%';control.setAttribute('aria-valuetext',control.value+'%');}}
    const mention=form.elements.mentionOnly.value==='true';if(mention)form.elements.replyPercent.disabled=true;
    const note=form.querySelector(`#${form.elements.replyPercent.id}-note`);note.textContent=mention?'当前仅在被 @ 时回复，普通消息回复概率不参与判断。':'普通消息按此概率回复；@ 消息的行为由机器人策略决定。';
  }
  async function loadPreferences() {
    const selected=state.selected,serial=++state.selection;if(!selected){state.preference=null;$('preferences').textContent='完成接入后，可以在这里管理自己的机器人。';return;}
    $('preferences').textContent='正在读取机器人偏好…';
    try{const data=await api('/api/platform/bot-preferences?botId='+encodeURIComponent(selected));if(serial!==state.selection||selected!==state.selected)return;state.preference=data;renderPreferences($('preferences'),data);}catch(error){if(serial!==state.selection)return;$('preferences').textContent=error.message;throw error;}
  }
  async function operate(id,action) {
    const request=state.requests.find(r=>r.id===id);if(!request)throw Error('接入记录已变化，请刷新。');if(request.primary)throw Error('现有实例只支持在此调整偏好。');
    feedback(action==='cancel'?'正在停止接入，请等待核对结果…':'正在处理接入，请稍候…');
    const data=await api('/api/platform/hosted-bots/'+encodeURIComponent(id)+'/'+action,{version:request.version});
    if(!data.request||!data.login)throw Error('接入结果缺少状态，请刷新核对。');
    const at=state.requests.findIndex(r=>r.id===id);state.requests[at]=data.request;state.active=id;state.login=data.login;renderRequests();renderLogin();
    feedback(statuses[data.login.state]||'已收到接入状态。');
    if(action==='cancel'||data.login.state==='ready'){await loadRequests();if(!state.dirty)await loadPreferences();}
  }
  function readPreferences(form,defaultsMode) {
    const result={};for(const [key,label,type] of fields){if(!defaultsMode&&form.querySelector(`[data-inherit="${key}"]`).checked){result[key]=null;continue;}const value=form.elements[key].value;
      if(type==='boolean')result[key]=value==='true';else if(type==='list'){const list=[...new Set(value.split(/[\s,，]+/).filter(Boolean))];if(list.length>100||list.some(q=>!/^[1-9]\d{4,14}$/.test(q)||!Number.isSafeInteger(Number(q))))throw Error(label+'请每行填写一个有效 QQ 号，最多 100 项。');result[key]=list;}
      else if(type==='text'){if(!value.trim())throw Error('请填写机器人人设。');result[key]=value;}else result[key]=Number(value);
    }return result;
  }
  document.addEventListener('input',event=>{const form=event.target.closest('form[data-preferences]');if(form){state.dirty=true;updateControls(form);form.querySelector('[data-application]').textContent='有未保存的修改。';}});
  document.addEventListener('change',event=>{
    if(event.target.id==='bot-select'){if(state.dirty&&!confirm('当前偏好尚未保存，切换机器人将丢弃这些修改。继续吗？')){$('bot-select').value=state.selected;return;}state.selected=event.target.value;task(loadPreferences);}
    const inherit=event.target.dataset.inherit;if(inherit){const form=event.target.closest('form'),value=state.preference.platformDefaults[inherit],control=form.elements[inherit];if(event.target.checked)control.value=Array.isArray(value)?value.join('\n'):String(value);state.dirty=true;updateControls(form);}
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.operation)task(()=>operate(button.dataset.request,button.dataset.operation));
    if(button.id==='reload')task(async()=>{if(state.dirty&&!confirm('刷新将丢弃尚未保存的修改，继续吗？'))return;await loadRequests();await loadPreferences();feedback('状态已刷新。');});
    if(button.hasAttribute('data-reset-preferences')){const form=button.closest('form');form.querySelectorAll('[data-inherit]').forEach(input=>{input.checked=true;const value=state.preference.platformDefaults[input.dataset.inherit];form.elements[input.dataset.inherit].value=Array.isArray(value)?value.join('\n'):String(value);});state.dirty=true;updateControls(form);form.querySelector('[data-application]').textContent='已恢复继承，请保存后生效。';}
    if(button.dataset.tab)task(async()=>{const tab=button.dataset.tab;if(tab==='defaults'&&state.user?.role!=='admin')return;if(state.dirty&&!confirm('切换页面将丢弃尚未保存的修改，继续吗？'))return;state.tab=tab;$('mine-panel').hidden=tab!=='mine';$('defaults-panel').hidden=tab!=='defaults';document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-current',b.dataset.tab===tab?'page':'false'));if(tab==='defaults'){const data=await api('/api/platform/bot-defaults');state.defaults=data;renderPreferences($('defaults-panel'),data,true);}else await loadPreferences();});
  });
  document.addEventListener('submit',event=>{
    const form=event.target;if(form.id!=='request-form'&&!form.dataset.preferences)return;event.preventDefault();if(state.busy)return;
    task(async()=>{
      if(form.id==='request-form'){const qq=form.elements.expectedQQ.value.trim();if(!/^[1-9]\d{4,14}$/.test(qq)||!Number.isSafeInteger(Number(qq)))throw Error('请填写有效的本人 QQ 号。');const data=await api('/api/platform/hosted-bots',{expectedQQ:qq,name:form.elements.name.value.trim()});await loadRequests();feedback('申请已创建，请点击“启动并获取二维码”继续扫码。');if(data.request?.id)state.active=data.request.id;return;}
      const defaultsMode=form.dataset.preferences==='defaults',values=readPreferences(form,defaultsMode),data=await api('/api/platform/'+(defaultsMode?'bot-defaults':'bot-preferences'),defaultsMode?{expectedVersion:state.defaults.version,defaults:values}:{botId:state.selected,expectedVersion:state.preference.version,overrides:values},'PUT');
      if(defaultsMode){state.defaults=data;renderPreferences($('defaults-panel'),data,true);}else{state.preference=data;renderPreferences($('preferences'),data);}
      feedback(application[data.application?.status]||'偏好已保存；运行应用状态尚待核对。',data.application?.status==='failed');
    });
  });
  window.addEventListener('beforeunload',event=>{if(state.dirty){event.preventDefault();event.returnValue='';}});
  setInterval(()=>{if(document.hidden||state.busy||!state.active||!['starting','waiting_scan','connecting'].includes(state.login?.state))return;const r=state.requests.find(r=>r.id===state.active);if(!r||r.primary)return;if(state.login.expiresAt&&state.login.expiresAt<=Date.now()){state.login={...state.login,state:'expired'};renderLogin();return;}task(()=>operate(r.id,'status'));},5000);
  task(async()=>{try{const theme=localStorage.getItem('qq-agent-platform-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(theme==='dark'||theme==='light')document.documentElement.dataset.theme=theme;}catch{}
    const auth=await api('/api/auth/status');if(!auth.authenticated){location.replace('/login.html?returnTo='+encodeURIComponent('/my-bots.html'));return;}state.user=auth.user;$('user-label').textContent=auth.user.username+' · 账号设置';if(auth.user.role==='admin')$('tabs').insertAdjacentHTML('beforeend','<button type="button" data-tab="defaults">平台默认偏好</button>');await loadRequests();await loadPreferences();
  });
})();
