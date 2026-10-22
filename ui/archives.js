const $ = id => document.getElementById(id);
let current = null;
let loading = false;
async function api(url, options) {
  const response = await fetch(url, { ...options, headers: { 'x-console-token': 'qq-agent-console', ...options?.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请稍后再试');
  return result;
}
function element(tag, text, className) {
  const el = document.createElement(tag); el.textContent = text;
  if (className) el.className = className;
  return el;
}
async function load(chatKey = $('chat').value) {
  if (loading) return;
  loading = true;
  try {
    const data = await api('/api/conversation-archives' + (chatKey ? '?chatKey=' + encodeURIComponent(chatKey) : ''));
    current = data;
    $('chat').replaceChildren(element('option', '请选择聊天对象'));
    $('chat').firstChild.value = '';
    for (const key of data.chats) { const option = element('option', key.startsWith('group:') ? '群聊 ' + key.slice(6) : '私聊 ' + key.slice(8)); option.value = key; $('chat').append(option); }
    $('chat').value = chatKey;
    $('chat').disabled = !data.chats.length;
    $('list').replaceChildren(); $('messages').replaceChildren();
    $('persona').textContent = data.selected?.persona?.content || '尚未选择档案';
    $('status').textContent = !data.enabled ? '还没有导入旧档案。请按下方说明在运行机器完成导入。'
      : chatKey ? '当前：' + (data.selected?.persona?.name || '尚未选择档案') : '请选择聊天对象，查看它保存的人设档案。';
    if (!chatKey) return;
    for (const archive of data.archives) {
      const id = archive.archiveId ?? archive.id;
      const card = element('article', '');
      card.append(element('h2', archive.persona?.name ?? archive.personaName ?? archive.name ?? id));
      card.append(element('p', '档案 ' + id + (archive.legacySessionId ? ' · 原会话 ' + archive.legacySessionId : ''), 'meta'));
      const inactive = archive.continuation && archive.continuation !== 'ready';
      const button = element('button', inactive ? '仅保留历史，暂不能续聊' : id === data.selected?.archiveId ? '当前使用' : '切换并继续这个档案');
      button.disabled = inactive || id === data.selected?.archiveId;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api('/api/conversation-archives/select', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chatKey, archiveId: id, expectedVersion: current.selected?.selectionVersion ?? 0 }) });
          await load(chatKey);
        } catch (error) { $('status').textContent = error.message; button.disabled = false; }
      });
      card.append(button); $('list').append(card);
    }
    for (const message of data.messages) $('messages').append(element('li', (message.self ? '机器人' : message.senderName || message.senderId || '对方') + '：' + message.text));
  } catch (error) { $('status').textContent = error.message; }
  finally { loading = false; }
}
$('chat').addEventListener('change', () => load());
load();
