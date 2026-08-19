state.agent = state.agent || null;
state.knowledge = state.knowledge || [];
state.contents = state.contents || [];
state.metrics = state.metrics || [];
state.suggestions = state.suggestions || [];
state.me = state.me || { user: { role: 'admin', name: '开放模式' }, ai: { configured: false } };
state.chatLog = state.chatLog || [];
state.calCursor = state.calCursor || new Date();
state.calMode = state.calMode || 'month';
let chatBusy = false;
let promptKind = 'schedule';
let lastPrompt = '';
const draft = {
  title: '', subtitle: '', body: '', cta: '', hashtags: '', posterNotes: '', pendingConfirm: '',
  topic: '', businessCategory: '', publishAt: '', owner: '', sourcesText: '', id: ''
};

function toggleSide() {
  document.getElementById('side').classList.toggle('open');
}

function isAdmin() { return (state.me.user || {}).role === 'admin'; }
function isReviewer() { return ['admin', 'reviewer'].includes((state.me.user || {}).role); }

function paintChrome() {
  const me = state.me.user || {};
  const ai = state.me.ai || {};
  const foot = document.getElementById('sideFoot');
  if (foot) {
    foot.innerHTML = `<span class="role-badge">${esc(me.role || 'guest')}</span><div style="margin-top:8px">${esc(me.name || '')}<br>AI：${ai.configured ? '已接服务器接口' : '未配置，走任务打包'}</div>`;
  }
  const top = document.getElementById('topActions');
  if (top) {
    top.innerHTML = `
      <span class="role-badge">${esc(me.role || '')}</span>
      <button class="btn ghost small" onclick="openLogin()">${me.id && me.id.indexOf('guest') === 0 ? '登录' : '切换'}</button>
    `;
  }
}

function openLogin() {
  const sheet = document.getElementById('sheet');
  sheet.classList.remove('hidden');
  sheet.innerHTML = `
    <div class="sheet-card" onclick="event.stopPropagation()">
      <h2>登录工作台</h2>
      <p class="hint">默认口令 Admin 2468 / Editor 1357 / Reviewer 8642。可在权限页修改。开放模式无需登录。</p>
      <div class="field"><label>口令</label><input type="password" id="pin"></div>
      <div class="actions">
        <button class="btn" onclick="doLogin()">进入</button>
        <button class="btn ghost" onclick="closeSheet()">取消</button>
      </div>
    </div>`;
  sheet.onclick = closeSheet;
}

async function doLogin() {
  try {
    const res = await post('/api/auth/login', { pin: val('pin') });
    state.me.user = res.user;
    closeSheet();
    paintChrome();
    toast('已登录 ' + res.user.role);
  } catch (e) { toast(e.message, true); }
}

async function bootWorkbench() {
  try {
    const [me, agent, knowledge, contents, metrics, suggestions] = await Promise.all([
      api('/api/me'),
      api('/api/agent'),
      api('/api/knowledge'),
      api('/api/contents'),
      api('/api/metrics'),
      api('/api/suggestions')
    ]);
    state.me = me;
    state.agent = agent;
    state.knowledge = knowledge.items || [];
    state.contents = contents.items || [];
    state.metrics = metrics.items || [];
    state.suggestions = suggestions.items || [];
  } catch (e) {
    console.warn(e);
  }
  paintChrome();
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
    agent: viewAgent,
    knowledge: viewKnowledge,
    calendar: viewCalendar,
    generate: viewGenerate,
    review: viewReview,
    users: viewUsers,
    prompt: viewPromptTools,
    materials: viewMaterialsPage
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
  const allowed = ['chat', 'generate', 'calendar', 'review', 'knowledge', 'feed', 'style', 'materials', 'agent', 'rules', 'prompt', 'archive', 'users', 'produce'];
  if (!allowed.includes(name)) name = 'chat';
  await _go(name);
};

const _boot = boot;
boot = async function () {
  await _boot();
  await bootWorkbench();
  if (!['chat', 'generate', 'calendar', 'review', 'knowledge', 'feed', 'style', 'materials', 'agent', 'rules', 'prompt', 'archive', 'users', 'produce'].includes(page)) {
    page = 'chat';
  }
  draw();
};

