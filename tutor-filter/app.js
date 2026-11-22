import { LocalAPI } from './js/local-api.js';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
let jobs = []; const selected = new Set(); let origin = null; let mapEnabled = false;

/* ------------------------------------------------------------------ 界面状态 */

const UI_KEY = 'tutor-ui-v1';
const ui = loadUi();
let focusedId = null;
let selectMode = false;

function loadUi() {
  try {
    const raw = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    return {
      perRow: [2, 3, 4].includes(Number(raw.perRow)) ? Number(raw.perRow) : 2,
      side: Boolean(raw.side),
      sidePos: raw.sidePos === 'left' ? 'left' : 'right',
      more: Boolean(raw.more)
    };
  } catch { return { perRow: 2, side: false, sidePos: 'right', more: true } }
}
function saveUi() { try { localStorage.setItem(UI_KEY, JSON.stringify(ui)) } catch {} }

const SIDE_BREAKPOINT = 1100;

function columnsFor() {
  // 严格按用户选择：2/3/4 列；窄屏时统一一列
  if (window.innerWidth < 700) return 1;
  return ui.perRow;
}

function applyLayout() {
  const sideVisible = ui.side && window.innerWidth >= SIDE_BREAKPOINT;
  $('#resultsBody').classList.toggle('side-left', ui.sidePos === 'left');
  document.body.classList.toggle('side-open', sideVisible);
  applyMorePanel();
  const aside = $('#sideDetail');
  aside.hidden = !sideVisible;
  $('#sideToggle').checked = ui.side;
  $('#sidePos').value = ui.sidePos;
  $('#sidePos').disabled = !ui.side;
  $('#perRow').value = String(ui.perRow);
  $('#cards').style.gridTemplateColumns = `repeat(${columnsFor()}, minmax(0, 1fr))`;
  if (!sideVisible) return;
  if (focusedId == null || !jobs.some(job => job.id === focusedId)) {
    focusedId = jobs.length ? jobs[0].id : null;
  }
  markFocused();
  renderSide(focusedId);
}

function markFocused() {
  $$('.card').forEach(card => card.classList.toggle('focused', Number(card.dataset.id) === focusedId));
}

/* ------------------------------------------------------------------ 选择模式 */

function applySelectMode() {
  document.body.classList.toggle('select-mode', selectMode);
  const toggle = $('#selectToggle');
  toggle.setAttribute('aria-pressed', selectMode ? 'true' : 'false');
  $('#selectToggleLabel').textContent = selectMode ? '完成' : '选择';
  const count = $('#selectToggleCount');
  count.textContent = String(selected.size);
  count.hidden = !selectMode || selected.size === 0;
}

/* ------------------------------------------------------------------ 吸顶导航 */

function syncStickyBar() {
  const bar = $('#filterBar');
  if (!bar) return;
  const stuck = bar.classList.contains('is-stuck');
  document.documentElement.style.setProperty('--sticky-bar-h', `${stuck ? bar.offsetHeight : 0}px`);
}

function initStickyBar() {
  const bar = $('#filterBar');
  const sentinel = $('#filterSentinel');
  if (!bar || !sentinel) return;
  if (!('IntersectionObserver' in window)) {
    bar.classList.add('is-stuck');
    return;
  }
  new IntersectionObserver(entries => {
    const stuck = !entries[0].isIntersecting;
    const wasStuck = bar.classList.contains('is-stuck');
    bar.classList.toggle('is-stuck', stuck);
    // 吸顶时自动收起「更多筛选」，避免悬浮栏占掉半个屏幕
    if (stuck && !wasStuck && ui.more) {
      ui.more = false;
      saveUi();
      applyMorePanel();
    }
    syncStickyBar();
  }, { threshold: 0 }).observe(sentinel);
}

/* ------------------------------------------------------------------ 检索条件 */

function applyMorePanel() {
  const panel = $('#morePanel');
  if (!panel) return;
  panel.hidden = !ui.more;
  $('#moreBtn').setAttribute('aria-expanded', ui.more ? 'true' : 'false');
  syncStickyBar();
}

