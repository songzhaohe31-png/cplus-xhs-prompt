const state = {
  rules: null,
  materials: [],
  schedules: [],
  posts: [],
  settings: null
};

let page = 'prompt';
let promptKind = 'schedule';
let lastPrompt = '';
let rulesDirty = false;
let saveTimer = null;
let lastSavedAt = null;

const RULE_FIELDS = [
  'accountPosition', 'targetAudience', 'persona', 'coverTitleStyle', 'coverTitleMaxLength',
  'bodyStructure', 'writingStyle', 'wordCountMin', 'wordCountMax', 'imageSuggestions',
  'tagRule', 'prohibitions', 'materialConstraint'
];

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body) });
const put = (url, body) => api(url, { method: 'PUT', body: JSON.stringify(body) });
const del = (url) => api(url, { method: 'DELETE' });

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad(n) { return String(n).padStart(2, '0'); }

function whenFull(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  return `${x.getMonth() + 1}月${x.getDate()}日 ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

function copy(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text);
  else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function toast(msg, bad) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function busy(on, text) {
  const v = document.getElementById('veil');
  document.getElementById('veilText').textContent = text || '处理中';
  v.classList.toggle('hidden', !on);
}

function showSavebar(on) {
  document.getElementById('savebar').classList.toggle('hidden', !on);
}

function paintSavebar() {
  const bar = document.getElementById('savebar');
  const label = document.getElementById('saveState');
  bar.classList.toggle('dirty', rulesDirty);
  bar.classList.toggle('clean', !rulesDirty);
  if (rulesDirty) label.textContent = '有未保存的修改';
  else if (lastSavedAt) label.textContent = '已保存 · ' + whenFull(lastSavedAt);
  else label.textContent = '规则已保存';
}

async function go(name) {
  if (page === 'rules' && name !== 'rules' && rulesDirty) {
    await saveRules(false);
  }
  page = name;
  const url = new URL(location.href);
  url.searchParams.set('p', name);
  history.replaceState(null, '', url);
  document.querySelectorAll('.steps button').forEach((b) => {
    b.classList.toggle('on', b.dataset.page === name);
  });
  draw();
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    const [rules, mats, sch, posts, set] = await Promise.all([
      api('/api/rules'),
      api('/api/materials'),
      api('/api/schedules'),
      api('/api/posts'),
      api('/api/settings')
    ]);
    state.rules = rules;
    state.materials = mats.items || [];
    state.schedules = sch.items || [];
    state.posts = posts.items || [];
    state.settings = set;
    lastSavedAt = rules.updatedAt || null;
  } catch (e) {
    toast(e.message, true);
  }
  const asked = new URLSearchParams(location.search).get('p');
  const allowed = ['rules', 'materials', 'prompt', 'archive'];
  page = allowed.includes(asked) ? asked : 'rules';
  go(page);
}

function val(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function num(id, fallback) {
  const n = parseInt(val(id), 10);
  return Number.isFinite(n) ? n : fallback;
}

function draw() {
  const root = document.getElementById('stage');
  if (page === 'rules') {
    root.innerHTML = viewRules();
    watchRules();
    showSavebar(true);
    paintSavebar();
  } else {
    showSavebar(false);
    if (page === 'materials') root.innerHTML = viewMaterials();
    else if (page === 'prompt') root.innerHTML = viewPrompt();
    else root.innerHTML = viewArchive();
  }
}

function viewRules() {
  const r = state.rules || {};
  return `
    <h1>账号规则</h1>
    <p class="lead">左边写定位、人群、人设；右边是每次生成都会带上的格式细则。改完会自动保存。</p>
    <div class="rules-grid">
      <section class="panel">
        <h2>主号设定</h2>
        <div class="field">
          <label>定位</label>
          <textarea id="r_accountPosition" rows="5">${esc(r.accountPosition)}</textarea>
        </div>
        <div class="field">
          <label>人群</label>
          <textarea id="r_targetAudience" rows="5">${esc(r.targetAudience)}</textarea>
        </div>
        <div class="field">
          <label>人设</label>
          <textarea id="r_persona" rows="5">${esc(r.persona)}</textarea>
        </div>
        <div class="actions">
          <button class="btn ghost" onclick="copyRulesPrompt()">复制规则 Prompt</button>
          <button class="btn" onclick="exportRulesPdf()">导出 PDF</button>
          <button class="btn quiet" onclick="resetRules()">恢复默认</button>
        </div>
      </section>
      <section class="panel">
        <h2>格式细则</h2>
        <div class="field">
          <label>封面标题</label>
          <input type="text" id="r_coverTitleStyle" value="${esc(r.coverTitleStyle)}">
        </div>
        <div class="field">
          <label>标题字数上限</label>
          <input type="text" id="r_coverTitleMaxLength" value="${esc(r.coverTitleMaxLength)}">
        </div>
        <div class="field">
          <label>正文结构</label>
          <textarea id="r_bodyStructure" rows="3">${esc(r.bodyStructure)}</textarea>
        </div>
        <div class="field">
          <label>行文</label>
          <textarea id="r_writingStyle" rows="2">${esc(r.writingStyle)}</textarea>
        </div>
        <div class="row">
          <div class="field">
            <label>最少字</label>
            <input type="text" id="r_wordCountMin" value="${esc(r.wordCountMin)}">
          </div>
          <div class="field">
            <label>最多字</label>
            <input type="text" id="r_wordCountMax" value="${esc(r.wordCountMax)}">
          </div>
        </div>
        <div class="field">
          <label>配图思路</label>
          <textarea id="r_imageSuggestions" rows="3">${esc(r.imageSuggestions)}</textarea>
        </div>
        <div class="field">
          <label>标签</label>
          <textarea id="r_tagRule" rows="3">${esc(r.tagRule)}</textarea>
        </div>
        <div class="field">
          <label>禁止</label>
          <textarea id="r_prohibitions" rows="3">${esc(r.prohibitions)}</textarea>
        </div>
        <div class="field">
          <label>素材怎么用</label>
          <textarea id="r_materialConstraint" rows="3">${esc(r.materialConstraint)}</textarea>
        </div>
      </section>
    </div>
  `;
}

function collectRules() {
  const rules = { ...(state.rules || {}) };
  RULE_FIELDS.forEach((f) => {
    const el = document.getElementById('r_' + f);
    if (el) rules[f] = el.value;
  });
  return rules;
}

function watchRules() {
  document.querySelectorAll('#stage input, #stage textarea').forEach((el) => {
    el.addEventListener('input', onRulesInput);
  });
}

function onRulesInput() {
  rulesDirty = true;
  paintSavebar();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveRules(false), 900);
}

async function saveRules(manual) {
  if (page !== 'rules') return;
  const rules = collectRules();
  if (!rules.accountPosition || !rules.targetAudience || !rules.persona) {
    if (manual) toast('定位、人群、人设都要有', true);
    return;
  }
  try {
    const res = await post('/api/rules', rules);
    state.rules = res.rules;
    rulesDirty = false;
    lastSavedAt = res.rules.updatedAt || new Date().toISOString();
    paintSavebar();
    if (manual) toast('已保存');
  } catch (e) {
    toast(e.message, true);
  }
}

async function copyRulesPrompt() {
  if (rulesDirty) await saveRules(false);
  try {
    const data = await api('/api/rules/prompt');
    copy(data.prompt);
    toast('规则 Prompt 已复制');
  } catch (e) {
    toast(e.message, true);
  }
}

async function resetRules() {
  if (!confirm('恢复成 CPLUS 默认规则？')) return;
  try {
    const res = await post('/api/rules/reset', {});
    state.rules = res.rules;
    rulesDirty = false;
    lastSavedAt = res.rules.updatedAt || new Date().toISOString();
    draw();
    toast('已恢复默认');
  } catch (e) {
    toast(e.message, true);
  }
}

function viewMaterials() {
  const items = state.materials;
  return `
    <h1>素材</h1>
    <p class="lead">只留标题、摘要、核心观点。每条都会记下添加时间。</p>
    <div class="actions" style="margin-bottom:20px">
      <button class="btn" onclick="openMaterial()">添加一篇</button>
    </div>
    ${items.length === 0 ? `
      <div class="empty">还没有素材。从最近一篇公众号开始即可。</div>
    ` : `
      <div class="list">
        ${items.map((m) => `
          <div class="item">
            <div>
              <h3>${esc(m.title)}</h3>
              ${m.summary ? `<p>${esc(m.summary)}</p>` : ''}
              <div class="meta">${whenFull(m.createdAt) || whenFull(m.updatedAt) || '时间未记录'}</div>
            </div>
            <div class="actions">
              <button class="btn ghost small" onclick="exportMaterialPdf('${m.id}')">PDF</button>
              <button class="btn ghost small" onclick="openMaterial('${m.id}')">改</button>
              <button class="btn quiet small" onclick="removeMaterial('${m.id}')">删</button>
            </div>
          </div>
        `).join('')}
      </div>
    `}
  `;
}

function openMaterial(id) {
  const m = id ? state.materials.find((x) => x.id === id) : null;
  document.getElementById('sheet').classList.remove('hidden');
  document.getElementById('sheet').innerHTML = `
    <div class="sheet-card" onclick="event.stopPropagation()">
      <h2>${m ? '改素材' : '添加一篇'}</h2>
      <div class="field">
        <label>标题</label>
        <input type="text" id="m_title" value="${esc(m?.title || '')}">
      </div>
      <div class="field">
        <label>摘要</label>
        <textarea id="m_summary" rows="2">${esc(m?.summary || '')}</textarea>
      </div>
      <div class="field">
        <label>核心观点</label>
        <textarea id="m_keyPoints" rows="3">${esc(m?.keyPoints || '')}</textarea>
      </div>
      <div class="field">
        <label>关键片段</label>
        <textarea id="m_snippet" rows="4">${esc(m?.snippet || '')}</textarea>
      </div>
      <div class="actions">
        <button class="btn" onclick="saveMaterial('${m?.id || ''}')">${m ? '保存' : '添加'}</button>
        <button class="btn ghost" onclick="closeSheet()">取消</button>
      </div>
    </div>
  `;
  document.getElementById('sheet').onclick = closeSheet;
}

function closeSheet() {
  const el = document.getElementById('sheet');
  el.classList.add('hidden');
  el.innerHTML = '';
  el.onclick = null;
}

async function saveMaterial(id) {
  const data = {
    title: val('m_title'),
    summary: val('m_summary'),
    keyPoints: val('m_keyPoints'),
    snippet: val('m_snippet')
  };
  if (!data.title) { toast('先写标题', true); return; }
  try {
    if (id) await put('/api/materials/' + id, data);
    else await post('/api/materials', data);
    const mats = await api('/api/materials');
    state.materials = mats.items || [];
    closeSheet();
    draw();
    toast(id ? '已更新' : '已添加');
  } catch (e) {
    toast(e.message, true);
  }
}

async function removeMaterial(id) {
  if (!confirm('删除这篇素材？')) return;
  try {
    await del('/api/materials/' + id);
    state.materials = state.materials.filter((m) => m.id !== id);
    draw();
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
}

function setKind(k) {
  promptKind = k;
  lastPrompt = '';
  draw();
}

function viewPrompt() {
  const tabs = [
    ['schedule', '排期'],
    ['posts', '图文'],
    ['iterate', '迭代']
  ];
  return `
    <h1>做 Prompt</h1>
    <p class="lead">选一种，填最少的输入，复制完整 Prompt。结果可以贴回存档。</p>
    <div class="tabs">
      ${tabs.map(([k, label]) => `
        <button type="button" class="${promptKind === k ? 'on' : ''}" onclick="setKind('${k}')">${label}</button>
      `).join('')}
    </div>
    ${promptKind === 'schedule' ? formSchedule() : promptKind === 'posts' ? formPosts() : formIterate()}
    ${lastPrompt ? renderPromptBox() : ''}
  `;
}

function formSchedule() {
  const weeks = state.settings?.planWeeks || 4;
  const n = state.settings?.postsPerWeek || 3;
  if (!state.materials.length) {
    return `<div class="empty">先去「素材」加几篇公众号，再做排期 Prompt。<div class="actions" style="margin-top:16px"><button class="btn ghost" onclick="go('materials')">去添加</button></div></div>`;
  }
  return `
    <div class="row">
      <div class="field narrow">
        <label>周数</label>
        <input type="number" id="s_weeks" value="${weeks}" min="1" max="12">
      </div>
      <div class="field narrow">
        <label>每周篇数</label>
        <input type="number" id="s_ppw" value="${n}" min="1" max="7">
      </div>
    </div>
    <div class="field">
      <label>用哪些素材</label>
      <div class="pick">
        ${state.materials.map((m) => `
          <label class="opt">
            <input type="checkbox" value="${esc(m.id)}" checked>
            <div>${esc(m.title)}<span><br>${esc(whenFull(m.createdAt))}${m.summary ? ' · ' + esc(m.summary) : ''}</span></div>
          </label>
        `).join('')}
      </div>
    </div>
    <div class="actions">
      <button class="btn" onclick="makeSchedule()">生成排期 Prompt</button>
    </div>
  `;
}

function formPosts() {
  const last = state.schedules[state.schedules.length - 1];
  const snippets = state.materials
    .filter((m) => m.snippet)
    .map((m) => `【${m.title}】\n${m.snippet}`)
    .join('\n\n');
  return `
    <div class="field">
      <label>本周排期</label>
      <textarea id="g_schedule" rows="7" placeholder="从存档复制，或直接粘贴其他 AI 给出的排期表">${esc(last?.content || '')}</textarea>
      <p class="hint">${last ? '已带入最近一份存档排期，可改。' : '还没有存档排期，把其他 AI 的表贴这里。'}</p>
    </div>
    <div class="field">
      <label>对应片段</label>
      <textarea id="g_snips" rows="6" placeholder="每篇只用到的关键段落，不要全文">${esc(snippets)}</textarea>
    </div>
    <div class="actions">
      <button class="btn" onclick="makePosts()">生成图文 Prompt</button>
    </div>
  `;
}

function formIterate() {
  return `
    <div class="field">
      <label>这批笔记怎么样</label>
      <textarea id="f_fb" rows="4" placeholder="哪几篇好，哪几篇差，现象即可"></textarea>
    </div>
    <div class="row">
      <div class="field">
        <label>较好的选题</label>
        <input type="text" id="f_good">
      </div>
      <div class="field">
        <label>较差的选题</label>
        <input type="text" id="f_bad">
      </div>
    </div>
    <div class="actions">
      <button class="btn" onclick="makeIterate()">生成迭代 Prompt</button>
    </div>
  `;
}

function renderPromptBox() {
  return `
    <section class="prompt">
      <div class="prompt-head">
        <h2>Prompt</h2>
        <button class="btn ghost small" onclick="copyLast()">复制</button>
      </div>
      <pre id="promptText">${esc(lastPrompt)}</pre>
      <div style="padding-top:20px">
        <label>把其他 AI 的结果贴回来</label>
        <textarea id="pasteBack" rows="6" placeholder="整段贴进来，存进「存档」"></textarea>
        <div class="actions">
          <button class="btn ghost" onclick="savePaste()">${promptKind === 'iterate' ? '保存迭代' : promptKind === 'posts' ? '保存稿件' : '保存排期'}</button>
        </div>
      </div>
    </section>
  `;
}

function copyLast() {
  if (!lastPrompt) return;
  copy(lastPrompt);
  toast('已复制');
}

async function makeSchedule() {
  const ids = [...document.querySelectorAll('.pick input:checked')].map((i) => i.value);
  const materials = state.materials.filter((m) => ids.includes(m.id));
  if (!materials.length) { toast('至少选一篇素材', true); return; }
  busy(true);
  try {
    const res = await post('/api/prompt/schedule', {
      materials,
      weeks: num('s_weeks', 4),
      postsPerWeek: num('s_ppw', 3)
    });
    lastPrompt = res.prompt;
    draw();
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy(false);
  }
}

async function makePosts() {
  const schedule = val('g_schedule');
  if (!schedule) { toast('先放排期', true); return; }
  const scheduleItems = schedule.split('\n').filter((l) => l.trim()).map((line) => {
    const parts = line.split(/[|｜]/).map((p) => p.trim()).filter(Boolean);
    return { title: parts[0] || line, summary: parts.slice(1).join(' '), materialRef: '' };
  });
  busy(true);
  try {
    const res = await post('/api/prompt/posts', {
      scheduleText: schedule,
      scheduleItems,
      materialSnippets: val('g_snips')
    });
    lastPrompt = res.prompt;
    draw();
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy(false);
  }
}

async function makeIterate() {
  const feedback = val('f_fb');
  if (!feedback) { toast('先写反馈', true); return; }
  busy(true);
  try {
    const res = await post('/api/prompt/iterate', {
      feedback,
      goodPosts: val('f_good'),
      badPosts: val('f_bad')
    });
    lastPrompt = res.prompt;
    draw();
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy(false);
  }
}

async function savePaste() {
  const content = val('pasteBack');
  if (!content) { toast('先把结果贴进来', true); return; }
  try {
    if (promptKind === 'schedule') {
      await post('/api/schedules', { name: '排期 ' + whenFull(new Date().toISOString()), content });
      const sch = await api('/api/schedules');
      state.schedules = sch.items || [];
      toast('排期已存');
    } else if (promptKind === 'posts') {
      const parts = content.split(/—{2,}|-{4,}/).map((p) => p.trim()).filter((p) => p.length > 10);
      const posts = parts.length > 1 ? parts : [content];
      for (const p of posts) {
        const m = p.match(/【封面标题】[：:](.+)/);
        await post('/api/posts', { title: m ? m[1].trim() : '稿件', content: p });
      }
      const data = await api('/api/posts');
      state.posts = data.items || [];
      toast(`已存 ${posts.length} 篇`);
    } else {
      const iterations = state.rules.iterations || [];
      iterations.push({ date: new Date().toISOString(), summary: content.slice(0, 80), content });
      const res = await post('/api/rules', { ...state.rules, iterations });
      state.rules = res.rules;
      toast('迭代已存');
    }
    document.getElementById('pasteBack').value = '';
  } catch (e) {
    toast(e.message, true);
  }
}

function viewArchive() {
  const s = state.settings || {};
  return `
    <h1>存档</h1>
    <p class="lead">排期、稿件和规则都可以导出成 PDF，长期留底。</p>

    <section class="archive-block">
      <h2>排期</h2>
      ${state.schedules.length === 0 ? '<div class="empty">还没有排期。</div>' : `
        <div class="list">
          ${state.schedules.map((x) => `
            <div class="item">
              <div>
                <h3>${esc(x.name || '排期')}</h3>
                <p>${esc((x.content || '').slice(0, 120))}${(x.content || '').length > 120 ? '…' : ''}</p>
                <div class="meta">${whenFull(x.createdAt)}</div>
              </div>
              <div class="actions">
                <button class="btn ghost small" onclick="openText(${jsStr(x.name || '排期')}, ${jsStr(x.content)})">看</button>
                <button class="btn quiet small" onclick="removeSchedule('${x.id}')">删</button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </section>

    <section class="archive-block">
      <h2>稿件</h2>
      ${state.posts.length === 0 ? '<div class="empty">还没有稿件。</div>' : `
        <div class="list">
          ${state.posts.map((x) => `
            <div class="item">
              <div>
                <h3>${esc(x.title || '稿件')}</h3>
                <p>${esc((x.content || '').slice(0, 120))}${(x.content || '').length > 120 ? '…' : ''}</p>
                <div class="meta">${whenFull(x.createdAt)}</div>
              </div>
              <div class="actions">
                <button class="btn ghost small" onclick="openText(${jsStr(x.title || '稿件')}, ${jsStr(x.content)})">看</button>
                <button class="btn quiet small" onclick="removePost('${x.id}')">删</button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </section>

    <section class="archive-block">
      <h2>参数</h2>
      <div class="row">
        <div class="field narrow">
          <label>默认周数</label>
          <input type="number" id="set_weeks" value="${s.planWeeks || 4}" min="1" max="12">
        </div>
        <div class="field narrow">
          <label>每周篇数</label>
          <input type="number" id="set_ppw" value="${s.postsPerWeek || 3}" min="1" max="7">
        </div>
      </div>
      <div class="actions">
        <button class="btn ghost" onclick="saveSettings()">保存参数</button>
        <button class="btn" onclick="exportPdf()">导出 PDF</button>
      </div>
    </section>
  `;
}

function jsStr(s) {
  return JSON.stringify(s || '').replace(/</g, '\\u003c');
}

function openText(title, content) {
  document.getElementById('sheet').classList.remove('hidden');
  document.getElementById('sheet').innerHTML = `
    <div class="sheet-card" onclick="event.stopPropagation()">
      <h2>${esc(title)}</h2>
      <pre style="white-space:pre-wrap;font-family:var(--sans);font-size:14px;line-height:1.7">${esc(content)}</pre>
      <div class="actions" style="margin-top:18px">
        <button class="btn" onclick='copy(${jsStr(content)}); toast("已复制")'>复制</button>
        <button class="btn ghost" onclick="closeSheet()">关闭</button>
      </div>
    </div>
  `;
  document.getElementById('sheet').onclick = closeSheet;
}

async function removeSchedule(id) {
  if (!confirm('删除这份排期？')) return;
  try {
    await del('/api/schedules/' + id);
    state.schedules = state.schedules.filter((x) => x.id !== id);
    draw();
  } catch (e) {
    toast(e.message, true);
  }
}

async function removePost(id) {
  if (!confirm('删除这篇稿件？')) return;
  try {
    await del('/api/posts/' + id);
    state.posts = state.posts.filter((x) => x.id !== id);
    draw();
  } catch (e) {
    toast(e.message, true);
  }
}

async function saveSettings() {
  try {
    const res = await post('/api/settings', {
      planWeeks: num('set_weeks', 4),
      postsPerWeek: num('set_ppw', 3)
    });
    state.settings = res.settings;
    toast('参数已保存');
  } catch (e) {
    toast(e.message, true);
  }
}

function pdfSection(title, inner) {
  return `<h2>${esc(title)}</h2>${inner}`;
}

function wrapPdf(title, bodyHtml) {
  const now = whenFull(new Date().toISOString());
  return `
    <div class="pdf-sheet" id="pdfSheet">
      <div class="pdf-head">
        <img src="${location.origin}/img/cplus-logo.png" alt="CPLUS">
        <div class="ttl">
          <h1>${esc(title)}</h1>
          <p>CPLUS GROUP LIMITED (HK) · 导出时间 ${esc(now)}</p>
        </div>
      </div>
      ${bodyHtml}
    </div>
  `;
}

function safeName(s) {
  return String(s || 'export').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
}

function waitImages(root) {
  return Promise.all([...root.querySelectorAll('img')].map((img) => {
    if (img.complete) return Promise.resolve();
    return new Promise((resolve) => {
      img.onload = img.onerror = () => resolve();
    });
  }));
}

async function downloadPdf(html, filename) {
  const sx = window.scrollX;
  const sy = window.scrollY;
  window.scrollTo(0, 0);
  const veil = document.getElementById('veil');
  const veilWasOn = veil && !veil.classList.contains('hidden');
  if (veil) veil.classList.add('hidden');

  const stage = document.createElement('div');
  stage.style.cssText = 'position:fixed;left:0;top:0;width:794px;background:#fff;z-index:2147483646;';
  stage.innerHTML = html;
  document.body.appendChild(stage);
  const sheet = stage.querySelector('#pdfSheet');
  await waitImages(sheet);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    const h2c = window.html2canvas;
    const JsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!h2c || !JsPDF) {
      window.print();
      toast('PDF 库未加载，已打开打印，请选择存储为 PDF');
      return;
    }
    const canvas = await h2c(sheet, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      logging: false,
      scrollX: 0,
      scrollY: -window.scrollY,
      windowWidth: 794,
      windowHeight: sheet.scrollHeight
    });
    const img = canvas.toDataURL('image/jpeg', 0.98);
    const pdf = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW = 210;
    const pageH = 297;
    const imgW = pageW;
    const imgH = (canvas.height * imgW) / canvas.width;
    let remain = imgH;
    let offset = 0;
    pdf.addImage(img, 'JPEG', 0, offset, imgW, imgH);
    remain -= pageH;
    while (remain > 1) {
      offset -= pageH;
      pdf.addPage();
      pdf.addImage(img, 'JPEG', 0, offset, imgW, imgH);
      remain -= pageH;
    }
    pdf.save(filename);
    toast('PDF 已下载');
  } catch (e) {
    console.error(e);
    toast(e.message || '导出失败', true);
  } finally {
    stage.remove();
    window.scrollTo(sx, sy);
    if (veilWasOn) veil.classList.remove('hidden');
    else if (veil) veil.classList.add('hidden');
    busy(false);
  }
}

function ruleRowsHtml(r) {
  return [
    ['定位', r.accountPosition],
    ['人群', r.targetAudience],
    ['人设', r.persona],
    ['封面标题', r.coverTitleStyle],
    ['标题字数', r.coverTitleMaxLength],
    ['正文结构', r.bodyStructure],
    ['行文', r.writingStyle],
    ['字数', `${r.wordCountMin || ''}-${r.wordCountMax || ''}`],
    ['配图思路', r.imageSuggestions],
    ['标签', r.tagRule],
    ['禁止', r.prohibitions],
    ['素材怎么用', r.materialConstraint]
  ].map(([k, v]) => `<p><strong>${esc(k)}：</strong>${esc(v || '—')}</p>`).join('');
}

async function exportRulesPdf() {
  if (rulesDirty) await saveRules(false);
  let prompt = '';
  try {
    prompt = (await api('/api/rules/prompt')).prompt || '';
  } catch (e) {
    toast(e.message, true);
    return;
  }
  const r = state.rules || {};
  const html = wrapPdf('账号规则 Prompt', `
    ${pdfSection('主号设定与格式细则', ruleRowsHtml(r))}
    ${pdfSection('生成的规则 Prompt', `<p>${esc(prompt)}</p>`)}
  `);
  await downloadPdf(html, `CPLUS-规则Prompt-${new Date().toISOString().slice(0, 10)}.pdf`);
}

async function exportMaterialPdf(id) {
  const m = state.materials.find((x) => x.id === id);
  if (!m) { toast('找不到这条素材', true); return; }
  const html = wrapPdf('公众号素材', `
    <h2>${esc(m.title)}</h2>
    <p class="pdf-time">${esc(whenFull(m.createdAt))}</p>
    ${pdfSection('摘要', `<p>${esc(m.summary || '—')}</p>`)}
    ${pdfSection('核心观点', `<p>${esc(m.keyPoints || '—')}</p>`)}
    ${pdfSection('关键片段', `<p>${esc(m.snippet || '—')}</p>`)}
  `);
  await downloadPdf(html, `CPLUS-素材-${safeName(m.title)}.pdf`);
}

async function exportPdf() {
  const data = await api('/api/export');
  const r = data.rules || {};
  const mats = (data.materials && data.materials.items) || [];
  const sch = (data.schedules && data.schedules.items) || [];
  const posts = (data.posts && data.posts.items) || [];
  const matHtml = mats.length ? mats.map((m) => `
    <div class="pdf-block">
      <h3>${esc(m.title)}</h3>
      <p class="pdf-time">${esc(whenFull(m.createdAt))}</p>
      <p>${esc(m.summary || '')}</p>
      <p>${esc(m.keyPoints || '')}</p>
    </div>
  `).join('') : '<p>暂无素材</p>';
  const schHtml = sch.length ? sch.map((x) => `
    <div class="pdf-block">
      <h3>${esc(x.name || '排期')}</h3>
      <p class="pdf-time">${esc(whenFull(x.createdAt))}</p>
      <p>${esc(x.content || '')}</p>
    </div>
  `).join('') : '<p>暂无排期</p>';
  const postHtml = posts.length ? posts.map((x) => `
    <div class="pdf-block">
      <h3>${esc(x.title || '稿件')}</h3>
      <p class="pdf-time">${esc(whenFull(x.createdAt))}</p>
      <p>${esc(x.content || '')}</p>
    </div>
  `).join('') : '<p>暂无稿件</p>';
  const html = wrapPdf('CPLUS 小红书内容存档', `
    ${pdfSection('账号规则', ruleRowsHtml(r))}
    ${pdfSection('素材', matHtml)}
    ${pdfSection('排期', schHtml)}
    ${pdfSection('稿件', postHtml)}
  `);
  await downloadPdf(html, 'CPLUS-小红书存档-' + new Date().toISOString().slice(0, 10) + '.pdf');
}

window.addEventListener('beforeunload', (e) => {
  if (!rulesDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

boot();
