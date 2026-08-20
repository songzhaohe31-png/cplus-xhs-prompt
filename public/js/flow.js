state.readiness = state.readiness || { percent: 0, facts: 0, captions: 0, posters: 0, analyzed: false, confirmed: false, next: 'upload', canGenerate: false };
state.dna = state.dna || { fields: {}, confirmed: false };
state.series = state.series || [];
state.generalMode = false;
state.homeSeries = '';

const FLOW_PAGES = ['home', 'facts', 'samples', 'style', 'rules', 'topics', 'produce', 'schedule', 'reports'];

function readinessLabel(p) {
  if (p >= 100) return '可以正式生成';
  if (p >= 75) return '请确认账号规则';
  if (p >= 50) return '请开始风格分析';
  if (p >= 25) return '请补充历史文案和海报';
  return '请先上传资料';
}

function paintChrome() {
  const foot = document.getElementById('sideFoot');
  if (foot) foot.innerHTML = '';
  const top = document.getElementById('topActions');
  if (top) top.innerHTML = '';
}

function viewHome() {
  const r = state.readiness || {};
  const p = r.percent || 0;
  const steps = [
    ['facts', '1. 建立资料库', r.facts > 0],
    ['samples', '2. 分析账号风格', r.captions > 0 || r.posters > 0],
    ['topics', '3. 规划内容主题', r.confirmed],
    ['produce', '4. 生成图文', r.canGenerate],
    ['reports', '5. 导出成果', (state.contents || []).length > 0]
  ];
  const cta = !r.facts && !r.captions
    ? `<button class="btn" onclick="go('facts')">开始上传资料</button>
       <button class="btn quiet" onclick="enableGeneralMode()">仅使用通用模式测试</button>`
    : !r.analyzed
      ? `<button class="btn" onclick="go('style')">开始AI风格分析</button>`
      : !r.confirmed
        ? `<button class="btn" onclick="go('rules')">确认账号风格</button>`
        : `<button class="btn" onclick="go('topics')">生成内容主题</button>
           <button class="btn ghost" onclick="go('produce')">生成完整图文</button>`;
  return `
    <h1>工作台</h1>
    <p class="lead">先建立资料和风格，再生成CPLUS正式内容。不要跳过资料库直接写稿。</p>
    <div class="ready-bar"><span style="width:${p}%"></span></div>
    <p class="ready-meta">AI准备度 ${p}% · ${esc(readinessLabel(p))}</p>
    <section class="panel">
      <h2>资料准备状态</h2>
      <ul class="status-list">
        <li>业务资料：已上传 ${r.facts || 0} 份</li>
        <li>历史文案：已上传 ${r.captions || 0} 篇</li>
        <li>海报样本：已上传 ${r.posters || 0} 张</li>
        <li>已完成风格分析：${r.analyzed ? '是' : '否'}</li>
        <li>已确认账号规则：${r.confirmed ? '是' : '否'}</li>
      </ul>
      ${p < 100 ? `<div class="warn">请先上传公司资料、历史文案或海报样本。AI完成资料分析后，才能按照CPLUS的真实业务和账号风格生成内容。</div>` : ''}
      ${state.generalMode ? `<div class="warn">通用模式不会使用CPLUS专属资料及历史风格，生成结果仅供测试。</div>` : ''}
      <div class="result-actions">${cta}</div>
    </section>
    <div class="step-row">
      ${steps.map(([pg, lab, on]) => `<button class="step-card ${on ? 'ok' : ''}" onclick="go('${pg}')">${esc(lab)}</button>`).join('')}
    </div>
  `;
}

function enableGeneralMode() {
  state.generalMode = true;
  toast('已进入通用测试模式，结果不能当作正式内容');
  draw();
}

