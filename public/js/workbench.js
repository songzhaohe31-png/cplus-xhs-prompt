state.agent = state.agent || null;
state.knowledge = state.knowledge || [];
state.contents = state.contents || [];
state.metrics = state.metrics || [];
state.suggestions = state.suggestions || [];
state.me = state.me || { mode: 'public', serviceAvailable: true };
state.chatLog = state.chatLog || [];
state.calCursor = state.calCursor || new Date();
state.calMode = state.calMode || 'month';
let chatBusy = false;
let chatAbort = null;
state.lastStructured = state.lastStructured || null;
state.authed = true;
let promptKind = 'schedule';
let lastPrompt = '';
const draft = {
  title: '', subtitle: '', body: '', cta: '', hashtags: '', posterNotes: '', pendingConfirm: '',
  topic: '', audience: '', purpose: '', riskNote: '',
  businessCategory: '', publishAt: '', owner: '', sourcesText: '', id: ''
};

async function exportWorkspace() {
  try {
    const data = await api('/api/workspace/export');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = 'cplus-workspace.json';
    a.click();
  } catch (e) { toast('导出失败，请稍后再试。', true); }
}

async function importWorkspace(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await post('/api/workspace/import', data);
    toast('工作区已导入');
    location.reload();
  } catch (e) { toast('导入失败，请检查文件。', true); }
}

function toggleSide() {
  document.getElementById('side').classList.toggle('open');
}

function isAdmin() { return false; }
function isReviewer() { return true; }

function paintChrome() {
  const foot = document.getElementById('sideFoot');
  if (foot) {
    foot.innerHTML = `<div class="actions" style="flex-direction:column;align-items:stretch">
      <button class="btn ghost small" onclick="exportWorkspace()">导出工作区</button>
      <label class="btn quiet small" style="text-align:center">导入工作区<input type="file" accept="application/json" hidden onchange="importWorkspace(event)"></label>
    </div>`;
  }
  const top = document.getElementById('topActions');
  if (top) top.innerHTML = '';
}

async function bootWorkbench() {
  try {
    const [me, knowledge, contents, metrics] = await Promise.all([
      api('/api/me'),
      api('/api/knowledge'),
      api('/api/contents'),
      api('/api/metrics')
    ]);
    state.me = me;
    state.authed = true;
    state.agent = {};
    state.knowledge = knowledge.items || [];
    state.contents = contents.items || [];
    state.metrics = metrics.items || [];
    state.suggestions = suggestions.items || [];
    paintChrome();
  } catch (e) {
    console.warn(e);
    state.authed = true;
  }
}

const _draw = draw;
draw = function () {
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  const side = document.getElementById('side');
  if (side && window.innerWidth < 860) side.classList.remove('open');
  paintChrome();
  const root = document.getElementById('stage');
  const extra = {
    chat: viewChat,
    knowledge: viewKnowledge,
    calendar: viewCalendar,
    generate: viewGenerate,
    review: viewReview,
    library: viewLibrary,
    history: viewHistory
  };
  if (extra[page]) {
    showSavebar(false);
    root.innerHTML = extra[page]();
    if (page === 'feed') bindDrop();
    if (page === 'generate') paintPoster();
    return;
  }
  _draw();
};

const _go = go;
go = async function (name) {
  const allowed = ['chat', 'calendar', 'review', 'knowledge', 'library', 'history', 'generate'];
  if (!allowed.includes(name)) name = 'chat';
  await _go(name);
};

const _boot = boot;
boot = async function () {
  await bootWorkbench();
  await _boot();
  const allowed = ['chat', 'calendar', 'review', 'knowledge', 'library', 'history', 'generate'];
  if (!allowed.includes(page)) page = 'chat';
  draw();
};

function viewChat() {
  const ai = state.me.ai || {};
  const log = state.chatLog.map((m) => `
    <div class="bubble ${m.role}">
      <div class="meta">${m.role === 'user' ? '你' : 'CPLUS 助理'} · ${esc(m.time || '')}</div>
      ${m.html || `<div style="white-space:pre-wrap">${esc(m.text || '')}</div>`}
      ${m.dupHint ? `<div class="warn">${esc(m.dupHint)}</div>` : ''}
      ${m.sources && m.sources.length ? `<div class="source-list">来源：${m.sources.map((s) => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)).join(' · ')}</div>` : ''}
    </div>
  `).join('');
  return `
    <h1>CPLUS新媒体运营助手</h1>
    <p class="lead">输入一句话，快速生成内容排期、小红书文案和海报方案。</p>
    ${state.me && state.me.serviceAvailable === false ? `<div class="warn">AI服务暂时不可用，请稍后再试。</div>` : ''}
    <div class="quick">
      ${[
        ['生成未来4周的小红书内容排期，每周3篇，重点推广香港公司注册、银行开户和MSO牌照。', '生成未来4周排期'],
        ['生成本周3篇香港MSO内容。', '生成本周3篇内容'],
        ['写一篇申请香港MSO牌照需要怎样安排人员的小红书。', '生成单篇内容'],
        ['根据这篇文章生成5个选题：', '拆解公众号文章'],
        ['检查这篇内容是否存在合规问题：', '检查内容合规'],
        ['根据最近发布数据优化下个月选题。', '根据数据复盘']
      ].map(([q, lab]) => `<button class="chip" onclick="fillChat(${JSON.stringify(q)})">${lab}</button>`).join('')}
    </div>
    <section class="hero-chat">
      <div class="chat-log">${log || '<div class="hint">从上面选一条，或自己说一句。</div>'}</div>
      <div id="chatProgress" class="progress hidden">准备中…</div>
      <div class="field">
        <textarea id="chatMsg" rows="3" placeholder="例如：生成未来4周排期，每周3篇。"></textarea>
      </div>
      <div class="actions">
        <button class="btn" id="chatSend" onclick="sendChat()">发送</button>
        <button class="btn quiet" id="chatCancel" onclick="cancelChat()">取消</button>
      </div>
    </section>
  `;
}

function fillChat(q) {
  const el = document.getElementById('chatMsg');
  if (el) el.value = q;
}

