const $ = selector => document.querySelector(selector);
const rows = $('#rows');
let accounts = [];
let batch = false;
let activityAvailable = false;
let capabilities = {};
let serviceReady = false;
const pending = new Set();
const pendingStatusElements = new Map();
let editingAccount = null;
let nameDraft = '';
let refreshingNames = false;
let nameRevision = 0;
let savedSchedule = null;
let scheduleDirty = false;
let savingSchedule = false;
let refreshingSchedule = false;
let scheduleRevision = 0;
let savedBatchSettings = null;
let savingBatchSettings = false;
const defaultMaxConcurrent = 5;
const nameFields = ['displayName', 'customName', 'accountName', 'maskedPhone', 'nameSource'];
function accountLabel(row) { return row.displayName || row.account; }
function applyName(row, value) {
  if (nameFields.some(field => field in value && row[field] !== value[field])) nameRevision++;
  for (const field of nameFields) if (field in value) row[field] = value[field];
}
const batchActions = [
  ['batchQuery', 'activity/progress', '批量查询', 'progress'],
  ['batchSign', 'activity/sign', '批量签到', 'sign'],
  ['batch', 'check', '检查全部账号', null],
  ['batchRun', 'activity/run', '全部签到领奖', 'all'],
];

async function api(route, data) {
  const options = data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {};
  const response = await fetch(`/api/${route}`, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
}
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function say(text) { $('#message').textContent = text; }
function drawBatchSettings() {
  const disabled = !savedBatchSettings || savingBatchSettings || Boolean(batch);
  $('#maxConcurrent').disabled = disabled;
  $('#saveBatchSettings').disabled = disabled;
  $('#saveBatchSettings').textContent = savingBatchSettings ? '正在保存…' : '保存并行设置';
  $('#batchSettingsForm').setAttribute('aria-busy', String(savingBatchSettings));
}
async function loadBatchSettings() {
  try {
    savedBatchSettings = await api('batch-settings');
    $('#maxConcurrent').value = savedBatchSettings.maxConcurrent;
    $('#batchSettingsStatus').textContent = savedBatchSettings.lastError || `已保存：最多同时处理 ${savedBatchSettings.maxConcurrent} 个账号。`;
  } catch (error) {
    $('#batchSettingsStatus').textContent = '并行设置读取失败：' + error.message + '。请刷新页面重试。';
  }
  drawBatchSettings();
}
async function saveBatchSettings(event) {
  event.preventDefault();
  if (!savedBatchSettings || savingBatchSettings || batch) return;
  const input = $('#maxConcurrent').value;
  const maxConcurrent = Number(input);
  const status = $('#batchSettingsStatus');
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    status.textContent = '同时处理的账号数必须是大于 0 的整数。';
    return;
  }
  savingBatchSettings = true;
  status.textContent = '正在保存并行设置…';
  draw();
  try {
    savedBatchSettings = await api('batch-settings', { maxConcurrent });
    $('#maxConcurrent').value = savedBatchSettings.maxConcurrent;
    status.textContent = `已保存：最多同时处理 ${savedBatchSettings.maxConcurrent} 个账号，批量操作和定时签到均使用此设置。`;
  } catch (error) { status.textContent = error.message; }
  finally { savingBatchSettings = false; draw(); }
}
function drawSchedule() {
  const unavailable = $('#scheduleEnabled').checked && (!accounts.length || !capabilities.sign);
  $('#saveSchedule').disabled = !savedSchedule || savingSchedule || unavailable;
  $('#saveSchedule').textContent = savingSchedule ? '正在保存…' : '保存设置';
  $('#scheduleTime').disabled = !savedSchedule || savingSchedule;
  $('#scheduleEnabled').disabled = !savedSchedule || savingSchedule;
  $('#scheduleForm').setAttribute('aria-busy', String(savingSchedule));
}
function drawScheduleStatus() {
  if (!savedSchedule) return;
  const state = $('#scheduleState');
  const configured = savedSchedule.enabled
    ? `已保存：每天 ${savedSchedule.time}（北京时间）。${savedSchedule.nextRunAt ? '下次执行：' + beijingTime(savedSchedule.nextRunAt) + '。' : ''}`
    : '已保存：定时签到已关闭。';
  state.textContent = (savedSchedule.running ? '正在执行定时批量签到… ' : '') + configured;
  const results = $('#scheduleResults');
  results.replaceChildren();
  if (savedSchedule.lastRun) {
    const last = savedSchedule.lastRun;
    results.append(element('p', `上次执行 ${beijingTime(last.finishedAt || last.startedAt)}：新签到 ${last.signed} 个，今日已签 ${last.alreadySigned} 个，失败 ${last.failed} 个。`, 'state'));
    const failures = (last.results || []).filter(result => !result.ok);
    if (failures.length) {
      const list = element('ul', '', 'schedule-failures');
      for (const result of failures) list.append(element('li', `${result.displayName || result.account}：${result.error || '签到失败，请重新查询。'}`));
      results.append(list);
    }
  }
  if (savedSchedule.lastError) results.append(element('p', '最近任务异常：' + savedSchedule.lastError, 'state'));
}
function scheduleChanged() {
  scheduleRevision++;
  scheduleDirty = true;
  $('#scheduleStatus').textContent = $('#scheduleEnabled').checked && (!accounts.length || !capabilities.sign)
    ? '请先添加账号，并接通签到服务后再开启定时签到。'
    : '设置尚未保存，点击“保存设置”后生效。';
  drawSchedule();
}
async function refreshSchedule() {
  if (refreshingSchedule || savingSchedule || document.hidden) return;
  refreshingSchedule = true;
  const revision = scheduleRevision;
  try {
    const result = await api('schedule');
    if (savingSchedule || revision !== scheduleRevision) return;
    savedSchedule = result;
    if (!scheduleDirty) {
      $('#scheduleTime').value = result.time;
      $('#scheduleEnabled').checked = result.enabled;
    }
    drawScheduleStatus();
    drawSchedule();
  } catch (error) {
    if (!scheduleDirty && !savingSchedule) $('#scheduleStatus').textContent = '定时设置读取失败：' + error.message;
  } finally { refreshingSchedule = false; }
}
async function saveSchedule(event) {
  event.preventDefault();
  if (savingSchedule || !savedSchedule) return;
  const enabled = $('#scheduleEnabled').checked;
  const time = $('#scheduleTime').value;
  const status = $('#scheduleStatus');
  if (enabled && (!accounts.length || !capabilities.sign)) {
    status.textContent = '请先添加账号，并接通签到服务后再开启定时签到。';
    return;
  }
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    status.textContent = '请选择每天的执行时间，例如 09:00。';
    return;
  }
  savingSchedule = true;
  scheduleRevision++;
  status.textContent = '正在保存定时设置…';
  drawSchedule();
  try {
    savedSchedule = await api('schedule', { enabled, time });
    scheduleDirty = false;
    $('#scheduleTime').value = savedSchedule.time;
    $('#scheduleEnabled').checked = savedSchedule.enabled;
    drawScheduleStatus();
    status.textContent = savedSchedule.enabled ? '设置已保存，到点后会自动签到。请保持项目运行。' : '设置已保存，已关闭定时签到。';
  } catch (error) { status.textContent = error.message; }
  finally {
    savingSchedule = false;
    drawSchedule();
  }
}
function beijingTime(at) {
  return at ? new Date(at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
}
function progressMessage(result, stale = false) {
  const when = beijingTime(result.at);
  const today = typeof result.todaySigned === 'boolean' ? ' · ' + (result.todaySigned ? '今日已签到' : '今日未签到') : '';
  return (stale ? '上次查询：累计签到 ' : '当前累计签到 ') + result.signedCount + '/' + result.totalDays + ' 天' + today + ' · 查询时间 ' + when + '（北京时间）';
}
async function queryDays(row) {
  const result = await api('activity/progress', { account: row.account });
  if (result.source !== 'live' || !Number.isInteger(result.signedCount) || !Number.isInteger(result.totalDays) ||
      result.signedCount < 0 || result.signedCount > result.totalDays || result.totalDays < 1) {
    throw new Error('这次查询未取得游戏服务器的新进度');
  }
  return result;
}
async function run(row, route) {
  pending.add(row.account);
  const action = route === 'activity/progress' ? '正在查询官方进度…' : route === 'activity/sign' ? '正在向官方服务器签到并核对结果…' : route === 'activity/run' ? '正在签到、领取礼盒并核对结果…' : '正在连接…';
  const startedAt = Date.now();
  const updateWait = () => {
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const hint = seconds >= 30
      ? '等待较久，官方可能正在维护或网络较慢；操作结束后可点“进入游戏”查看官方提示。'
      : route.startsWith('activity/') ? '启动游戏可能需要一些时间。' : '';
    row.pendingAction = `${action} 已等待 ${seconds} 秒。${hint}`;
    const status = pendingStatusElements.get(row.account);
    if (status) status.textContent = row.pendingAction;
  };
  updateWait();
  if (route.startsWith('activity/')) {
    row.activity = '';
    row.progressStale = Boolean(row.progress);
  }
  if (!batch) say('');
  draw();
  const timer = setInterval(updateWait, 1000);
  try {
    const result = route === 'activity/progress' ? await queryDays(row) : await api(route, { account: row.account });
    applyName(row, result);
    if (route === 'check') row.status = result.status;
    else if (route === 'activity/progress') {
      row.progress = result;
      row.progressStale = false;
      if (!batch) say(`${accountLabel(row)} 已查询到官方服务器的最新签到进度。`);
    }
    else if (route.startsWith('activity/')) {
      if (route === 'activity/sign') {
        const progress = result.progress?.source === 'live' ? result.progress : await queryDays(row);
        row.progress = progress;
        row.progressStale = false;
        if (progress.todaySigned !== true) throw new Error('已收到签到回复，但尚未确认今日已签到，请重新查询。');
        row.activity = result.alreadySigned || !result.verified?.length ? '今日已经签到，无需重复签到。' : '今日签到成功，已重新查询并确认。';
      } else {
        if (result.progress?.source === 'live') {
          row.progress = result.progress;
          row.progressStale = false;
        }
        const actions = result.verified.join('、') || '本次没有可执行的操作';
        row.activity = actions + '。累计 ' + result.signedCount + '/' + result.totalDays + ' 天。';
      }
      if (!batch) say(`${accountLabel(row)}：${row.activity}`);
    } else if (route !== 'check' && !batch) say(`${accountLabel(row)} 的官方游戏窗口已打开。`);
    return { ok: true, alreadySigned: route === 'activity/sign' && (result.alreadySigned || !result.verified?.length) };
  } catch (error) {
    if (route.startsWith('activity/')) row.activity = error.message;
    else row.status = error.message;
    if (!batch) say(error.message);
    return { ok: false };
  }
  finally {
    if (timer !== undefined) clearInterval(timer);
    pending.delete(row.account);
    row.pendingAction = '';
    draw();
  }
}
async function removeAccount(row) {
  if (pending.has(row.account) || batch || !accounts.includes(row)) return;
  if (!window.confirm(`从本机签到台移除“${accountLabel(row)}”？\n不会注销游戏账号；登录资料会保留。`)) return;
  pending.add(row.account);
  row.pendingAction = '正在移除账号…';
  say('');
  draw();
  try {
    await api('remove', { account: row.account });
    accounts = accounts.filter(account => account.account !== row.account);
    if (editingAccount === row.account) editingAccount = null;
    say(`已从签到台移除 ${accountLabel(row)}。`);
  } catch (error) { say(error.message); }
  finally { pending.delete(row.account); row.pendingAction = ''; draw(); }
}
async function saveName(row, displayName) {
  if (pending.has(row.account) || batch) return;
  nameRevision++;
  pending.add(row.account);
  draw();
  try {
    applyName(row, await api('name', { account: row.account, displayName }));
    if (editingAccount === row.account) editingAccount = null;
    say(displayName.trim() ? `名称已保存为“${accountLabel(row)}”。` : `已恢复自动名称：${accountLabel(row)}。`);
  } catch (error) { say(error.message); }
  finally { pending.delete(row.account); draw(); }
}
function nameEditor(row) {
  const form = element('form', '', 'name-editor');
  const label = element('label', '显示名称');
  const input = element('input');
  input.id = 'edit-name';
  input.maxLength = 32;
  input.value = nameDraft;
  input.placeholder = row.accountName || row.maskedPhone || row.account;
  input.autocomplete = 'off';
  input.disabled = pending.has(row.account);
  input.oninput = () => { nameDraft = input.value; };
  label.htmlFor = input.id;
  const hint = element('span', '留空时，自动使用登录账号名或脱敏手机号。', 'state name-hint');
  hint.id = 'name-hint';
  input.setAttribute('aria-describedby', hint.id);
  const controls = element('div', '', 'name-controls');
  const save = element('button', pending.has(row.account) ? '保存中…' : '保存', 'primary');
  save.type = 'submit';
  const cancel = element('button', '取消');
  cancel.type = 'button';
  cancel.onclick = () => { editingAccount = null; draw(); };
  controls.append(save, cancel);
  if (row.customName) {
    const automatic = element('button', '使用自动名称');
    automatic.type = 'button';
    automatic.onclick = () => saveName(row, '');
    controls.append(automatic);
  }
  for (const button of controls.children) button.disabled = pending.has(row.account);
  form.append(label, input, hint, controls);
  form.onsubmit = event => { event.preventDefault(); if (!pending.has(row.account)) saveName(row, nameDraft); };
  form.onkeydown = event => { if (event.key === 'Escape' && !pending.has(row.account)) { editingAccount = null; draw(); } };
  return form;
}
function draw() {
  $('#count').textContent = `${accounts.length} 个`;
  drawSchedule();
  drawBatchSettings();
  if (batch) say(`${batch.label}：已完成 ${batch.completed}/${batch.total}，正在处理 ${pending.size} 个，等待 ${Math.max(0, batch.total - batch.completed - pending.size)} 个。`);
  const blocked = Boolean(batch) || savingBatchSettings || pending.size > 0 || !accounts.length;
  for (const [id, route, label, capability] of batchActions) {
    const button = $('#' + id);
    const available = capability === 'all' ? activityAvailable : !capability || capabilities[capability];
    button.disabled = blocked || !available;
    button.textContent = batch && batch.route === route ? `${label} ${batch.completed}/${batch.total}` : label;
  }
  rows.replaceChildren();
  pendingStatusElements.clear();
  for (const row of accounts) {
    const card = element('article', '', 'row');
    const info = element('div', '', 'account-info');
    const heading = element('div', '', 'account-heading');
    heading.append(element('strong', accountLabel(row)));
    const edit = element('button', '修改名称', 'edit-name');
    edit.type = 'button';
    edit.setAttribute('aria-label', `修改 ${accountLabel(row)} 的名称`);
    edit.disabled = pending.has(row.account) || Boolean(batch);
    edit.onclick = () => {
      editingAccount = row.account;
      nameDraft = row.customName || '';
      draw();
      $('#edit-name').focus();
    };
    heading.append(edit);
    info.append(heading);
    if (editingAccount === row.account) info.append(nameEditor(row));
    const status = element('span', pending.has(row.account) ? row.pendingAction || '正在保存…' : row.status, 'state');
    if (pending.has(row.account)) pendingStatusElements.set(row.account, status);
    info.append(status);
    if (row.progress) info.append(element('span', progressMessage(row.progress, row.progressStale), 'state'));
    else info.append(element('span', '签到进度未查询，请点击“查签到天数”', 'state'));
    if (row.activity) info.append(element('span', row.activity, 'state'));
    const actions = element('div', '', 'actions');
    const buttons = [
      ['activity/progress', '查签到天数', capabilities.progress],
      ['activity/sign', '今日签到', capabilities.sign],
      ['check', '检查登录', true], ['activity/run', '签到领奖', activityAvailable], ['open', '进入游戏 ↗', true],
    ];
    for (const [route, title, available] of buttons) {
      const button = element('button', title, route === 'open' ? 'primary' : '');
      button.disabled = pending.has(row.account) || batch || !available;
      if (!available) button.title = '游戏服务尚未接通此操作';
      button.onclick = () => run(row, route);
      actions.append(button);
    }
    const remove = element('button', '移除账号', 'remove-account');
    remove.type = 'button';
    remove.disabled = pending.has(row.account) || Boolean(batch);
    remove.setAttribute('aria-label', `移除账号 ${accountLabel(row)}`);
    remove.onclick = () => removeAccount(row);
    actions.append(remove);
    card.append(info, actions);
    rows.append(card);
  }
  if (!accounts.length) rows.append(element('p', '先添加一个账号，再打开游戏登录。名称可以自定义，也可以在登录后自动识别。'));
  rows.setAttribute('aria-busy', String(Boolean(batch) || pending.size > 0));
}
async function runBatch(route, label) {
  if (batch || savingBatchSettings || pending.size || !accounts.length) return;
  const targets = [...accounts];
  const maxConcurrent = savedBatchSettings?.maxConcurrent ?? defaultMaxConcurrent;
  let succeeded = 0, failed = 0, alreadySigned = 0;
  let next = 0;
  batch = { route, label, total: targets.length, completed: 0 };
  draw();
  try {
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, targets.length) }, async () => {
      while (next < targets.length) {
        const row = targets[next++];
        const result = await run(row, route);
        if (result.ok) {
          succeeded++;
          if (result.alreadySigned) alreadySigned++;
        } else failed++;
        batch.completed++;
        draw();
      }
    }));
  } finally {
    batch = false;
    draw();
    say(route === 'activity/sign'
      ? `批量签到完成：新签到 ${succeeded - alreadySigned} 个，今日已签 ${alreadySigned} 个，失败 ${failed} 个。`
      : `${label}完成：成功 ${succeeded} 个，失败 ${failed} 个。`);
  }
}
for (const [id, route, label] of batchActions) $('#' + id).onclick = () => runBatch(route, label);
$('#batchSettingsForm').onsubmit = saveBatchSettings;
$('#maxConcurrent').oninput = () => { $('#batchSettingsStatus').textContent = '设置尚未保存，点击“保存并行设置”后生效。'; };
$('#scheduleForm').onsubmit = saveSchedule;
$('#scheduleTime').oninput = scheduleChanged;
$('#scheduleEnabled').onchange = scheduleChanged;
$('#add').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const result = await api('add', { displayName: $('#alias').value.trim() });
    const row = { ...result, status: '待检查' };
    accounts.push(row);
    form.reset(); draw(); say(`已添加 ${accountLabel(row)}，可点击“进入游戏”登录。`);
  } catch (error) { say(error.message); }
  finally { button.disabled = false; }
};
async function calendar() {
  try {
    const season = await api('calendar');
    $('#season-title').textContent = season ? `第 ${season.id} 期 · ${season.totalDays} 天` : '当前没有进行中的活动';
    if (!season) return;
    $('#dates').textContent = `${season.start.slice(0,10)} 至 ${season.end.slice(0,10)}${season.today ? `　·　活动第 ${season.today} 天` : ''}`;
    $('#milestones').append('累计奖励', ...season.milestones.map(n => element('span', `${n} 天`, 'day')));
  } catch (error) { $('#season-title').textContent = '活动日历读取失败'; $('#dates').textContent = error.message; }
}
$('#batch').disabled = true;
calendar();
refreshSchedule();
api('activity').then(result => {
  activityAvailable = result.available;
  capabilities = result.capabilities || {};
  serviceReady = Boolean(result.capabilities);
  const state = $('#activityState');
  if (!serviceReady && !activityAvailable) state.textContent = '游戏实时查询、签到和领奖尚未接通。';
  else if (activityAvailable) state.textContent = '签到领奖会先签当天，再领取可领取的礼盒。';
  else if (!capabilities.progress) state.textContent = '游戏实时查询尚未接通。';
  else if (capabilities.sign) state.textContent = '点击“查签到天数”获取官方服务器最新进度；点击“今日签到”完成签到并核对结果。首次使用或登录过期时，请先进入游戏登录。';
  else state.textContent = '点击“查签到天数”获取官方服务器最新进度。可用的操作显示在账号旁。';
  draw();
}).catch(error => { $('#activityState').textContent = error.message; });
await loadBatchSettings();
try { accounts = await api('accounts'); draw(); }
catch (error) { rows.textContent = error.message; rows.setAttribute('aria-busy', 'false'); }

async function refreshNames() {
  if (refreshingNames || batch || pending.size || editingAccount || document.hidden) return;
  refreshingNames = true;
  const revision = nameRevision;
  try {
    const latest = await api('accounts');
    if (revision !== nameRevision || batch || pending.size || editingAccount) return;
    let changed = false;
    for (const row of accounts) {
      const value = latest.find(item => item.account === row.account);
      if (!value) continue;
      if (nameFields.some(field => row[field] !== value[field])) {
        applyName(row, value);
        changed = true;
      }
    }
    if (changed && !editingAccount) draw();
  } catch { /* Keep saved names while the game or local service is unavailable. */ }
  finally { refreshingNames = false; }
}
setInterval(refreshNames, 15000);
setInterval(refreshSchedule, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshNames(); refreshSchedule(); } });
window.addEventListener('focus', () => { refreshNames(); refreshSchedule(); });