function filterChips() {
  const items = [];
  const stage = $('#stage').value, grade = $('#grade').value;
  if (stage || grade) {
    items.push({ label: `年级：${grade || stage}`, clear: () => selectGrade('', '', '全部年级') });
  }
  const subject = $('#subject').value;
  if (subject) {
    items.push({ label: `科目：${subject}`, clear: () => { $('#subject').value = ''; loadJobs() } });
  }
  const mode = $('#mode').value;
  if (mode) {
    items.push({ label: `方式：${mode}`, clear: () => { $('#mode').value = ''; loadJobs() } });
  }
  const status = $('#status').value;
  if (status) {
    items.push({ label: `状态：${status}`, clear: () => { $('#status').value = ''; loadJobs() } });
  }
  const price = $('#priceMin').value.trim();
  if (price) {
    items.push({ label: `时薪 ≥ ¥${price}`, clear: () => { $('#priceMin').value = ''; loadJobs() } });
  }
  const sort = $('#sort').value;
  if (sort && sort !== 'fresh') {
    const option = $('#sort').selectedOptions[0];
    items.push({ label: `排序：${option ? option.textContent : sort}`, clear: () => { $('#sort').value = 'fresh'; loadJobs() } });
  }
  if ($('#onlyFresh').checked) {
    items.push({ label: '隐藏疑似过期', clear: () => { $('#onlyFresh').checked = false; loadJobs() } });
  }
  const radius = $('#radius').value;
  if (origin) {
    items.push({
      label: `出发地：${origin.name}${radius ? ` · ${radius} 公里内` : ''}`,
      clear: () => {
        origin = null;
        $('#originLabel').textContent = '尚未选择出发地点';
        $('#originCandidates').innerHTML = '<option value="">请选择准确地点</option>';
        $('#radius').value = '';
        loadJobs();
      }
    });
  } else if (radius) {
    items.push({ label: `半径 ${radius} 公里（未选出发地）`, clear: () => { $('#radius').value = ''; loadJobs() } });
  }
  return items;
}

function advancedCount() {
  let count = 0;
  if ($('#mode').value) count += 1;
  if ($('#status').value) count += 1;
  if ($('#priceMin').value.trim()) count += 1;
  if ($('#sort').value !== 'fresh') count += 1;
  if (origin || $('#radius').value) count += 1;
  return count;
}

function renderActiveFilters() {
  const items = filterChips();
  const box = $('#activeFilters');
  box.innerHTML = items.length
    ? '<span class="af-label">生效条件</span>' +
      items.map((item, index) => `<button type="button" class="af-chip" data-chip="${index}">${esc(item.label)} <span>×</span></button>`).join('') +
      '<button type="button" class="af-clear" id="clearFilters">全部清空</button>'
    : '';
  box.querySelectorAll('[data-chip]').forEach(el => {
    el.onclick = () => items[Number(el.dataset.chip)].clear();
  });
  const clear = $('#clearFilters');
  if (clear) clear.onclick = clearAllFilters;

  const count = advancedCount();
  const badge = $('#moreCount');
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function clearAllFilters() {
  $('#q').value = '';
  $('#subject').value = '';
  $('#mode').value = '';
  $('#status').value = '';
  $('#priceMin').value = '';
  $('#sort').value = 'fresh';
  $('#onlyFresh').checked = true;
  $('#radius').value = '';
  origin = null;
  $('#originLabel').textContent = '尚未选择出发地点';
  $('#originCandidates').innerHTML = '<option value="">请选择准确地点</option>';
  selectGrade('', '', '全部年级');
}

function focusJob(id) {
  focusedId = id;
  markFocused();
  if (ui.side) renderSide(id);
}

function openSide() {
  ui.side = true;
  saveUi();
  applyLayout();
}

function closeSide() {
  ui.side = false;
  saveUi();
  applyLayout();
}

/* ------------------------------------------------------------------ 接口 */

async function request(url, options = {}) {
  const r = await LocalAPI.handle(url, options);
  let data = {}; try { data = await r.json() } catch {}
  if (!r.ok) throw new Error(data.detail || '操作失败');
  return data;
}

async function loadConfig() {
  const c = await request('/api/config');
  mapEnabled = c.map_enabled;
  const badge = $('#aiBadge');
  if (c.map_enabled) {
    badge.textContent = `高德已连接 · ${c.amap_key_masked || ''}`;
    badge.title = '点击更换或清除 Key';
  } else {
    badge.textContent = '未配置高德 Key · 点此配置';
    badge.title = '配置后才能搜索地点、算距离';
  }
  badge.classList.toggle('off', !c.map_enabled);
  if (c.packaged) startHeartbeat();
}

// 打包版没有托盘图标：页面每 20 秒报一次活，关掉窗口后服务端会自动退出
let heartbeatTimer = null;
function startHeartbeat() {
  if (heartbeatTimer) return;
  const ping = () => { fetch('/api/ping', { method: 'POST' }).catch(() => {}) };
  ping();
  heartbeatTimer = setInterval(ping, 20000);
}

/* ------------------------------------------------------------------ 高德 Key 配置 */

function setAmapStatus(message, kind = '') {
  const el = $('#amapStatus');
  el.textContent = message || '';
  el.className = `amap-status${kind ? ' ' + kind : ''}`;
}

async function refreshAmapStatus() {
  try {
    const status = await request('/api/settings/amap');
    if (!status.configured) return setAmapStatus('还没有配置 Key');
    const from = status.source === 'env' ? '.env 里的 Key' : '页面里保存的 Key';
    setAmapStatus(`当前已配置：${status.masked}（${from}）`, 'ok');
  } catch { /* 忽略：只是状态提示 */ }
}

function openAmapSetup(message) {
  $('#amapKeyInput').value = '';
  setAmapStatus('');
  refreshAmapStatus().then(() => {
    if (message) setAmapStatus(message, 'warn');
  });
  lockScroll(true);
  if (!$('#amapSetup').open) $('#amapSetup').showModal();
  setTimeout(() => $('#amapKeyInput').focus(), 60);
}

async function saveAmapKey() {
  const key = $('#amapKeyInput').value.trim();
  if (!key) return setAmapStatus('先把 Key 粘贴进来', 'warn');
  const button = $('#amapSave');
  button.disabled = true;
  setAmapStatus('正在保存并测试…');
  try {
    const result = await request('/api/settings/amap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key })
    });
    setAmapStatus(result.message, result.verified ? 'ok' : 'warn');
    if (result.verified) {
      $('#amapKeyInput').value = '';
      await loadConfig();
    }
  } catch (error) {
    setAmapStatus(error.message, 'warn');
  } finally {
    button.disabled = false;
  }
}