function renderStructured(structured) {
  if (!structured || !structured.items || !structured.items.length) return '';
  const items = structured.items;
  const cards = items.map((it, i) => `
    <article class="item" style="display:block;margin-top:8px">
      <h3>${esc(it.title || it.topic || ('条目 ' + (i + 1)))}</h3>
      <p>${esc(it.audience || '')} ${it.purpose ? ' · ' + esc(it.purpose) : ''} ${it.pain ? ' · ' + esc(it.pain) : ''}</p>
      ${it.body ? `<p>${esc(it.body.slice(0, 180))}${it.body.length > 180 ? '…' : ''}</p>` : ''}
      <div class="meta">${esc(it.week || '')} ${esc(it.publishAt || '')} · Draft</div>
    </article>
  `).join('');
  const isSchedule = structured.type === 'schedule';
  return `
    <div class="actions" style="margin:10px 0">
      <button class="btn" onclick="saveStructuredToCalendar()">保存至日历</button>
      ${isSchedule ? `<button class="btn ghost" onclick="fillChat('根据刚才的排期，生成全部文案'); sendChat()">生成全部文案</button>
      <button class="btn ghost" onclick="fillChat('根据刚才的排期，生成本周文案'); sendChat()">生成本周文案</button>` : ''}
      <button class="btn ghost" onclick="exportStructuredCsv()">导出 Excel</button>
      <button class="btn ghost" onclick="exportStructuredDoc()">导出 Word</button>
    </div>
    ${cards}
  `;
}

async function sendChat() {
  if (chatBusy) return;
  const message = val('chatMsg');
  if (!message) { toast('先写一句指令', true); return; }
  if (state.me && state.me.serviceAvailable === false) {
    toast('AI服务暂时不可用，请稍后再试。', true);
    return;
  }
  chatBusy = true;
  chatAbort = new AbortController();
  const btn = document.getElementById('chatSend');
  if (btn) btn.disabled = true;
  state.chatLog.push({ role: 'user', text: message, time: whenFull(new Date().toISOString()) });
  draw();
  const p2 = document.getElementById('chatProgress');
  if (p2) {
    p2.classList.remove('hidden');
    p2.textContent = '检索规则、知识库与官方资料…';
  }
  try {
    if (p2) p2.textContent = '模型生成中，请稍候…';
    const res = await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ message }), signal: chatAbort.signal });
    if (p2) p2.textContent = '已完成';
    state.lastStructured = res.structured;
    lastResult = res.reply;
    lastCommand = message;
    state.chatLog.push({
      role: 'bot',
      text: res.reply,
      html: renderStructured(res.structured) + `<div style="white-space:pre-wrap;margin-top:10px">${esc(res.reply || '')}</div>`,
      time: whenFull(new Date().toISOString()),
      sources: res.sources,
      dupHint: res.dupHint,
      official: res.official
    });
    toast('已生成 ' + ((res.structured && res.structured.items && res.structured.items.length) || '') + ' 条');
  } catch (e) {
    if (e.name === 'AbortError') toast('已取消');
    else {
      toast('AI服务暂时不可用，请稍后再试。', true);
      state.chatLog.push({ role: 'bot', text: 'AI服务暂时不可用，请稍后再试。', time: whenFull(new Date().toISOString()) });
    }
  } finally {
    chatBusy = false;
    chatAbort = null;
    draw();
    const el = document.getElementById('chatMsg');
    if (el) el.value = '';
  }
}

function cancelChat() {
  if (chatAbort) chatAbort.abort();
}

async function saveStructuredToCalendar() {
  const items = state.lastStructured && state.lastStructured.items;
  if (!items || !items.length) { toast('没有可保存的结构化结果', true); return; }
  try {
    const res = await post('/api/contents/batch', { items });
    state.contents = res.all || state.contents.concat(res.items || []);
    if (res.warnings && res.warnings.length) toast('已保存，但有 ' + res.warnings.length + ' 条接近历史内容');
    else toast('已写入日历，状态 Draft');
    go('calendar');
  } catch (e) { toast(e.message, true); }
}