function viewChat() {
  const log = state.chatLog.map((m) => `
    <div class="bubble ${m.role}">
      <div class="meta">${m.role === 'user' ? '你' : 'CPLUS 助理'} · ${esc(m.time || '')}</div>
      ${esc(m.text)}
      ${m.dupHint ? `<div class="warn">${esc(m.dupHint)}</div>` : ''}
      ${m.sources && m.sources.length ? `<div class="source-list">来源：${esc(m.sources.map((s) => s.name).join(' · '))}</div>` : ''}
      ${m.notice ? `<p class="hint">${esc(m.notice)}</p>` : ''}
    </div>
  `).join('');
  return `
    <h1>CPLUS 新媒体运营助理</h1>
    <p class="lead">说一句即可。系统会自动带上品牌规则、知识库和历史旧帖。普通用户不必再填长 Prompt。</p>
    <div class="quick">
      ${[
        ['生成下个月的内容排期。', '生成月度排期'],
        ['生成本周3篇小红书内容。', '生成本周内容'],
        ['写一篇关于香港公司年审的小红书。', '生成单篇内容'],
        ['根据这篇文章生成5个选题：', '文章拆解'],
        ['检查这篇内容是否存在合规问题：', '内容合规检查'],
        ['根据最近数据做选题复盘。', '数据复盘']
      ].map(([q, lab]) => `<button class="chip" onclick="fillChat(${JSON.stringify(q)})">${lab}</button>`).join('')}
    </div>
    <section class="hero-chat">
      <div class="chat-log">${log || '<div class="hint">还没有对话。先喂帖或上传知识库，效果更好。</div>'}</div>
      <div id="chatProgress" class="progress hidden">正在加载规则与资料…</div>
      <div class="field">
        <textarea id="chatMsg" rows="4" placeholder="例如：生成下个月的内容排期。"></textarea>
      </div>
      <div class="actions">
        <button class="btn" id="chatSend" onclick="sendChat()">发送</button>
        <button class="btn ghost" onclick="saveLastChatToGenerate()">送去生成器</button>
        <button class="btn quiet" onclick="go('produce')">旧版一句话出稿</button>
      </div>
    </section>
  `;
}

function fillChat(q) {
  const el = document.getElementById('chatMsg');
  if (el) el.value = q;
}

async function sendChat() {
  if (chatBusy) return;
  const message = val('chatMsg');
  if (!message) { toast('先写一句指令', true); return; }
  chatBusy = true;
  const btn = document.getElementById('chatSend');
  if (btn) btn.disabled = true;
  state.chatLog.push({ role: 'user', text: message, time: whenFull(new Date().toISOString()) });
  const prog = document.getElementById('chatProgress');
  if (prog) {
    prog.classList.remove('hidden');
    prog.textContent = '1/3 加载规则库…';
  }
  draw();
  const p2 = document.getElementById('chatProgress');
  if (p2) { p2.classList.remove('hidden'); p2.textContent = '2/3 检索知识库与历史内容…'; }
  try {
    const res = await post('/api/agent/chat', { message });
    if (p2) p2.textContent = '3/3 生成完成';
    state.chatLog.push({
      role: 'bot',
      text: res.reply,
      time: whenFull(new Date().toISOString()),
      sources: res.sources,
      dupHint: res.dupHint,
      notice: res.notice || (res.mode === 'brief' ? '未接模型，已打包完整任务。' : '')
    });
    lastResult = res.reply;
    lastBrief = res.reply;
    lastCommand = message;
    if (res.mode === 'brief') copy(res.reply);
    toast(res.mode === 'ai' ? '已生成' : '已复制任务给外部 AI');
  } catch (e) {
    toast(e.message, true);
    state.chatLog.push({ role: 'bot', text: '出错：' + e.message, time: whenFull(new Date().toISOString()) });
  } finally {
    chatBusy = false;
    draw();
    const el = document.getElementById('chatMsg');
    if (el) el.value = '';
  }
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
  draft.title = pick('封面标题') || draft.title;
  draft.subtitle = pick('副标题/三个重点') || pick('副标题') || draft.subtitle;
  draft.body = pick('笔记正文') || draft.body;
  draft.cta = pick('CTA') || (state.agent && state.agent.fixedCta) || '';
  draft.hashtags = pick('Hashtag') || (state.agent && state.agent.fixedHashtags) || '';
  draft.posterNotes = pick('海报制作说明') || '';
  draft.pendingConfirm = pick('待人工确认事项') || '';
  draft.sourcesText = pick('参考资料') || '';
}