async function testAmapKey() {
  setAmapStatus('正在测试…');
  try {
    const result = await request('/api/settings/amap/test', { method: 'POST' });
    setAmapStatus(result.message, result.verified ? 'ok' : 'warn');
  } catch (error) {
    setAmapStatus(error.message, 'warn');
  }
}

async function clearAmapKey() {
  if (!confirm('清除已保存的高德 Key？清除后地点搜索和距离功能会关闭。')) return;
  try {
    const result = await request('/api/settings/amap', { method: 'DELETE' });
    setAmapStatus(result.configured ? '已清除页面里保存的 Key（仍在用 .env 里的）' : '已清除，地点功能关闭', 'warn');
    await loadConfig();
  } catch (error) {
    setAmapStatus(error.message, 'warn');
  }
}

function queryString() {
  const p = new URLSearchParams();
  [['q', '#q'], ['stage', '#stage'], ['grade', '#grade'], ['subject', '#subject'],
   ['mode', '#mode'], ['status', '#status'], ['price_min', '#priceMin'], ['sort', '#sort']].forEach(([k, s]) => {
    if ($(s).value) p.set(k, $(s).value);
  });
  if ($('#onlyFresh').checked) p.set('only_fresh', 'true');
  if (origin) {
    p.set('origin_lng', origin.lng); p.set('origin_lat', origin.lat);
    if ($('#radius').value) p.set('radius_km', $('#radius').value);
  }
  return p;
}

/* ------------------------------------------------------------------ 年级级联 */

const gradeMenus = {
  '幼儿园': [['小班', '小班'], ['中班', '中班'], ['大班', '大班'], ['学前 / 幼小衔接', '学前']],
  '小学': [['一年级', '一年级'], ['二年级', '二年级'], ['三年级', '三年级'], ['四年级', '四年级'], ['五年级', '五年级'], ['六年级', '六年级']],
  '初中': [['初一 / 七年级', '初一'], ['初二 / 八年级', '初二'], ['初三 / 九年级', '初三']],
  '高中': [['高一', '高一'], ['高二', '高二'], ['高三', '高三']]
};

