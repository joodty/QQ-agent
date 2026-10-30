const $ = id => document.getElementById(id);
let current = null, busy = false;
const controls = new Map();
const money = amount => Number(amount).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') + ' 元';
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
async function api(options) {
  const res = await fetch('/api/production-budgets', { ...options, headers: { 'x-console-token': 'qq-agent-console', ...(options?.headers || {}) } });
  const data = await res.json(); if (!res.ok) throw Error(data.error || '读取失败'); return data;
}
function render(data) {
  current = data; controls.clear(); $('conversations').replaceChildren();
  const limited = data.limitsEnforced !== false;
  $('default-limit').disabled = !data.enabled || !limited; $('save').disabled = !data.enabled || !limited;
  if (!data.enabled) { $('status').textContent = '此实例尚未配置生产预算。请由维护者完成出资和报价配置。'; return; }
  $('default-limit').value = data.defaultDailyLimitCny;
  for (const row of data.conversations) {
    const card = element('article', ''), title = element('h2', (row.key.startsWith('group:') ? '群聊 ' : '私聊 ') + row.key.split(':')[1]); card.append(title);
    const state = { normal: '正常', degraded: '已减少参与与输出', exhausted: '额度已用完', unlimited: '金额不限额' }[row.state] || row.state;
    card.append(element('p', `${row.date} · ${state}`), element('p', `已花 ${money(row.spentCny)} · 在途及未知 ${money(row.reservedCny)} · ${row.limitsEnforced === false ? '金额不限额' : '剩余 ' + money(row.remainingCny)}`));
    if (row.unknownReservations) card.append(element('p', `${row.unknownReservations} 次调用费用待核对${limited ? '，额度暂不退回' : '，保留记录，不因金额拦截调用'}。`));
    const inheritLabel = element('label', '', 'inherit'), inherit = document.createElement('input'); inherit.type = 'checkbox'; inherit.checked = !Object.hasOwn(data.overrides, row.key);
    inheritLabel.append(inherit, document.createTextNode('跟随默认每日额度')); card.append(inheritLabel);
    const label = element('label', '独立每日额度（元）', 'quota-label'), input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '1000000'; input.step = '0.000001'; input.required = true;
    inherit.disabled = !limited;
    input.value = data.overrides[row.key] ?? data.defaultDailyLimitCny; input.disabled = inherit.checked || !limited; input.setAttribute('aria-label', title.textContent + '的每日额度'); label.append(input); card.append(label);
    inherit.addEventListener('change', () => { input.disabled = inherit.checked; if (inherit.checked) input.value = $('default-limit').value; });
    controls.set(row.key, { inherit, input }); $('conversations').append(card);
  }
  $('status').textContent = limited ? '费用已更新。保存后，新额度会在下一次付费调用前生效。' : '本地金额限额已取消。费用和未知预留继续记录，原限额数值仅保留备用。';
}
async function load() { if (busy) return; busy = true; $('refresh').disabled = true; try { render(await api()); } catch (error) { $('status').textContent = error.message; } finally { busy = false; $('refresh').disabled = false; } }
$('refresh').addEventListener('click', load);
$('default-limit').addEventListener('input', () => { for (const { inherit, input } of controls.values()) if (inherit.checked) input.value = $('default-limit').value; });
$('limits').addEventListener('submit', async event => {
  event.preventDefault(); if (busy || !current?.enabled || current.limitsEnforced === false) return; busy = true; $('save').disabled = true;
  const overrides = Object.fromEntries([...controls].map(([key, { inherit, input }]) => [key, inherit.checked ? null : Number(input.value)]));
  try { render(await api({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: current.version, defaultDailyLimitCny: Number($('default-limit').value), overrides }) })); $('status').textContent = '每日额度已保存。'; }
  catch (error) { $('status').textContent = error.message; } finally { busy = false; $('save').disabled = !current?.enabled || current.limitsEnforced === false; }
});
load();