function viewFacts() {
  const items = (state.knowledge || []).filter((k) => k.zone !== 'sample');
  return `
    <h1>业务资料</h1>
    <p class="lead">上传画册、服务介绍、官网、公众号、牌照与监管资料。生成正式内容前必须有事实基础。</p>
    <div class="kb-grid">
      <section class="panel">
        <h2>上传事实资料</h2>
        <div class="field"><label>文件名称</label><input id="k_name"></div>
        <div class="row">
          <div class="field"><label>资料类型</label><input id="k_category" placeholder="画册 / 官网 / 公众号 / 牌照 / FAQ"></div>
          <div class="field"><label>业务分类</label>
            <select id="k_business">${seriesOptions()}</select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>司法管辖区</label><input id="k_jurisdiction" value="香港"></div>
          <div class="field"><label>内容日期</label><input id="k_cdate" type="date"></div>
        </div>
        <div class="field"><label>时效性</label><div class="chips"><button class="chip" id="k_timely" onclick="this.classList.toggle('on')">有时效，需更新</button></div></div>
        <div class="field"><label>文件（PDF / Word / Excel / TXT）</label><input id="k_file" type="file"></div>
        <div class="field"><label>或粘贴文章 / 网址</label><textarea id="k_text" rows="4"></textarea></div>
        <div class="actions"><button class="btn" onclick="uploadKnowledgeZone('facts')">保存到业务资料</button></div>
      </section>
      <section>
        ${items.slice().reverse().map((k) => `
          <article class="result-card">
            <h3>${esc(k.name)}</h3>
            <p>${esc(k.category || '')} · ${esc(k.business || '')} · ${esc(k.jurisdiction || '')}</p>
            ${k.facts ? `<p>${esc(k.facts)}</p>` : ''}
            <div class="meta">${esc(whenFull(k.uploadedAt))} · ${esc(k.status || '')}${k.contentDate ? ' · 内容日期 ' + esc(k.contentDate) : ''}${k.timely ? ' · 有时效' : ''}</div>
          </article>
        `).join('') || '<div class="empty">还没有业务资料。请先上传画册或服务介绍。</div>'}
      </section>
    </div>
  `;
}