function showGradeOptions(stage) {
  $$('#gradeStages button').forEach(b => b.classList.toggle('active', b.dataset.stage === stage));
  const options = stage ? [['全部' + stage, ''], ...(gradeMenus[stage] || [])] : [['全部年级', '']];
  $('#gradeOptions').innerHTML = options.map(([label, value]) =>
    `<button type="button" data-grade="${value}" data-for-stage="${stage || ''}">${label}${($('#stage').value === stage && $('#grade').value === value) ? '<b>✓</b>' : ''}</button>`).join('');
  $$('[data-grade]').forEach(b => b.onclick = () => selectGrade(b.dataset.forStage, b.dataset.grade, b.textContent.replace('✓', '').trim()));
}
function selectGrade(stage, grade, label) {
  $('#stage').value = stage; $('#grade').value = grade;
  $('#gradeTrigger').innerHTML = `${esc(label)} <span>›</span>`;
  $('#gradeMenu').classList.remove('open'); loadJobs();
}
function initGradeCascade() {
  const stages = [['', '全部年级'], ['幼儿园', '幼儿园'], ['小学', '小学'], ['初中', '初中'], ['高中', '高中']];
  $('#gradeStages').innerHTML = stages.map(([value, label]) => `<button type="button" data-stage="${value}">${label}<span>${value ? '›' : ''}</span></button>`).join('');
  $$('[data-stage]').forEach(b => {
    b.onmouseenter = () => showGradeOptions(b.dataset.stage);
    b.onfocus = () => showGradeOptions(b.dataset.stage);
    if (!b.dataset.stage) b.onclick = () => selectGrade('', '', '全部年级');
  });
  $('#gradeTrigger').onclick = e => {
    e.stopPropagation();
    const menu = $('#gradeMenu'); menu.classList.toggle('open');
    if (menu.classList.contains('open')) showGradeOptions($('#stage').value || '小学');
  };
  $('#gradeMenu').onclick = e => e.stopPropagation();
  document.addEventListener('click', () => $('#gradeMenu').classList.remove('open'));
}

/* ------------------------------------------------------------------ 数据加载 */

async function loadJobs() {
  const data = await request('/api/jobs?' + queryString());
  jobs = data.items; $('#count').textContent = data.total;
  for (const id of [...selected]) if (!jobs.some(j => j.id === id)) selected.delete(id);
  render();
  refreshLocalStatus();
}

/* ------------------------------------------------------------------ 本机数据状态 */