function exportStructuredCsv() {
  const items = (state.lastStructured && state.lastStructured.items) || [];
  if (!items.length) { toast('没有可导出的结果', true); return; }
  const header = ['周', '发布日期', '标题', '类型', '目标客户', '痛点', '目的', '转化', '状态'];
  const rows = items.map((it) => [it.week, it.publishAt, it.title, it.type, it.audience, it.pain, it.purpose, it.offer, 'Draft']);
  const csv = [header].concat(rows).map((r) => r.map((c) => '"' + String(c || '').replace(/"/g, '""') + '"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'CPLUS-排期.csv';
  a.click();
}

function exportStructuredDoc() {
  if (!lastResult) { toast('没有可导出的正文', true); return; }
  const html = `<html><head><meta charset="utf-8"></head><body>${esc(lastResult).replace(/\n/g, '<br>')}</body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + html], { type: 'application/msword' }));
  a.download = 'CPLUS-成稿.doc';
  a.click();
}

function saveLastChatToGenerate() {
  const last = [...state.chatLog].reverse().find((m) => m.role === 'bot');
  if (!last) { toast('还没有生成结果', true); return; }
  parseDraftFromText(last.text);
  go('generate');
}

function parseDraftFromText(text) {
  const pick = (label) => {
    const re = new RegExp('【' + label + '】[：:]?\\s*([\\s\\S]*?)(?=【|$)');
    const m = String(text || '').match(re);
    return m ? m[1].trim() : '';
  };
  draft.topic = pick('内容主题') || draft.topic;
  draft.audience = pick('目标客户') || draft.audience;
  draft.purpose = pick('内容目的') || draft.purpose;
  draft.title = pick('封面标题') || draft.title;
  draft.subtitle = pick('封面副标题或3个重点') || pick('副标题/三个重点') || pick('副标题') || draft.subtitle;
  draft.body = pick('小红书正文') || pick('笔记正文') || draft.body;
  draft.cta = pick('CTA') || (state.agent && state.agent.fixedCta) || '';
  draft.hashtags = pick('Hashtag') || (state.agent && state.agent.fixedHashtags) || '';
  draft.posterNotes = pick('海报制作说明') || '';
  draft.pendingConfirm = pick('需要人工确认的资料') || pick('待人工确认事项') || '';
  draft.sourcesText = pick('参考资料及链接') || pick('参考资料') || '';
  draft.riskNote = pick('合规风险提示') || '';
}

function viewAgent() {
  const a = state.agent || {};
  const fields = [
    ['roleName', '角色名称'],
    ['slogan', '品牌主张'],
    ['brandBackground', '品牌背景'],
    ['accountPosition', '账号定位'],
    ['targetAudience', '目标客户'],
    ['serviceScope', '服务范围'],
    ['copyRules', '文案规则'],
    ['imageRules', '图片规则'],
    ['complianceRules', '合规规则'],
    ['bannedWords', '禁用词'],
    ['fixedCta', '固定 CTA'],
    ['fixedHashtags', '固定 Hashtag'],
    ['officialSources', '官方资料来源'],
    ['contentMix', '内容配比']
  ];
  return `
    <h1>Agent 规则库</h1>
    <p class="lead">已内置「CPLUS跨境合规新媒体运营Agent」完整剧本。下面这些是管理员可改的覆盖项。普通用户对话时自动加载，不必重写长 Prompt。</p>
    <section class="panel">
      ${fields.map(([k, lab]) => `
        <div class="field">
          <label>${lab}</label>
          <textarea id="ag_${k}" rows="${k === 'bannedWords' || k === 'fixedHashtags' ? 2 : 4}">${esc(a[k] || '')}</textarea>
        </div>
      `).join('')}
      <div class="actions">
        <button class="btn" onclick="saveAgent()">保存规则</button>
      </div>
    </section>
  `;
}

async function saveAgent() {
  if (!isAdmin()) { toast('仅管理员可改系统规则', true); return; }
  const body = {};
  ['roleName', 'slogan', 'brandBackground', 'accountPosition', 'targetAudience', 'serviceScope', 'copyRules', 'imageRules', 'complianceRules', 'bannedWords', 'fixedCta', 'fixedHashtags', 'officialSources', 'contentMix'].forEach((k) => {
    body[k] = val('ag_' + k);
  });
  try {
    const res = await post('/api/agent', body);
    state.agent = res.agent;
    toast('Agent 规则已保存');
  } catch (e) { toast(e.message, true); }
}

function viewKnowledge() {
  return `
    <h1>资料库</h1>
    <p class="lead">上传文件或粘贴文章，生成内容时会参考这些资料。</p>
    <div class="kb-grid">
      <section class="panel">
        <h2>上传资料</h2>
        <div class="field"><label>文件名称</label><input id="k_name" type="text"></div>
        <div class="row">
          <div class="field"><label>资料类别</label><input id="k_category" type="text" placeholder="画册 / 合规 / 公众号"></div>
          <div class="field"><label>业务类别</label><input id="k_business" type="text" placeholder="年审 / 开户 / 牌照"></div>
        </div>
        <div class="row">
          <div class="field"><label>司法管辖区</label><input id="k_jurisdiction" type="text" value="香港"></div>
          <div class="field"><label>有效日期</label><input id="k_expires" type="date"></div>
        </div>
        <div class="field"><label>需要定期更新</label>
          <div class="chips"><button class="chip" id="k_upd" onclick="this.classList.toggle('on')">需要</button></div>
        </div>
        <div class="field"><label>文件（PDF / Word / Excel / TXT）</label><input id="k_file" type="file"></div>
        <div class="field"><label>或粘贴文章 / 网址说明</label><textarea id="k_text" rows="4"></textarea></div>
        <div class="actions"><button class="btn" onclick="uploadKnowledge()">保存到知识库</button></div>
      </section>
      <section>
        ${(state.knowledge || []).slice().reverse().map((k) => `
          <div class="item">
            <div>
              <h3>${esc(k.name)}</h3>
              <p>${esc(k.category || '')} · ${esc(k.business || '')} · ${esc(k.jurisdiction || '')}</p>
              <div class="meta">${esc(whenFull(k.uploadedAt))}${k.needsUpdate ? ' · 需更新' : ''}${k.expiresAt ? ' · 有效至 ' + esc(k.expiresAt) : ''}</div>
            </div>
            <div class="actions">
              ${k.filename ? `<a class="btn ghost small" href="/api/knowledge/file/${k.id}">下载</a>` : ''}
              ${isAdmin() ? `<button class="btn quiet small" onclick="delKnowledge('${k.id}')">删</button>` : ''}
            </div>
          </div>
        `).join('') || '<div class="empty">还没有资料。</div>'}
      </section>
    </div>
  `;
}

async function uploadKnowledge() {
  const file = document.getElementById('k_file') && document.getElementById('k_file').files[0];
  const payload = {
    name: val('k_name') || (file && file.name) || '未命名资料',
    category: val('k_category'),
    business: val('k_business'),
    jurisdiction: val('k_jurisdiction') || '香港',
    expiresAt: val('k_expires'),
    needsUpdate: !!(document.getElementById('k_upd') && document.getElementById('k_upd').classList.contains('on')),
    text: val('k_text'),
    filename: file ? file.name : '',
    mime: file ? file.type : 'text/plain'
  };
  if (file) payload.dataUrl = await readFileData(file);
  if (!payload.dataUrl && !payload.text) { toast('请上传文件或粘贴文本', true); return; }
  busy(true, '在解析资料');
  try {
    const res = await post('/api/knowledge', payload);
    state.knowledge = res.items || [];
    draw();
    toast('已入知识库');
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

function readFileData(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function delKnowledge(id) {
  if (!confirm('删除这份资料？')) return;
  try {
    const res = await del('/api/knowledge/' + id);
    state.knowledge = res.items || [];
    draw();
  } catch (e) { toast(e.message, true); }
}

function viewGenerate() {
  const a = state.agent || {};
  return `
    <h1>内容生成器</h1>
    <p class="lead">每篇绑定文案和海报。可改写字段、导出、写入日历。须人工批准后才能排期发布。</p>
    <div class="gen-grid">
      <section class="panel">
        <div class="field"><label>内容主题</label><input id="d_topic" value="${esc(draft.topic)}"></div>
        <div class="row">
          <div class="field"><label>目标客户</label><input id="d_audience" value="${esc(draft.audience)}"></div>
          <div class="field"><label>内容目的</label><input id="d_purpose" value="${esc(draft.purpose)}" placeholder="品牌曝光／知识教育／获取咨询／服务转化"></div>
        </div>
        <div class="field"><label>封面标题</label><input id="d_title" value="${esc(draft.title)}"></div>
        <div class="field"><label>封面副标题或3个重点</label><textarea id="d_subtitle" rows="3">${esc(draft.subtitle)}</textarea></div>
        <div class="field"><label>小红书正文</label><textarea id="d_body" rows="8">${esc(draft.body)}</textarea></div>
        <div class="actions">
          <button class="btn ghost small" onclick="rewriteField('title','重新生成标题')">重写标题</button>
          <button class="btn ghost small" onclick="rewriteField('body','重新生成正文')">重写正文</button>
          <button class="btn ghost small" onclick="rewriteField('body','缩短正文，保留要点')">缩短</button>
          <button class="btn ghost small" onclick="rewriteField('body','提高专业程度，仍保持口语')">更专业</button>
          <button class="btn ghost small" onclick="rewriteField('body','语气更像同事提醒，少书面')">改语气</button>
        </div>
        <div class="field"><label>CTA</label><input id="d_cta" value="${esc(draft.cta || a.fixedCta || '')}"></div>
        <div class="field"><label>Hashtag</label><input id="d_hashtags" value="${esc(draft.hashtags || a.fixedHashtags || '')}"></div>
        <div class="field"><label>海报制作说明</label><textarea id="d_posterNotes" rows="3">${esc(draft.posterNotes)}</textarea></div>
        <div class="field"><label>参考资料</label><textarea id="d_sources" rows="2">${esc(draft.sourcesText)}</textarea></div>
        <div class="field"><label>需要人工确认的资料</label><textarea id="d_pending" rows="2">${esc(draft.pendingConfirm)}</textarea></div>
        <div class="field"><label>合规风险提示</label><textarea id="d_risk" rows="2">${esc(draft.riskNote)}</textarea></div>
        <p class="hint">保存后状态为 Draft。AI 不能自行改为 Approved 或 Published。</p>
        <div class="row">
          <div class="field"><label>业务类别</label><input id="d_biz" value="${esc(draft.businessCategory)}"></div>
          <div class="field"><label>计划发布</label><input id="d_pub" type="datetime-local" value="${esc(draft.publishAt)}"></div>
        </div>
        <div class="actions">
          <button class="btn" onclick="saveDraftToCalendar()">保存至内容日历</button>
          <button class="btn ghost" onclick="copyDraft()">复制内容</button>
          <button class="btn ghost" onclick="exportDraftPdf()">导出 PDF</button>
          <button class="btn ghost" onclick="exportDraftDoc()">导出 Word</button>
        </div>
      </section>
      <section class="panel">
        <h2>海报 1122 × 1402</h2>
        <div class="field"><label>模板</label>
          <div class="chips">
            <button class="chip on" id="tpl_std" onclick="setTpl('std')">CPLUS 标准</button>
            <button class="chip" id="tpl_biz" onclick="setTpl('biz')">业务分类</button>
          </div>
        </div>
        <div class="field"><label>主色</label><input id="posterColor" type="color" value="#1a4b8c" oninput="paintPoster()"></div>
        <div class="field"><label>上传参考图</label><input id="refImg" type="file" accept="image/*" onchange="loadRefImg(event)"></div>
        <div class="poster-canvas-wrap"><canvas id="poster" width="1122" height="1402"></canvas></div>
        <div class="actions" style="margin-top:10px">
          <button class="btn" onclick="paintPoster()">快速模板</button>
          <button class="btn ghost" onclick="aiPoster()">AI 视觉海报</button>
          <button class="btn ghost" onclick="downloadPoster()">下载 PNG</button>
        </div>
        <p class="hint">快速模板是 Canvas 排版，不是 AI 生图。AI 视觉会先生成无字主视觉，再叠中文标题。</p>
      </section>
    </div>
  `;
}

let posterTpl = 'std';
let refImage = null;
function setTpl(name) {
  posterTpl = name;
  document.querySelectorAll('#tpl_std,#tpl_biz').forEach((b) => b.classList.remove('on'));
  const el = document.getElementById(name === 'biz' ? 'tpl_biz' : 'tpl_std');
  if (el) el.classList.add('on');
  paintPoster();
}
function loadRefImg(ev) {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => { refImage = img; paintPoster(); };
  img.src = URL.createObjectURL(f);
}
function stashDraft() {
  draft.topic = val('d_topic') || draft.topic;
  draft.audience = val('d_audience') || draft.audience;
  draft.purpose = val('d_purpose') || draft.purpose;
  draft.title = val('d_title') || draft.title;
  draft.subtitle = val('d_subtitle') || draft.subtitle;
  draft.body = val('d_body') || draft.body;
  draft.riskNote = val('d_risk') || draft.riskNote;
  draft.cta = val('d_cta') || draft.cta;
  draft.hashtags = val('d_hashtags') || draft.hashtags;
  draft.posterNotes = val('d_posterNotes') || draft.posterNotes;
  draft.sourcesText = val('d_sources') || draft.sourcesText;
  draft.pendingConfirm = val('d_pending') || draft.pendingConfirm;
  draft.businessCategory = val('d_biz') || draft.businessCategory;
  draft.publishAt = val('d_pub') || draft.publishAt;
}
function paintPoster() {
  const canvas = document.getElementById('poster');
  if (!canvas) return;
  stashDraft();
  const g = canvas.getContext('2d');
  const W = 1122, H = 1402;
  const color = (document.getElementById('posterColor') || {}).value || '#1a4b8c';
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = color;
  g.fillRect(0, 0, W, 220);
  g.fillStyle = posterTpl === 'biz' ? '#1aa6a6' : '#c4a35a';
  g.fillRect(0, 220, W, 8);
  g.fillStyle = '#fff';
  g.font = '600 28px "PingFang SC", sans-serif';
  g.fillText('CPLUS GROUP', 56, 64);
  g.font = '18px "PingFang SC", sans-serif';
  g.fillText('Global Growth, Built on Compliance.', 56, 98);
  g.font = '20px "PingFang SC", sans-serif';
  g.fillText(posterTpl === 'biz' ? (draft.businessCategory || '跨境合规') : '全球业务，合规先行', 56, 168);
  if (refImage) {
    g.globalAlpha = 0.16;
    g.drawImage(refImage, 0, 240, W, 420);
    g.globalAlpha = 1;
  }
  g.fillStyle = '#10263f';
  wrapText(g, draft.title || '封面标题', 56, 320, W - 112, 64, '700 52px "PingFang SC", sans-serif');
  const points = (draft.subtitle || '').split(/\n|；|;/).filter(Boolean).slice(0, 3);
  g.font = '32px "PingFang SC", sans-serif';
  g.fillStyle = color;
  points.forEach((p, i) => {
    g.fillRect(56, 620 + i * 110, 10, 64);
    g.fillStyle = '#10263f';
    g.fillText(p.slice(0, 22), 84, 665 + i * 110);
    g.fillStyle = color;
  });
  g.fillStyle = '#5b6b7c';
  g.font = '22px "PingFang SC", sans-serif';
  g.fillText((draft.hashtags || '#香港公司 #企业合规').slice(0, 48), 56, H - 80);
}

function wrapText(g, text, x, y, maxW, lineH, font) {
  g.font = font;
  const chars = String(text || '').split('');
  let line = '', yy = y;
  chars.forEach((ch) => {
    const test = line + ch;
    if (g.measureText(test).width > maxW) {
      g.fillText(line, x, yy);
      line = ch;
      yy += lineH;
    } else line = test;
  });
  g.fillText(line, x, yy);
}

async function aiPoster() {
  stashDraft();
  busy(true, '生成无字主视觉');
  try {
    const points = (draft.subtitle || '').split(/\n|；|;/).filter(Boolean).slice(0, 3);
    const res = await post('/api/posters/ai', { title: draft.title, subtitle: draft.subtitle, points });
    const img = new Image();
    img.onload = () => { refImage = img; paintPoster(); toast('已叠中文标题'); };
    img.src = res.visual;
  } catch (e) {
    toast(e.message + '，已改用快速模板', true);
    paintPoster();
  } finally { busy(false); }
}

function downloadPoster() {
  paintPoster();
  const canvas = document.getElementById('poster');
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = 'CPLUS-' + (draft.title || 'poster').slice(0, 20) + '.png';
  a.click();
}

async function rewriteField(field, instruction) {
  stashDraft();
  const current = field === 'title' ? draft.title : draft.body;
  if (!current) { toast('先有原文再改写', true); return; }
  if (chatBusy) return;
  chatBusy = true;
  busy(true, '改写中');
  try {
    const res = await post('/api/agent/rewrite', { field, instruction, current });
    if (field === 'title') draft.title = (res.reply || '').split('\n')[0].replace(/【封面标题】[：:]?/, '').trim();
    else draft.body = res.reply;
    draw();
    toast(res.mode === 'ai' ? '已改写' : '未接模型，已给出改写任务');
  } catch (e) { toast(e.message, true); }
  finally { chatBusy = false; busy(false); }
}

function copyDraft() {
  stashDraft();
  const text = `【内容主题】${draft.topic}\n【目标客户】${draft.audience}\n【内容目的】${draft.purpose}\n【封面标题】${draft.title}\n【封面副标题或3个重点】${draft.subtitle}\n【小红书正文】\n${draft.body}\n【CTA】${draft.cta}\n【Hashtag】${draft.hashtags}\n【海报制作说明】${draft.posterNotes}\n【参考资料及链接】${draft.sourcesText}\n【需要人工确认的资料】${draft.pendingConfirm}\n【合规风险提示】${draft.riskNote}\n【内容状态】Draft`;
  copy(text);
  toast('已复制');
}

async function saveDraftToCalendar() {
  stashDraft();
  if (!draft.title && !draft.body) { toast('先有标题或正文', true); return; }
  busy(true, '保存并检查重复');
  paintPoster();
  const canvas = document.getElementById('poster');
  try {
    const dup = await post('/api/duplicate-check', { title: draft.title, body: draft.body, topic: draft.title, createdAt: new Date().toISOString() });
    if (dup.duplicates && dup.duplicates.length) {
      const ok = confirm('发现相近内容：' + dup.duplicates.map((d) => d.title).join(' / ') + '\n' + (dup.dupHint || '') + '\n仍要保存？');
      if (!ok) { busy(false); return; }
    }
    const saved = await post('/api/contents', {
      title: draft.title,
      subtitle: draft.subtitle,
      body: draft.body,
      cta: draft.cta,
      hashtags: draft.hashtags,
      posterNotes: draft.posterNotes,
      pendingConfirm: draft.pendingConfirm,
      riskNote: draft.riskNote,
      audience: draft.audience,
      purpose: draft.purpose,
      sources: draft.sourcesText ? [{ name: draft.sourcesText }] : [],
      businessCategory: draft.businessCategory,
      publishAt: draft.publishAt,
      topic: draft.topic || draft.title,
      status: 'Draft'
    });
    if (canvas && saved.item) {
      await post('/api/contents/' + saved.item.id + '/poster', { dataUrl: canvas.toDataURL('image/png') });
    }
    state.contents = saved.items || (await api('/api/contents')).items;
    toast('已保存为 Draft');
    go('calendar');
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

async function exportDraftPdf() {
  stashDraft();
  const html = wrapPdf(draft.title || '成稿', `<p>${esc(draft.subtitle)}</p><p>${esc(draft.body)}</p><p>${esc(draft.cta)}</p><p>${esc(draft.hashtags)}</p>`);
  await downloadPdf(html, 'CPLUS-' + safeName(draft.title) + '.pdf');
}

function exportDraftDoc() {
  stashDraft();
  const html = `<html><head><meta charset="utf-8"></head><body><h1>${esc(draft.title)}</h1><p>${esc(draft.subtitle)}</p><p>${esc(draft.body).replace(/\n/g, '<br>')}</p><p>${esc(draft.cta)}</p><p>${esc(draft.hashtags)}</p></body></html>`;
  const blob = new Blob(['\ufeff' + html], { type: 'application/msword' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'CPLUS-' + safeName(draft.title) + '.doc';
  a.click();
}

function viewCalendar() {
  const d = new Date(state.calCursor);
  const items = state.contents || [];
  const head = `<div class="cal-head">
    <div>
      <h1>内容日历</h1>
      <p class="lead">${d.getFullYear()}年${d.getMonth() + 1}月 · ${state.calMode === 'week' ? '周视图' : '月视图'}</p>
    </div>
    <div class="actions">
      <button class="btn ghost" onclick="shiftCal(-1)">上一段</button>
      <button class="btn ghost" onclick="state.calMode = state.calMode==='week'?'month':'week'; draw()">${state.calMode === 'week' ? '切月' : '切周'}</button>
      <button class="btn ghost" onclick="shiftCal(1)">下一段</button>
    </div>
  </div>`;
  if (state.calMode === 'week') return head + weekView(d, items) + calendarList(items);
  return head + monthView(d, items) + calendarList(items);
}

function shiftCal(dir) {
  const d = new Date(state.calCursor);
  if (state.calMode === 'week') d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir);
  state.calCursor = d;
  draw();
}

function monthView(d, items) {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  let html = '<div class="cal-grid">';
  for (let i = 0; i < 42; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = day.toISOString().slice(0, 10);
    const cellItems = items.filter((it) => (it.publishAt || it.createdAt || '').slice(0, 10) === key);
    html += `<div class="cal-cell"><div class="d">${day.getDate()}</div>${cellItems.map((it) => `<div class="cal-item" onclick="openContent('${it.id}')">${esc((it.title || '无标题').slice(0, 16))}</div>`).join('')}</div>`;
  }
  return html + '</div>';
}

function weekView(d, items) {
  const start = new Date(d);
  start.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  let html = '<div class="cal-grid">';
  for (let i = 0; i < 7; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = day.toISOString().slice(0, 10);
    const cellItems = items.filter((it) => (it.publishAt || it.createdAt || '').slice(0, 10) === key);
    html += `<div class="cal-cell"><div class="d">${day.getMonth() + 1}/${day.getDate()}</div>${cellItems.map((it) => `<div class="cal-item" onclick="openContent('${it.id}')">${esc(it.title || '')}<br><span class="status ${esc(it.status)}">${esc(it.status)}</span></div>`).join('')}</div>`;
  }
  return html + '</div>';
}

function calendarList(items) {
  return `<section class="archive-block" style="margin-top:22px"><h2>全部条目</h2>${
    items.length ? items.slice().reverse().map((it) => `
      <div class="item">
        <div>
          <h3>${esc(it.title || '未命名')}</h3>
          <p>${esc(it.platform || '小红书')} · ${esc(it.businessCategory || '')} · ${esc(it.owner || '')}</p>
          <div class="meta">${esc(it.publishAt || it.createdAt || '')} · <span class="status ${esc(it.status)}">${esc(it.status)}</span></div>
        </div>
        <div class="actions">
          <button class="btn ghost small" onclick="openContent('${it.id}')">看</button>
        </div>
      </div>
    `).join('') : '<div class="empty">还没有日历内容。</div>'
  }</section>`;
}

function openContent(id) {
  const it = (state.contents || []).find((x) => x.id === id);
  if (!it) return;
  const sheet = document.getElementById('sheet');
  sheet.classList.remove('hidden');
  sheet.innerHTML = `
    <div class="sheet-card" onclick="event.stopPropagation()">
      <h2>${esc(it.title || '')}</h2>
      <p><span class="status ${esc(it.status)}">${esc(it.status)}</span></p>
      ${it.posterUrl ? `<img src="${esc(it.posterUrl)}" alt="" style="width:100%;border-radius:10px;margin:10px 0">` : ''}
      <pre style="white-space:pre-wrap;font-family:var(--sans)">${esc(it.body || '')}</pre>
      <p class="hint">CTA：${esc(it.cta || '')}<br>${esc(it.hashtags || '')}</p>
      <div class="field"><label>审核意见</label><textarea id="rv_note" rows="3">${esc(it.reviewNotes || '')}</textarea></div>
      <div class="actions">
        <button class="btn ghost" onclick="advanceContent('${it.id}')">提交下一审核</button>
        ${isReviewer() ? `<button class="btn" onclick="setContentStatus('${it.id}','Approved')">批准</button>` : ''}
        ${isReviewer() ? `<button class="btn quiet" onclick="setContentStatus('${it.id}','Rejected')">驳回</button>` : ''}
        ${isReviewer() ? `<button class="btn ghost" onclick="setContentStatus('${it.id}','Scheduled')">排期</button>` : ''}
        <button class="btn quiet" onclick="closeSheet()">关闭</button>
      </div>
    </div>`;
  sheet.onclick = closeSheet;
}

async function advanceContent(id) {
  try {
    const res = await post('/api/contents/' + id + '/submit', { note: val('rv_note') });
    const list = await api('/api/contents');
    state.contents = list.items || [];
    closeSheet();
    draw();
    toast('状态：' + res.item.status);
  } catch (e) { toast(e.message, true); }
}

async function setContentStatus(id, status) {
  try {
    await put('/api/contents/' + id, { status, reviewNotes: val('rv_note') });
    const list = await api('/api/contents');
    state.contents = list.items || [];
    closeSheet();
    draw();
    toast('已更新为 ' + status);
  } catch (e) { toast(e.message, true); }
}

function viewReview() {
  return `
    <h1>数据复盘</h1>
    <p class="lead">人工录入表现数据。AI 只给选题建议，不能自动覆盖正式规则。</p>
    <section class="panel">
      <div class="row">
        <div class="field"><label>对应内容标题</label><input id="m_title"></div>
        <div class="field"><label>内容 ID（可选）</label><input id="m_cid"></div>
      </div>
      <div class="row">
        ${[['impressions', '曝光量'], ['clicks', '点击量'], ['likes', '点赞'], ['saves', '收藏'], ['comments', '评论'], ['shares', '分享'], ['follows', '新增关注'], ['leads', '咨询数量'], ['deals', '成交数量']].map(([k, lab]) => `
          <div class="field"><label>${lab}</label><input id="m_${k}" type="number"></div>
        `).join('')}
      </div>
      <div class="field"><label>备注</label><textarea id="m_note" rows="2"></textarea></div>
      <div class="actions">
        <button class="btn" onclick="saveMetrics()">保存数据</button>
        <button class="btn ghost" onclick="suggestReview()">生成规则建议</button>
      </div>
    </section>
    <section class="archive-block">
      <h2>已录入</h2>
      ${(state.metrics || []).slice().reverse().map((m) => `
        <div class="item"><div><h3>${esc(m.title || m.contentId || '记录')}</h3>
        <p>曝光 ${m.impressions} · 赞 ${m.likes} · 藏 ${m.saves} · 评 ${m.comments} · 咨询 ${m.leads}</p></div></div>
      `).join('') || '<div class="empty">还没有数据。</div>'}
    </section>
    <section class="archive-block">
      <h2>待管理员确认的建议</h2>
      ${(state.suggestions || []).slice().reverse().map((s) => `
        <div class="item">
          <div><h3>${esc(s.status)}</h3><p>${esc((s.reply || '').slice(0, 180))}</p></div>
          <div class="actions">${isAdmin() && s.status === 'pending' ? `<button class="btn small" onclick="applySuggestion('${s.id}')">确认写入规则迭代</button>` : ''}</div>
        </div>
      `).join('') || '<div class="empty">暂无建议。</div>'}
    </section>
  `;
}

async function saveMetrics() {
  try {
    const body = { title: val('m_title'), contentId: val('m_cid'), note: val('m_note') };
    ['impressions', 'clicks', 'likes', 'saves', 'comments', 'shares', 'follows', 'leads', 'deals'].forEach((k) => { body[k] = val('m_' + k); });
    const res = await post('/api/metrics', body);
    state.metrics = res.items || [];
    draw();
    toast('数据已记');
  } catch (e) { toast(e.message, true); }
}

async function suggestReview() {
  busy(true, '复盘中，不会改正式规则');
  try {
    const res = await post('/api/review/suggest', {});
    state.suggestions = (await api('/api/suggestions')).items || [];
    openText('规则建议（待确认）', res.suggestion.reply);
    toast(res.notice);
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

async function applySuggestion(id) {
  if (!confirm('确认把这条建议写入账号规则的迭代记录？正式字段不会被静默覆盖。')) return;
  try {
    await post('/api/review/apply', { id });
    toast('已记入规则迭代，管理员可再手工改字段');
  } catch (e) { toast(e.message, true); }
}

function viewUsers() {
  return `
    <h1>权限说明</h1>
    <p class="lead">当前站点无需登录，打开即可使用。不再要求用户名和密码。</p>
  `;
}

async function createUser() {
  if (!isAdmin()) return;
  try {
    await post('/api/users', { user: { name: val('nu_name'), role: val('nu_role') || 'editor', password: val('nu_password') } });
    toast('用户已保存');
  } catch (e) { toast(e.message, true); }
}

function viewAiSettings() {
  const ai = state.me.ai || {};
  return `
    <h1>AI 设置</h1>
    <p class="lead">密钥只能放在 Render 环境变量，不会出现在浏览器或接口响应里。</p>
    <section class="panel">
      <p>状态：<strong>${ai.configured ? '已配置' : '未配置'}</strong></p>
      <p>来源：${esc(ai.source || 'none')} · Provider：${esc(ai.provider || '-')} · 模型：${esc(ai.model || '-')}</p>
      <p>图片模型：${ai.imageConfigured ? '已配置' : '未配置（可使用快速模板海报）'}</p>
      <h2 style="margin-top:16px">Render 环境变量</h2>
      <p class="hint">AI_PROVIDER=openai 或 gemini<br>AI_API_KEY=你的密钥<br>AI_MODEL=gpt-4o-mini 或 gemini-2.0-flash<br>IMAGE_API_KEY=可选，用于 AI 海报<br>DATABASE_URL=Render PostgreSQL 连接串（生产必须）<br>ADMIN_PASSWORD=首次管理员密码</p>
    </section>
  `;
}

function viewLogs() {
  return `
    <h1>系统日志</h1>
    <p class="lead">记录任务类型、模型与状态，不会记录 API Key。</p>
    <div class="actions"><button class="btn ghost" onclick="loadLogs()">刷新</button></div>
    <div id="logBox" class="empty">点击刷新。</div>
  `;
}

async function loadLogs() {
  try {
    const res = await api('/api/logs');
    document.getElementById('logBox').innerHTML = (res.items || []).map((l) => `
      <div class="item"><div><h3>${esc(l.kind)} · ${esc(l.status)}</h3>
      <p>${esc(l.user_name || '')} · ${esc(l.model || '')} · ${esc(l.intent || '')}</p>
      <div class="meta">${esc(l.createdAt || '')}</div></div></div>
    `).join('') || '<div class="empty">暂无日志</div>';
  } catch (e) { toast(e.message, true); }
}

function viewLibrary() {
  const items = state.contents || [];
  return `
    <h1>内容库</h1>
    <p class="lead">已生成和进入审核流程的全部内容。状态未经人工批准不会变成 Scheduled 或 Published。</p>
    ${items.length ? items.slice().reverse().map((it) => `
      <div class="item">
        <div>
          <h3>${esc(it.title || '未命名')}</h3>
          <p>${esc(it.audience || '')} · ${esc(it.purpose || '')}</p>
          <div class="meta"><span class="status ${esc(it.status)}">${esc(it.status)}</span> · ${esc(it.publishAt || it.createdAt || '')}</div>
        </div>
        <div class="actions"><button class="btn ghost small" onclick="openContent('${it.id}')">看</button></div>
      </div>
    `).join('') : '<div class="empty">还没有内容。请先在 AI 助理里生成并保存。</div>'}
  `;
}

function viewHistory() {
  const feed = (state.feed || []).slice().reverse();
  const pub = (state.contents || []).filter((c) => c.status === 'Published');
  return `
    <h1>历史内容</h1>
    <p class="lead">用于重复检查。把已发布小红书喂进来，新选题才会避开旧切口。</p>
    <p class="hint">把已发布文案保存在内容库中，即可用于避免重复选题。</p>
    <h2>已发布</h2>
    ${pub.map((it) => `<div class="item"><div><h3>${esc(it.title)}</h3><div class="meta">${esc(it.publishAt || '')}</div></div></div>`).join('') || '<div class="empty">还没有 Published 内容。</div>'}
    <h2 style="margin-top:20px">已喂旧帖</h2>
    ${feed.map((it) => `<div class="item"><div><h3>${esc((it.caption || '').split('\\n')[0].slice(0, 40) || '旧帖')}</h3></div></div>`).join('') || '<div class="empty">还没有喂帖。</div>'}
  `;
}

function viewPromptTools() {
  const tabs = [['schedule', '排期 Prompt'], ['posts', '图文 Prompt'], ['iterate', '迭代 Prompt']];
  return `
    <h1>Prompt 模板</h1>
    <p class="lead">旧功能保留。对话首页才是主入口；这里仍可改模板、复制完整 Prompt。</p>
    <div class="tabs">${tabs.map(([k, lab]) => `<button class="${promptKind === k ? 'on' : ''}" onclick="promptKind='${k}'; lastPrompt=''; draw()">${lab}</button>`).join('')}</div>
    ${promptKind === 'schedule' ? formSchedule() : promptKind === 'posts' ? formPosts() : formIterate()}
    ${lastPrompt ? `<section class="prompt"><div class="prompt-head"><h2>Prompt</h2><button class="btn ghost small" onclick="copy(lastPrompt); toast('已复制')">复制</button></div><pre>${esc(lastPrompt)}</pre></section>` : ''}
  `;
}

function formSchedule() {
  if (!state.materials.length) return `<div class="empty">先在「素材」添加公众号摘要。<div class="actions" style="margin-top:12px"><button class="btn ghost" onclick="go('materials')">去添加</button></div></div>`;
  return `
    <div class="row">
      <div class="field narrow"><label>周数</label><input type="number" id="s_weeks" value="${state.settings?.planWeeks || 4}"></div>
      <div class="field narrow"><label>每周篇数</label><input type="number" id="s_ppw" value="${state.settings?.postsPerWeek || 3}"></div>
    </div>
    <div class="pick">${state.materials.map((m) => `<label class="opt"><input type="checkbox" value="${esc(m.id)}" checked><div>${esc(m.title)}</div></label>`).join('')}</div>
    <div class="actions"><button class="btn" onclick="makeSchedule()">生成排期 Prompt</button></div>
  `;
}

function formPosts() {
  const last = state.schedules[state.schedules.length - 1];
  return `
    <div class="field"><label>本周排期</label><textarea id="g_schedule" rows="6">${esc(last?.content || '')}</textarea></div>
    <div class="field"><label>对应片段</label><textarea id="g_snips" rows="5"></textarea></div>
    <div class="actions"><button class="btn" onclick="makePosts()">生成图文 Prompt</button></div>
  `;
}

function formIterate() {
  return `
    <div class="field"><label>这批笔记怎么样</label><textarea id="f_fb" rows="4"></textarea></div>
    <div class="row"><div class="field"><label>较好</label><input id="f_good"></div><div class="field"><label>较差</label><input id="f_bad"></div></div>
    <div class="actions"><button class="btn" onclick="makeIterate()">生成迭代 Prompt</button></div>
  `;
}

function openMaterial(id) {
  const m = id ? state.materials.find((x) => x.id === id) : null;
  const sheet = document.getElementById('sheet');
  sheet.classList.remove('hidden');
  sheet.innerHTML = `
    <div class="sheet-card" onclick="event.stopPropagation()">
      <h2>${m ? '改素材' : '添加一篇'}</h2>
      <div class="field"><label>标题</label><input id="m_title" value="${esc(m?.title || '')}"></div>
      <div class="field"><label>摘要</label><textarea id="m_summary" rows="2">${esc(m?.summary || '')}</textarea></div>
      <div class="field"><label>核心观点</label><textarea id="m_keyPoints" rows="3">${esc(m?.keyPoints || '')}</textarea></div>
      <div class="field"><label>关键片段</label><textarea id="m_snippet" rows="4">${esc(m?.snippet || '')}</textarea></div>
      <div class="actions">
        <button class="btn" onclick="saveMaterial('${m?.id || ''}')">${m ? '保存' : '添加'}</button>
        <button class="btn ghost" onclick="closeSheet()">取消</button>
      </div>
    </div>`;
  sheet.onclick = closeSheet;
}

async function saveMaterial(id) {
  const data = { title: val('m_title'), summary: val('m_summary'), keyPoints: val('m_keyPoints'), snippet: val('m_snippet') };
  if (!data.title) { toast('先写标题', true); return; }
  try {
    if (id) {
      const result = await put('/api/materials/' + id, data);
      state.materials = result.items || state.materials.map((m) => m.id === id ? { ...m, ...data } : m);
    } else {
      const result = await post('/api/materials', data);
      state.materials = result.items || state.materials.concat(result.item ? [result.item] : []);
    }
    closeSheet();
    draw();
    toast(id ? '已更新' : '已添加');
  } catch (e) { toast(e.message, true); }
}

async function removeMaterial(id) {
  if (!confirm('删除这篇素材？')) return;
  try {
    const res = await del('/api/materials/' + id);
    state.materials = res.items || state.materials.filter((m) => m.id !== id);
    draw();
    toast('已删除');
  } catch (e) { toast(e.message, true); }
}

function viewMaterialsPage() {
  return `
    <h1>素材</h1>
    <p class="lead">公众号摘要仍可保存在这里，生成时会和知识库、旧帖一起调用。</p>
    <div class="actions" style="margin-bottom:16px"><button class="btn" onclick="openMaterial()">添加一篇</button></div>
    ${state.materials.length ? state.materials.map((m) => `
      <div class="item"><div><h3>${esc(m.title)}</h3><p>${esc(m.summary || '')}</p><div class="meta">${esc(whenFull(m.createdAt))}</div></div>
      <div class="actions"><button class="btn ghost small" onclick="openMaterial('${m.id}')">改</button><button class="btn quiet small" onclick="removeMaterial('${m.id}')">删</button></div></div>
    `).join('') : '<div class="empty">还没有素材。</div>'}
  `;
}

async function makeSchedule() {
  const ids = [...document.querySelectorAll('.pick input:checked')].map((i) => i.value);
  const materials = state.materials.filter((m) => ids.includes(m.id));
  if (!materials.length) { toast('至少选一篇', true); return; }
  busy(true);
  try {
    const res = await post('/api/prompt/schedule', { materials, weeks: num('s_weeks', 4), postsPerWeek: num('s_ppw', 3) });
    lastPrompt = res.prompt;
    draw();
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

async function makePosts() {
  if (!val('g_schedule')) { toast('先放排期', true); return; }
  busy(true);
  try {
    const res = await post('/api/prompt/posts', { scheduleText: val('g_schedule'), materialSnippets: val('g_snips') });
    lastPrompt = res.prompt;
    draw();
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

async function makeIterate() {
  if (!val('f_fb')) { toast('先写反馈', true); return; }
  busy(true);
  try {
    const res = await post('/api/prompt/iterate', { feedback: val('f_fb'), goodPosts: val('f_good'), badPosts: val('f_bad') });
    lastPrompt = res.prompt;
    draw();
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}