function viewAgent() {
  const a = state.agent || {};
  const fields = [
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
    ['officialSources', '官方资料来源']
  ];
  return `
    <h1>Agent 规则库</h1>
    <p class="lead">管理员维护。普通用户对话时自动加载，不必每次重写。</p>
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
  ['brandBackground', 'accountPosition', 'targetAudience', 'serviceScope', 'copyRules', 'imageRules', 'complianceRules', 'bannedWords', 'fixedCta', 'fixedHashtags', 'officialSources'].forEach((k) => {
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
    <h1>企业知识库</h1>
    <p class="lead">上传画册、合规指引、公众号和网站摘录。生成时按指令检索摘录，并记下资料来源。</p>
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
        <div class="field"><label>封面标题</label><input id="d_title" value="${esc(draft.title)}"></div>
        <div class="field"><label>副标题 / 三个重点</label><textarea id="d_subtitle" rows="3">${esc(draft.subtitle)}</textarea></div>
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
        <div class="field"><label>待人工确认</label><textarea id="d_pending" rows="2">${esc(draft.pendingConfirm)}</textarea></div>
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
          <button class="btn" onclick="paintPoster()">重新生成</button>
          <button class="btn ghost" onclick="downloadPoster()">下载 PNG</button>
        </div>
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
  draft.title = val('d_title') || draft.title;
  draft.subtitle = val('d_subtitle') || draft.subtitle;
  draft.body = val('d_body') || draft.body;
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
  g.fillText('CPLUS GROUP', 56, 70);
  g.font = '20px "PingFang SC", sans-serif';
  g.fillText(posterTpl === 'biz' ? (draft.businessCategory || '企业合规') : '香港 · 合规 · 跨境', 56, 110);
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
  const text = `【封面标题】${draft.title}\n【副标题/三个重点】${draft.subtitle}\n【笔记正文】\n${draft.body}\n【CTA】${draft.cta}\n【Hashtag】${draft.hashtags}\n【海报制作说明】${draft.posterNotes}\n【参考资料】${draft.sourcesText}\n【待人工确认事项】${draft.pendingConfirm}`;
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
      sources: draft.sourcesText ? [{ name: draft.sourcesText }] : [],
      businessCategory: draft.businessCategory,
      publishAt: draft.publishAt,
      topic: draft.title,
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
    <h1>权限</h1>
    <p class="lead">Admin 改规则、知识库、用户和 AI 接口；Editor 生成与提交；Reviewer 事实/合规审核。默认开放模式，所有人可先用。</p>
    <section class="panel">
      <div class="field"><label>启用登录口令</label>
        <div class="chips"><button class="chip ${state.me.authRequired ? 'on' : ''}" onclick="toggleAuth()">开启后必须登录</button></div>
      </div>
      <p class="hint">AI Key 只能写在 Render 环境变量 AI_API_KEY，或管理员在下面填写。前端看不到完整密钥。</p>
      ${isAdmin() ? `
        <div class="field"><label>API Base</label><input id="set_base" value="${esc((state.settings && state.settings.apiBaseUrl) || '')}" placeholder="https://api.openai.com/v1"></div>
        <div class="field"><label>模型</label><input id="set_model" value="${esc((state.settings && state.settings.model) || 'gpt-4o-mini')}"></div>
        <div class="field"><label>API Key（只在服务器保存）</label><input id="set_key" type="password" placeholder="留空表示不修改"></div>
        <div class="actions"><button class="btn" onclick="saveAiSettings()">保存接口</button></div>
      ` : '<p class="hint">当前角色不能配置接口。</p>'}
    </section>
  `;
}

async function toggleAuth() {
  if (!isAdmin()) { toast('仅管理员', true); return; }
  try {
    await post('/api/users', { authRequired: !state.me.authRequired });
    state.me = await api('/api/me');
    draw();
  } catch (e) { toast(e.message, true); }
}

async function saveAiSettings() {
  if (!isAdmin()) return;
  const body = { apiBaseUrl: val('set_base'), model: val('set_model') };
  if (val('set_key')) body.apiKey = val('set_key');
  try {
    const res = await post('/api/settings', body);
    state.settings = res.settings;
    state.me = await api('/api/me');
    toast('接口已在服务器保存');
    paintChrome();
  } catch (e) { toast(e.message, true); }
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