function seriesOptions(selected) {
  const list = state.series && state.series.length ? state.series : [
    { id: 'hk-company', name: '香港公司注册及秘书服务' },
    { id: 'hk-mso', name: '香港MSO' }
  ];
  return list.map((s) => `<option value="${esc(s.name)}" ${s.name === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

async function uploadKnowledgeZone(zone) {
  const file = document.getElementById('k_file') && document.getElementById('k_file').files[0];
  const payload = {
    zone: zone === 'sample' ? 'sample' : 'facts',
    name: val('k_name') || (file && file.name) || '未命名资料',
    category: val('k_category'),
    business: val('k_business'),
    jurisdiction: val('k_jurisdiction') || '香港',
    contentDate: val('k_cdate'),
    timely: !!(document.getElementById('k_timely') && document.getElementById('k_timely').classList.contains('on')),
    text: val('k_text') || val('s_caption'),
    caption: val('s_caption'),
    rating: val('s_rating'),
    note: val('s_note'),
    filename: file ? file.name : '',
    mime: file ? file.type : 'text/plain'
  };
  if (file) payload.dataUrl = await readFileData(file);
  if (!payload.dataUrl && !payload.text && !payload.caption) { toast('请上传文件或粘贴文本', true); return; }
  busy(true, '在解析资料');
  try {
    const res = await post('/api/knowledge', payload);
    state.knowledge = res.items || [];
    await refreshReady();
    draw();
    toast('已保存');
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

function viewSamples() {
  const samples = (state.knowledge || []).filter((k) => k.zone === 'sample');
  const feed = state.feed || [];
  return `
    <h1>历史文案与海报</h1>
    <p class="lead">同一条帖子请把海报和Caption一起保存，供风格学习。</p>
    <section class="panel">
      <h2>上传一条已发布内容</h2>
      <div class="field"><label>内容主题</label><input id="s_topic"></div>
      <div class="row">
        <div class="field"><label>业务分类</label><select id="k_business">${seriesOptions()}</select></div>
        <div class="field"><label>发布时间</label><input id="k_cdate" type="date"></div>
      </div>
      <div class="field"><label>小红书Caption</label><textarea id="s_caption" rows="5"></textarea></div>
      <div class="row">
        <div class="field"><label>数据表现</label>
          <select id="s_rating"><option value="">未标</option><option value="good">较好</option><option value="ok">一般</option><option value="bad">较差</option></select>
        </div>
        <div class="field"><label>是否值得模仿</label>
          <select id="s_note"><option value="">未标</option><option value="模仿">值得模仿</option><option value="避开">不要模仿</option></select>
        </div>
      </div>
      <div class="field"><label>海报图片</label><input id="s_img" type="file" accept="image/*"></div>
      <div class="actions"><button class="btn" onclick="uploadSamplePost()">绑定保存海报和文案</button></div>
    </section>
    ${(feed.slice().reverse().map((f) => `
      <article class="result-card">
        ${f.images && f.images[0] && f.images[0].url ? `<img src="${esc(f.images[0].url)}" alt="" style="width:120px;border-radius:8px;margin-bottom:8px">` : ''}
        <h3>${esc((f.caption || '').split('\n')[0].slice(0, 36) || '样本')}</h3>
        <p>${esc((f.caption || '').slice(0, 160))}</p>
        <div class="meta">${esc(f.rating || '')} ${esc(f.note || '')}</div>
      </article>
    `).join('') + samples.map((k) => `
      <article class="result-card"><h3>${esc(k.name)}</h3><p>${esc(k.facts || k.caption || '')}</p></article>
    `).join('')) || '<div class="empty">还没有历史样本。建议上传3至5篇。</div>'}
  `;
}

async function uploadSamplePost() {
  const file = document.getElementById('s_img') && document.getElementById('s_img').files[0];
  const caption = val('s_caption');
  if (!caption && !file) { toast('请至少提供文案或海报', true); return; }
  busy(true, '保存样本');
  try {
    const images = [];
    if (file) images.push({ name: file.name, mime: file.type, dataUrl: await readFileData(file) });
    await post('/api/feed', [{
      caption,
      rating: val('s_rating'),
      note: val('s_note'),
      topic: val('s_topic'),
      images
    }]);
    const feed = await api('/api/feed');
    state.feed = feed.items || [];
    await refreshReady();
    draw();
    toast('已绑定保存');
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

function viewStyle() {
  const d = state.dna || {};
  const r = state.readiness || {};
  const copy = d.copy || {};
  const visual = d.visual || {};
  const strategy = d.strategy || {};
  return `
    <h1>账号风格分析</h1>
    <p class="lead">分析历史文案和海报，生成CPLUS账号风格DNA。完整分析过程不会显示给用户。</p>
    <div class="result-actions">
      <button class="btn" onclick="runStyleAnalyze()" ${r.facts + r.captions + r.posters ? '' : 'disabled'}>开始分析账号风格</button>
      <button class="btn ghost" onclick="exportStylePdf()">导出风格分析PDF</button>
      <button class="btn ghost" onclick="exportVisualPdf()">导出海报规律PDF</button>
    </div>
    ${!d.analyzedAt ? `<div class="warn">尚未建立账号风格。可以先上传3至5篇历史文案及海报，或使用通用风格生成测试稿。</div>` : ''}
    ${d.analyzedAt ? `
      <h2>文案风格</h2>
      <div class="dna-grid">${[['script','文字'],['formality','专业程度'],['spoken','口语化'],['titleLen','标题字数'],['hooks','开场钩子'],['avgChars','平均字数'],['emoji','Emoji'],['hashtags','Hashtag'],['banned','禁用']].map(([k,l]) => copy[k] ? `<article class="result-card"><div class="kicker">${esc(l)}</div><p>${esc(copy[k])}</p></article>` : '').join('')}</div>
      <h2>海报视觉</h2>
      <div class="dna-grid">${[['ratio','比例'],['size','尺寸'],['colors','色彩'],['layout','版式'],['logo','Logo'],['density','密度']].map(([k,l]) => visual[k] ? `<article class="result-card"><div class="kicker">${esc(l)}</div><p>${esc(visual[k])}</p></article>` : '').join('')}</div>
      <div class="swatch-row">${swatches(visual.colors)}</div>
      <h2>内容策略</h2>
      <div class="dna-grid">${[['themes','主题'],['repeatRisk','重复风险'],['highPerform','高表现共性'],['nextTopics','可发展方向']].map(([k,l]) => strategy[k] ? `<article class="result-card"><div class="kicker">${esc(l)}</div><p>${esc(strategy[k])}</p></article>` : '').join('')}</div>
      <div class="result-actions"><button class="btn" onclick="go('rules')">去确认账号风格</button></div>
    ` : ''}
  `;
}

function swatches(colors) {
  const list = String(colors || '').split(/[,，、/\s]+/).filter((c) => /^#?[0-9a-fA-F]{6}$/.test(c) || /海军|钴蓝|白|金|青绿/.test(c));
  const map = { '海军蓝': '#1a4b8c', '钴蓝': '#2f6fb5', '白': '#ffffff', '金': '#c4a35a', '青绿': '#1aa6a6' };
  return list.slice(0, 6).map((c) => {
    const hex = c.startsWith('#') ? c : (map[c] || '#1a4b8c');
    return `<span class="swatch" style="background:${hex}" title="${esc(c)}"></span>`;
  }).join('');
}

async function runStyleAnalyze() {
  busy(true, '正在分析账号风格');
  try {
    const res = await post('/api/dna/analyze', {});
    state.dna = res.dna;
    state.readiness = res.readiness || state.readiness;
    draw();
    toast('风格分析已完成，请确认规则');
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

function viewRules() {
  const f = (state.dna && state.dna.fields) || {};
  const labels = [
    ['positioning', '账号定位'], ['audience', '目标客户'], ['tone', '品牌语气'],
    ['titleFormula', '标题公式'], ['hookFormula', '开场公式'], ['bodyStructure', '正文结构'],
    ['ctaRule', 'CTA规则'], ['hashtagRule', 'Hashtag规则'], ['posterColors', '海报色彩'],
    ['posterLayout', '海报版式'], ['imageElements', '图片元素'], ['mix', '内容类型比例'],
    ['banned', '禁用表达'], ['directions', '推荐内容方向']
  ];
  return `
    <h1>已确认风格规则</h1>
    <p class="lead">确认后的风格DNA会在之后每次正式生成时自动调用。不会显示系统提示词。</p>
    ${labels.map(([k, lab]) => `
      <div class="field"><label>${esc(lab)}</label>
        <textarea id="dna_${k}" rows="2">${esc(f[k] || '')}</textarea>
        <button class="btn quiet small" onclick="document.getElementById('dna_${k}').value='';">删除此项</button>
      </div>
    `).join('')}
    <div class="result-actions">
      <button class="btn ghost" onclick="saveDnaFields()">保存修改</button>
      <button class="btn" onclick="confirmDna()">确认账号风格</button>
      <button class="btn quiet" onclick="runStyleAnalyze()">重新分析</button>
    </div>
  `;
}

async function saveDnaFields() {
  const fields = {};
  ['positioning','audience','tone','titleFormula','hookFormula','bodyStructure','ctaRule','hashtagRule','posterColors','posterLayout','imageElements','mix','banned','directions'].forEach((k) => {
    fields[k] = val('dna_' + k);
  });
  const res = await post('/api/dna', { fields });
  state.dna = res.dna;
  toast('已保存');
}

async function confirmDna() {
  await saveDnaFields();
  const res = await post('/api/dna/confirm', {});
  state.dna = res.dna;
  state.readiness = res.readiness || state.readiness;
  toast('风格规则已确认，可以正式生成');
  go('topics');
}

function viewTopics() {
  const r = state.readiness || {};
  const locked = !r.canGenerate && !state.generalMode;
  return `
    <h1>主题规划</h1>
    <p class="lead">基于资料库和已确认风格生成选题。确认主题后再写完整文案。</p>
    ${locked ? lockBanner() : ''}
    <div class="field"><label>业务系列</label><select id="topic_series">${seriesOptions()}</select></div>
    <div class="field"><label>补充说明（可选）</label><textarea id="topic_note" rows="2" placeholder="例如：重点推年审和开户"></textarea></div>
    <div class="result-actions">
      <button class="btn" ${locked ? 'disabled' : ''} onclick="generateTopics()">生成内容主题</button>
      ${!r.canGenerate ? `<button class="btn quiet" onclick="enableGeneralMode(); generateTopics(true)">通用模式测试</button>` : ''}
    </div>
    <div id="chatProgress" class="progress hidden">准备中…</div>
    <div id="topicBox">${renderTopicList()}</div>
    <div id="streamOut" class="safe-text"></div>
  `;
}

function lockBanner() {
  const r = state.readiness || {};
  if (!r.facts) return `<div class="warn">缺少相关业务资料，暂时不能生成正式内容。请先上传相关服务资料或官方来源。<div class="result-actions"><button class="btn" onclick="go('facts')">上传资料</button></div></div>`;
  return `<div class="warn">尚未建立账号风格。可以先上传3至5篇历史文案及海报，或使用通用风格生成测试稿。<div class="result-actions"><button class="btn" onclick="go('samples')">上传样本</button> <button class="btn ghost" onclick="go('style')">去分析</button></div></div>`;
}

function renderTopicList() {
  const items = (state.lastStructured && state.lastStructured.type === 'schedule' && state.lastStructured.items) || [];
  if (!items.length) return '<div class="hint">生成后将列出主题、封面标题、类型、客户和参考方向。</div>';
  return renderSchedule(state.lastStructured);
}

async function generateTopics(forceGeneral) {
  const note = val('topic_note');
  const series = val('topic_series');
  const msg = '生成未来4周的小红书内容排期，每周3篇。业务系列：' + series + (note ? '。' + note : '');
  const el = document.getElementById('chatMsg');
  if (el) el.value = msg;
  if (forceGeneral) state.generalMode = true;
  page = 'topics';
  await runGenerate(msg);
}

function viewProduce() {
  const r = state.readiness || {};
  const locked = !r.canGenerate && !state.generalMode;
  return `
    <h1>图文生成</h1>
    <p class="lead">确认主题后，按已学习的语言和海报规律生成完整小红书图文。</p>
    ${locked ? lockBanner() : ''}
    ${state.generalMode ? `<div class="warn">通用模式不会使用CPLUS专属资料及历史风格，生成结果仅供测试。</div>` : ''}
    <div class="field"><label>一句话指令</label><textarea id="prod_msg" rows="3" placeholder="写一篇香港公司年审避坑的小红书。">${esc(lastCommand || '')}</textarea></div>
    <div class="result-actions">
      <button class="btn" ${locked ? 'disabled' : ''} onclick="generateOne()">生成完整图文</button>
      <button class="btn ghost" ${locked ? 'disabled' : ''} onclick="generateWeek()">生成本周3篇</button>
    </div>
    <div id="chatProgress" class="progress hidden">准备中…</div>
    <div id="streamOut" class="safe-text"></div>
    <div id="produceOut">${state.lastStructured && state.lastStructured.items ? renderStructured(state.lastStructured) : ''}</div>
  `;
}

async function generateOne() {
  const msg = val('prod_msg') || '写一篇香港公司年审避坑的小红书，只生成一篇。';
  await runGenerate(msg);
}

async function generateWeek() {
  await runGenerate('生成本周3篇香港MSO内容。');
}

async function runGenerate(message) {
  lastCommand = message;
  page = page === 'topics' ? 'topics' : 'produce';
  chatBusy = true;
  chatAbort = new AbortController();
  const bot = { role: 'bot', text: '', time: whenFull(new Date().toISOString()), streaming: true, html: '<div id="streamOut" class="safe-text"></div>' };
  state.chatLog.push({ role: 'user', text: message, time: bot.time });
  state.chatLog.push(bot);
  draw();
  setProgress('正在准备资料…');
  busy(true, '正在生成');
  try {
    await runStreamChat(message, bot);
    draw();
  } catch (e) {
    toast((e && e.message) || '生成失败', true);
    draw();
  } finally {
    chatBusy = false;
    chatAbort = null;
    busy(false);
  }
}

function viewSchedule() {
  const items = state.contents || [];
  const series = val('sch_filter') || '';
  const rows = items.filter((it) => !series || (it.businessCategory || '') === series);
  return `
    <h1>内容排期</h1>
    <p class="lead">清晰列表，不使用复杂月历。</p>
    <div class="field narrow"><label>筛选业务</label><select id="sch_filter" onchange="draw()"><option value="">全部</option>${seriesOptions()}</select></div>
    <div class="schedule-table-wrap"><table class="schedule-table">
      <thead><tr><th>发布日期</th><th>业务系列</th><th>主题</th><th>封面标题</th><th>类型</th><th>目标客户</th><th>文案</th><th>海报</th></tr></thead>
      <tbody>${rows.map((it) => `<tr>
        <td class="col-date">${esc(formatDateZh((it.publishAt || '').slice(0,10)) || it.publishAt || '')}</td>
        <td>${esc(it.businessCategory || '')}</td>
        <td>${esc(it.topic || '')}</td>
        <td class="col-title">${esc(it.title || '')}</td>
        <td>${esc(it.purpose || it.type || '')}</td>
        <td>${esc(it.audience || '')}</td>
        <td>${it.body ? '已有' : '待写'}</td>
        <td>${it.posterUrl ? '已有' : '待做'}</td>
      </tr>`).join('') || '<tr><td colspan="8">还没有排期。请先生成主题并保存。</td></tr>'}</tbody>
    </table></div>
    <div class="schedule-cards">${rows.map((it) => `<article class="result-card">
      <div class="kicker">${esc(formatDateZh((it.publishAt || '').slice(0,10)))}</div>
      <h3>${esc(it.title || '')}</h3>
      <p>${esc(it.businessCategory || '')} · ${esc(it.audience || '')}</p>
      <div class="result-actions"><button class="btn ghost small" onclick="openContent('${it.id}')">查看</button></div>
    </article>`).join('')}</div>
    <div class="result-actions">
      <button class="btn ghost" onclick="exportSchedulePdf()">导出排期PDF</button>
      <button class="btn ghost" onclick="exportPostsPdf()">导出文案合集PDF</button>
    </div>
  `;
}

function viewReports() {
  return `
    <h1>成果导出</h1>
    <p class="lead">给运营同事的成品是PDF和海报，不是JSON。</p>
    <div class="dna-grid">
      <article class="result-card"><h3>账号风格分析报告</h3><button class="btn" onclick="exportStylePdf()">导出PDF</button></article>
      <article class="result-card"><h3>海报视觉规律报告</h3><button class="btn" onclick="exportVisualPdf()">导出PDF</button></article>
      <article class="result-card"><h3>未来4周内容排期</h3><button class="btn" onclick="exportSchedulePdf()">导出PDF</button></article>
      <article class="result-card"><h3>小红书文案合集</h3><button class="btn" onclick="exportPostsPdf()">导出PDF</button></article>
      <article class="result-card"><h3>单篇图文</h3><button class="btn" onclick="exportDraftPdf()">导出当前草稿PDF</button></article>
      <article class="result-card"><h3>海报PNG</h3><button class="btn" onclick="go('produce')">去图文生成下载</button></article>
    </div>
  `;
}

async function exportStylePdf() {
  const f = (state.dna && state.dna.fields) || {};
  const rows = Object.keys(f).map((k) => `<h3>${esc(k)}</h3><p>${esc(f[k] || '')}</p>`).join('');
  await downloadPdf(wrapPdf('CPLUS账号风格分析报告', rows || '<p>请先完成风格分析。</p>'), 'CPLUS-风格分析.pdf');
}
async function exportVisualPdf() {
  const v = (state.dna && state.dna.visual) || {};
  const rows = Object.keys(v).map((k) => `<h3>${esc(k)}</h3><p>${esc(v[k] || '')}</p>`).join('');
  await downloadPdf(wrapPdf('CPLUS海报视觉规律分析报告', rows || '<p>请先完成风格分析。</p>'), 'CPLUS-海报规律.pdf');
}
async function exportSchedulePdf() {
  const items = (state.lastStructured && state.lastStructured.items) || state.contents || [];
  const table = `<table><thead><tr><th>日期</th><th>标题</th><th>客户</th></tr></thead><tbody>${
    items.map((it) => `<tr><td>${esc(it.publishAt || '')}</td><td>${esc(it.title || '')}</td><td>${esc(it.audience || '')}</td></tr>`).join('')
  }</tbody></table>`;
  await downloadPdf(wrapPdf('未来4周内容排期', table), 'CPLUS-排期.pdf');
}
async function exportPostsPdf() {
  const items = (state.contents || []).filter((c) => c.body);
  const html = items.map((it) => `<h2>${esc(it.title || '')}</h2><p>${esc(it.body || '').replace(/\n/g, '<br>')}</p>`).join('');
  await downloadPdf(wrapPdf('本周小红书文案合集', html || '<p>还没有成稿。</p>'), 'CPLUS-文案合集.pdf');
}

async function refreshReady() {
  try {
    const b = await api('/api/bootstrap');
    state.readiness = b.readiness || state.readiness;
    state.dna = b.dna || state.dna;
    state.series = b.series || state.series;
    state.me = { mode: b.mode, serviceAvailable: !!b.serviceAvailable };
  } catch (e) {}
}

const _runStreamChat = runStreamChat;
runStreamChat = async function (message, bot) {
  setProgress('正在生成内容…');
  const res = await fetch('/api/agent/chat/stream', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, generalMode: !!state.generalMode }),
    signal: chatAbort && chatAbort.signal
  });
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '请先完成资料准备');
  }
  if (!res.ok || !res.body) {
    let data = {};
    try { data = await res.json(); } catch (e) {}
    throw new Error(data.error || '请求失败');
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let full = '';
  let structured = null;
  let gotDone = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() || '';
    chunks.forEach((block) => {
      const ev = (block.match(/^event: (.+)$/m) || [])[1];
      const dataLine = (block.match(/^data: ([\s\S]+)$/m) || [])[1];
      if (!ev || !dataLine) return;
      let data = {};
      try { data = JSON.parse(dataLine); } catch (e) { return; }
      if (ev === 'status' && data.text) setProgress(data.text);
      if (ev === 'delta' && data.text) {
        const piece = cleanVisibleText(data.text);
        if (!piece || looksLikeJsonDump(piece)) return;
        full += piece;
        const out = document.getElementById('streamOut');
        if (out) out.textContent = cleanVisibleText(full);
      }
      if (ev === 'structured' && data.items) structured = data;
      if (ev === 'error') throw new Error(data.error || '生成失败');
      if (ev === 'done') gotDone = true;
    });
  }
  if (!gotDone && !structured && !cleanVisibleText(full)) throw new Error('结果整理失败，请重新生成');
  finishBot(bot, { reply: full, structured: structured });
  toast('已生成');
};