function setEngineStatus(text, error = false) {
  const el = $('#engineStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('is-error', Boolean(error));
}

function refreshLocalStatus() {
  const toggle = $('#saveToggle');
  if (toggle) toggle.checked = LocalAPI.saved;
  const el = $('#localStatus');
  if (!el) return;
  el.textContent = LocalAPI.saved
    ? `已保存到这台设备的浏览器里（${LocalAPI.size} 条），不会上传`
    : `只在当前页面里（${LocalAPI.size} 条），关掉就没了`;
}

/* ------------------------------------------------------------------ 展示辅助 */

const nf = v => (v == null ? '' : String(Math.round(v * 10) / 10).replace(/\.0$/, ''));

function priceOf(j) {
  const lo = j.hourly_min, hi = j.hourly_max;
  if (lo == null) {
    if (j.rate_min != null) {
      const unit = (j.rate_unit || '').replace('元/', '/');
      return { main: `¥${nf(j.rate_min)}${j.rate_max && j.rate_max !== j.rate_min ? '–' + nf(j.rate_max) : ''}`, sub: unit || '待确认', estimated: false };
    }
    return { main: j.price_note || '价格待确认', sub: '', estimated: false };
  }
  return {
    main: `¥${nf(lo)}${hi != null && hi !== lo ? '–' + nf(hi) : ''}/h`,
    sub: j.hourly_estimated ? '估算' : '',
    estimated: !!j.hourly_estimated
  };
}

function monthlyEstimate(j) {
  if (j.hourly_min == null || !j.frequency_per_week || !j.duration_hours) return null;
  const mid = (j.hourly_min + (j.hourly_max ?? j.hourly_min)) / 2;
  return Math.round(mid * j.frequency_per_week * j.duration_hours * 4.33);
}

function ageText(hours) {
  if (hours == null) return '';
  if (hours < 1) return '刚刚';
  if (hours < 24) return `${Math.round(hours)} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function scheduleText(j) {
  const parts = [];
  if (j.weekdays && j.weekdays.length) parts.push(j.weekdays.join(''));
  if (j.time_slot) parts.push(j.time_slot);
  if (j.frequency_per_week) parts.push(`每周${nf(j.frequency_per_week)}次`);
  if (j.duration_hours) parts.push(`一次${nf(j.duration_hours)}h`);
  if (!parts.length && j.time_text) parts.push(j.time_text);
  return parts.join(' · ');
}

function placeText(j) {
  return j.location_name || j.address || [j.city, j.district].filter(Boolean).join(' · ') || '地点待确认';
}

const EVIDENCE_LABELS = {
  address: '地址', order_no: '单号', district: '区县', grade: '年级', poster: '发布人',
  mode: '授课方式', subjects: '科目', weak_subjects: '弱科', rates: '价格原文',
  frequency: '频次', weekdays: '星期'
};

function metricList(j, limit = 99) {
  const p = priceOf(j);
  const rows = [];
  const push = (key, value) => {
    const text = String(value ?? '').trim();
    if (!text || text === '—') return;
    rows.push(`<dt>${esc(key)}</dt><dd>${esc(text)}</dd>`);
  };
  push('单号', j.order_no);
  push('发布', j.published_at ? `${j.published_at.replace('T', ' ').slice(0, 16)}${j.age_hours != null ? `（${ageText(j.age_hours)}）` : ''}` : '');
  push('状态', j.status);
  push('地点', placeText(j));
  push('时薪', p.main + (j.hourly_estimated ? '（估算）' : ''));
  push('原文口径', j.rate_min != null
    ? `¥${nf(j.rate_min)}${j.rate_max && j.rate_max !== j.rate_min ? '–' + nf(j.rate_max) : ''} ${j.rate_unit || ''}`
    : (j.price_note || ''));
  push('每周次数', j.frequency_per_week ? `${nf(j.frequency_per_week)} 次${j.freq_derived ? '（推算）' : ''}` : '');
  push('单次时长', j.duration_hours ? `${nf(j.duration_hours)} 小时` : '');
  push('上课时间', j.time_text);
  push('排除时间', (j.excluded_weekdays || []).join('、'));
  push('对老师要求', (j.requirements || []).join('、'));
  push('学员弱科', (j.weak_subjects || []).join('、'));
  push('老师需能教', (j.teacher_can_teach || []).join('、'));
  push('联系方式', j.contact);
  push('来源', j.source);
  return rows.slice(0, limit).join('');
}

function evidenceHtml(j, compact) {
  const entries = Object.entries(j.evidence || {});
  if (!entries.length) return '';
  const items = entries.map(([key, value]) => `<li><b>${esc(EVIDENCE_LABELS[key] || key)}</b> ${esc(value)}</li>`).join('');
  return `<details class="evidence-fold"${compact ? '' : ' open'}><summary>判定依据</summary><ul class="evidence">${items}</ul></details>`;
}

/* ------------------------------------------------------------------ 列表渲染 */

function render() {
  $('#cards').innerHTML = jobs.map(j => {
    const p = priceOf(j);
    const monthly = monthlyEstimate(j);
    const chips = [
      j.stale ? '<span class="chip warn">可能已出</span>' : '',
      j.teaching_mode ? `<span class="chip">${esc(j.teaching_mode)}</span>` : '',
      scheduleText(j) ? `<span class="chip">${esc(scheduleText(j))}</span>` : '',
      j.teacher_gender_required ? `<span class="chip warn">限${esc(j.teacher_gender_required)}老师</span>` : '',
      j.distance_km != null ? `<span class="chip">距你 ${nf(j.distance_km)} km${j.bike_minutes != null ? ` · 骑行约 ${j.bike_minutes} 分钟` : ''}</span>` : '',
      ...(j.tags || []).slice(0, 4).map(t => `<span class="chip dim">${esc(t)}</span>`)
    ].join('');
    return `<article class="card ${selected.has(j.id) ? 'selected' : ''} ${j.stale ? 'stale' : ''}" data-id="${j.id}">
      <input class="job-check card-select" type="checkbox" data-check="${j.id}" aria-label="选择家教单" ${selected.has(j.id) ? 'checked' : ''}>
      <div class="card-head">
        <div><h3><span class="card-grade">${esc(j.grade || '年级待确认')}</span><span class="card-subjects">${esc((j.subjects || []).join(' / ') || '科目待确认')}</span></h3>
          <div class="location">${esc(placeText(j))}</div></div>
        <div class="price">${esc(p.main)}<small>${esc([p.sub, monthly ? `约 ¥${monthly}/月` : ''].filter(Boolean).join(' · '))}</small></div>
      </div>
      <div class="chips">${chips}</div>
      <div class="card-foot">
        <select data-status="${j.id}">${['新单', '收藏', '已联系', '已过期', '忽略'].map(x => `<option ${x === j.status ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <span class="confidence">${esc(j.order_no || '无单号')}${ageText(j.age_hours) ? ' · ' + ageText(j.age_hours) : ''}</span>
        <button class="link-btn" data-view="${j.id}">详情</button>
        <button class="delete" data-delete="${j.id}">删除</button>
      </div>
    </article>`;
  }).join('');
  $('#empty').style.display = jobs.length ? 'none' : 'block';
  updateBatchBar();
  bindCards();
  applySelectMode();
  renderActiveFilters();
  applyLayout();
}

function updateBatchBar() {
  const ids = jobs.map(j => j.id), all = ids.length > 0 && ids.every(id => selected.has(id));
  $('#selectAll').checked = all;
  $('#selectAll').indeterminate = !all && ids.some(id => selected.has(id));
  $('#selectedCount').textContent = selected.size;
  $('#batchDelete').disabled = selected.size === 0;
  $('#batchActions').hidden = selected.size === 0;
  applySelectMode();
}

function bindCards() {
  $$('[data-check]').forEach(el => el.onchange = () => {
    const id = +el.dataset.check;
    el.checked ? selected.add(id) : selected.delete(id);
    el.closest('.card').classList.toggle('selected', el.checked);
    updateBatchBar();
  });
  $$('[data-status]').forEach(el => el.onchange = async () => {
    await request(`/api/jobs/${el.dataset.status}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: el.value })
    });
    loadJobs();
  });
  $$('[data-delete]').forEach(el => el.onclick = async () => {
    if (!confirm('确定删除这条家教信息？')) return;
    await request(`/api/jobs/${el.dataset.delete}`, { method: 'DELETE' });
    selected.delete(+el.dataset.delete); loadJobs();
  });
  $$('[data-view]').forEach(el => el.onclick = () => showDetail(+el.dataset.view));

  // 单击卡片：选择模式下=勾选/取消；否则=选中该单（描边）+ 侧栏；窄屏直接弹窗
  $$('.card').forEach(card => {
    card.onclick = event => {
      if (event.target.closest('input,select,button,a,summary,label')) return;
      const id = Number(card.dataset.id);
      if (selectMode) {
        const box = card.querySelector('[data-check]');
        if (box) {
          box.checked = !box.checked;
          box.dispatchEvent(new Event('change'));
        }
        return;
      }
      if (window.innerWidth < SIDE_BREAKPOINT) { showDetail(id); return; }
      if (!ui.side) openSide();
      focusJob(id);
    };
  });
}

/* ------------------------------------------------------------------ 侧栏 */

function renderSide(id) {
  const aside = $('#sideDetail');
  const job = jobs.find(item => item.id === id);
  if (!job) {
    aside.innerHTML = '<div class="side-empty">点任意一张卡片，这里固定显示它的指标和原文；想一次看全部就用「详情」弹窗。</div>';
    return;
  }
  const p = priceOf(job);
  aside.innerHTML = `
    <div class="side-head">
      <div>
        <h3>${esc(job.grade || '年级待确认')} · ${esc((job.subjects || []).join(' / ') || '科目待确认')}</h3>
        <div class="side-sub">${esc(placeText(job))} · ${esc(p.main)}</div>
      </div>
      <button class="side-close" id="sideClose" title="关闭侧栏">×</button>
    </div>
    <div class="side-metrics"><dl class="metric-list">${metricList(job, 10)}</dl></div>
    <div class="side-evidence">${evidenceHtml(job, true)}</div>
    <div class="side-raw"><h4>原文</h4><div class="raw-scroll">${esc(job.source_text)}</div></div>`;
  $('#sideClose').onclick = closeSide;
}

/* ------------------------------------------------------------------ 弹窗 */

function lockScroll(on) {
  if (on) {
    const gap = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.paddingRight = gap > 0 ? `${gap}px` : '';
    document.body.classList.add('modal-open');
  } else {
    document.body.classList.remove('modal-open');
    document.body.style.paddingRight = '';
  }
}

function showDetail(id) {
  const job = jobs.find(item => item.id === id);
  if (!job) return;
  focusedId = id;
  markFocused();
  $('#detailTitle').textContent = `${job.grade || '年级待确认'} · ${(job.subjects || []).join(' / ') || '科目待确认'}`;
  $('#detailBody').innerHTML = `
    <div class="dialog-col">
      <h3>指标</h3>
      <dl class="metric-list">${metricList(job)}</dl>
      ${evidenceHtml(job, false)}
    </div>
    <div class="dialog-col">
      <h3>原始信息</h3>
      <div class="raw-scroll">${esc(job.source_text)}</div>
    </div>`;
  lockScroll(true);
  const dialog = $('#detail');
  if (!dialog.open) dialog.showModal();
}

/* ------------------------------------------------------------------ 导入 */

function importSummary(d) {
  return `识别 ${d.found} 条，新增 ${d.added} 条` +
    (d.merged ? `，按单号更新 ${d.merged} 条` : '') +
    `，跳过重复 ${d.duplicates || 0} 条`;
}

async function doTextImport() {
  const text = $('#rawText').value.trim();
  if (!text) return notice('请先粘贴消息', true);
  setBusy(true);
  try {
    const d = await request('/api/import/text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source: 'QQ粘贴', use_ai: false })
    });
    notice(importSummary(d)); $('#rawText').value = ''; await loadJobs();
  } catch (e) { notice(e.message, true) } finally { setBusy(false) }
}

function notice(msg, error = false) {
  const n = $('#notice');
  n.textContent = msg;
  n.classList.toggle('is-error', Boolean(error));
  n.classList.toggle('is-ok', !error && Boolean(msg));
}
function setBusy(v) { $('#importBtn').disabled = v; $('#importBtn').textContent = v ? '正在识别…' : '识别并收录'; }
function mapNotice(msg, error = false) {
  const n = $('#mapNotice');
  n.textContent = msg;
  n.classList.toggle('is-error', Boolean(error));
  n.classList.toggle('is-ok', !error && Boolean(msg));
}

/* ------------------------------------------------------------------ 地图 */

async function searchOrigin() {
  const q = $('#originQuery').value.trim();
  if (!mapEnabled) return openAmapSetup('搜索地点需要先配置高德 Key，按下面三步申请即可。');
  if (!q) return mapNotice('请输入南京地点', true);
  $('#searchOrigin').disabled = true;
  try {
    const d = await request('/api/map/search?q=' + encodeURIComponent(q));
    const s = $('#originCandidates');
    s.innerHTML = '<option value="">请选择准确地点</option>' + d.items.map((p, i) => `<option value="${i}">${esc(p.name)} · ${esc(p.district)} ${esc(p.address)}</option>`).join('');
    s._places = d.items;
    mapNotice(d.items.length ? `找到 ${d.items.length} 个候选，请选择准确地点` : '没有找到候选地点', !d.items.length);
  } catch (e) { mapNotice(e.message, true) } finally { $('#searchOrigin').disabled = false }
}

async function geocodeJobs() {
  if (!mapEnabled) return openAmapSetup('识别家教地址需要先配置高德 Key，按下面三步申请即可。');
  $('#geocodeJobs').disabled = true;
  mapNotice('正在限速识别最近50条家教信息，请稍候…');
  try {
    const d = await request('/api/map/geocode-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ids":[]}' });
    mapNotice(`处理 ${d.processed} 条，成功定位 ${d.resolved} 条，待确认 ${d.failed} 条${d.rate_limited ? `，限流待重试 ${d.rate_limited} 条` : ''}`);
    await loadJobs();
  } catch (e) { mapNotice(e.message, true) } finally { $('#geocodeJobs').disabled = false }
}

async function reparseJobs() {
  if (!confirm('用当前规则把全部历史记录重解析一遍？状态和地图坐标会保留。')) return;
  $('#reparseJobs').disabled = true; mapNotice('正在重解析…');
  try {
    const d = await request('/api/jobs/reparse', { method: 'POST' });
    mapNotice(`重解析完成：共 ${d.total} 条，更新 ${d.updated} 条，失败 ${d.failed} 条`);
    await loadJobs();
  } catch (e) { mapNotice(e.message, true) } finally { $('#reparseJobs').disabled = false }
}

/* ------------------------------------------------------------------ 绑定 */

$('#importBtn').onclick = doTextImport;
$('#sampleBtn').onclick = () => {
  $('#rawText').value = `南京示例#新单
单号：TEST0001
地址：秦淮区示例花园
科目：英语（背单词，错题语法）
年级：初三
时间：一周2次，一次2小时
要求：女老师
老师薪水：200-240/2h

WY南京261121999F
【地址】鼓楼区示例小区
【科目】数学
【学员】初二，男，一对一老师上门。
【时间】一周1次，一次2小时，周末上课
【薪资】120-150/2h
【说明】以上为演示数据，不是真实订单`;
};

initGradeCascade();
$$('.filter-bar input:not([type="hidden"]), .filter-bar select').forEach(el => {
  el.oninput = () => { clearTimeout(el.t); el.t = setTimeout(loadJobs, 250) };
});

$('#moreBtn').onclick = () => {
  ui.more = !ui.more;
  saveUi();
  applyMorePanel();
};

$('#selectToggle').onclick = () => {
  selectMode = !selectMode;
  if (!selectMode) selected.clear();
  render();
};

$('#perRow').onchange = () => {
  ui.perRow = Number($('#perRow').value);
  saveUi(); applyLayout();
};
$('#sideToggle').onchange = () => {
  ui.side = $('#sideToggle').checked;
  saveUi(); applyLayout();
};
$('#sidePos').onchange = () => {
  ui.sidePos = $('#sidePos').value;
  saveUi(); applyLayout();
};

$('#detailClose').onclick = () => $('#detail').close();
$('#detail').addEventListener('close', () => { if (!$('#amapSetup').open) lockScroll(false) });
$('#detail').addEventListener('click', event => { if (event.target === $('#detail')) $('#detail').close() });

$('#aiBadge').onclick = () => openAmapSetup();
$('#openAmapSetup').onclick = () => openAmapSetup();
$('#amapClose').onclick = () => $('#amapSetup').close();
$('#amapSave').onclick = saveAmapKey;
$('#amapTest').onclick = testAmapKey;
$('#amapClear').onclick = clearAmapKey;
$('#amapKeyInput').onkeydown = event => { if (event.key === 'Enter') saveAmapKey() };
$('#amapSetup').addEventListener('close', () => { if (!$('#detail').open) lockScroll(false) });
$('#amapSetup').addEventListener('click', event => { if (event.target === $('#amapSetup')) $('#amapSetup').close() });

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    applyLayout();
    syncStickyBar();
  }, 150);
});

initStickyBar();
LocalAPI.onProgress(message => setEngineStatus(message.message));
try {
  await LocalAPI.init();
} catch (error) {
  setEngineStatus('本机存储不可用：' + error.message + '（仍可粘贴使用，但关掉就没了）', true);
}
refreshLocalStatus();
loadConfig().catch(() => {});
loadJobs();

$('#selectAll').onchange = e => { jobs.forEach(j => e.target.checked ? selected.add(j.id) : selected.delete(j.id)); render() };
$('#clearSelection').onclick = () => { selected.clear(); render() };
$('#batchDelete').onclick = async () => {
  const count = selected.size;
  if (!count || !confirm(`确定永久删除选中的 ${count} 条家教信息吗？此操作无法撤销。`)) return;
  try {
    const d = await request('/api/jobs/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...selected] })
    });
    selected.clear(); notice(`已删除 ${d.deleted} 条家教信息`); await loadJobs();
  } catch (e) { notice(e.message, true) }
};
$('#searchOrigin').onclick = searchOrigin;
$('#originQuery').onkeydown = e => { if (e.key === 'Enter') searchOrigin() };
$('#originCandidates').onchange = e => {
  const p = e.target._places?.[+e.target.value]; if (!p) return;
  origin = p; $('#originLabel').textContent = `从 ${p.name} 出发`;
  mapNotice('已选择出发地点，可设置半径筛选'); loadJobs();
};
$('#geocodeJobs').onclick = geocodeJobs;
$('#reparseJobs').onclick = reparseJobs;

/* ------------------------------------------------------------------ 本机数据 */

$('#rawText').addEventListener('focus', () => { LocalAPI.prefetch().catch(() => {}); }, { once: true });

$('#exportCsv').onclick = event => {
  event.preventDefault();
  const count = LocalAPI.exportCsv();
  notice(count ? `已导出 ${count} 条到 CSV` : '还没有记录可以导出', !count);
};

$('#exportBackup').onclick = () => {
  const count = LocalAPI.exportBackup();
  notice(count ? `备份文件已生成（${count} 条），请自己存好` : '还没有记录可以备份', !count);
};

$('#importBackup').onclick = () => $('#backupInput').click();

$('#backupInput').onchange = async event => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const summary = await LocalAPI.importBackup(file);
    notice(`已导入：新增 ${summary.added} 条，按单号更新 ${summary.merged} 条，跳过重复 ${summary.duplicates} 条`);
    await loadJobs();
  } catch (error) {
    notice(error.message, true);
  } finally {
    event.target.value = '';
  }
};

$('#clearAll').onclick = async () => {
  if (!confirm('清空这台设备上的全部家教记录？此操作无法撤销，建议先导出备份。')) return;
  const result = await LocalAPI.clearAll();
  origin = null;
  notice(`已清空 ${result.removed} 条记录`);
  await loadJobs();
};

$('#saveToggle').onchange = async event => {
  const on = event.target.checked;
  if (!on && !confirm('关闭保存后，之前存在这台设备上的记录会被删掉（当前页面里还能看到，关掉页面就没了）。继续吗？')) {
    event.target.checked = true;
    return;
  }
  await LocalAPI.setPersist(on);
  refreshLocalStatus();
  setEngineStatus(on ? '已开启：记录会留在这台设备上' : '已关闭保存：关掉页面后本次记录会消失');
};
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#detail').open) $('#detail').close();
});
