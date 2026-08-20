state.readiness = state.readiness || { status: '尚未上传资料', facts: 0, captions: 0, posters: 0, analyzed: false, confirmed: false, canGenerate: false, stale: false };
state.dna = state.dna || { fields: {}, confirmed: false };
state.series = state.series || [];
state.generalMode = false;
state.topics = state.topics || [];
state.expanded = state.expanded || {};
state.advancedOpen = false;
const FLOW_PAGES = ['learn', 'studio', 'results', 'home', 'facts', 'samples', 'style', 'rules', 'topics', 'produce', 'schedule', 'reports'];

function paintChrome() {
  const foot = document.getElementById('sideFoot');
  if (foot) foot.innerHTML = '';
  const top = document.getElementById('topActions');
  if (top) top.innerHTML = '';
}

function lockNote() {
  const r = state.readiness || {};
  if (r.canGenerate) return '';
  if (r.stale) return `<div class="warn">资料已变更，旧分析已失效。请重新分析并确认后再生成正式内容。</div>`;
  if (r.facts < 1) return `<div class="warn">现有资料不足，无法生成正式内容。请先到学习中心上传业务资料。</div>`;
  if (r.captions < 3) return `<div class="warn">风格样本不足。请至少上传3篇历史文案。没有海报时仍可生成文案，但不会使用历史海报风格。</div>`;
  if (!r.analyzed || !r.confirmed) return `<div class="warn">请先完成风格分析并确认。</div>`;
  return '';
}

function viewLearn() {
  const r = state.readiness || {};
  const d = state.dna || {};
  const f = d.fields || {};
  const items = state.knowledge || [];
  const feed = state.feed || [];
  const copy = d.copy || {};
  const visual = d.visual || {};
  return `
    <h1>AI学习中心</h1>
    <p class="lead">先上传CPLUS业务资料和历史内容。AI将学习业务事实、语言风格、正文结构、Hashtag及海报排版规律。</p>
    <p class="ready-meta">${esc(r.status || '尚未上传资料')} · 业务资料 ${r.facts || 0} 份 · 历史文案 ${r.captions || 0} 篇 · 海报 ${r.posters || 0} 张</p>
    <section class="panel drop-zone" id="dropZone">
      <h2>上传资料</h2>
      <p>把文件拖到这里，或点选。可一次选多个：PDF / Word / Excel / 文案 / 海报。系统会自动判断类型。</p>
      <input id="batchFiles" type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.png,.jpg,.jpeg,.webp">
      <div class="field"><label>也可直接粘贴文案或网页文字</label><textarea id="pasteText" rows="4" placeholder="小红书Caption、公众号段落或网址说明"></textarea></div>
      <div class="result-actions">
        <button class="btn" onclick="uploadBatch()">上传并识别</button>
      </div>
    </section>
    <section>
      <h2>已学习的资料</h2>
      ${renderLearnItems(items, feed)}
    </section>
    <div class="result-actions">
      <button class="btn" onclick="runStyleAnalyze()" ${r.canAnalyze ? '' : 'disabled'}>分析CPLUS账号风格</button>
    </div>
    <div id="analyzeProgress" class="progress hidden"></div>
    ${d.analyzedAt && !r.stale ? renderStyleSummary(d, copy, visual, r) : (r.stale ? `<div class="warn">旧分析已失效，请重新分析。</div>` : '')}
  `;
}

function parseStatusLabel(k) {
  if (k.status === 'parsing' || k.status === 'uploading') return '正在解析';
  if (k.status === 'ocr') return '正在OCR';
  if (k.status === 'failed' || !(k.charCount > 0)) return '识别失败';
  if (k.needsConfirm) return '需要用户确认类型';
  return '识别成功';
}

function renderLearnItems(items, feed) {
  const cards = [];
  items.forEach((k) => {
    const failed = k.status === 'failed' || !(k.charCount > 0) && (k.status === 'ok' || !k.status);
    cards.push(`<article class="result-card">
      <h3>${esc(k.name)}</h3>
      <p>${esc(k.label || '待识别')} · ${esc(parseStatusLabel(k))}</p>
      <p>页数 ${esc(k.pageCount || '-')} · 提取 ${esc(k.charCount || 0)} 字 · 事实 ${esc(k.factCount || 0)} 条</p>
      ${k.titles && k.titles.length ? `<p>标题：${esc(k.titles.slice(0,3).join(' / '))}</p>` : ''}
      ${k.parseError ? `<div class="warn">${esc(k.parseError)}</div>` : ''}
      ${k.ocrNote ? `<p class="hint">${esc(k.ocrNote)}</p>` : ''}
      <div class="result-actions">
        <button class="btn ghost small" onclick="viewExtract('${k.id}')">查看识别结果</button>
        <button class="btn quiet small" onclick="delKnowledge('${k.id}')">删除</button>
      </div>
    </article>`);
  });
  feed.forEach((f) => {
    cards.push(`<article class="result-card">
      ${f.images && f.images[0] && f.images[0].url ? `<img src="${esc(f.images[0].url)}" alt="" style="width:96px;border-radius:8px">` : ''}
      <h3>${esc((f.caption || '').split('\n')[0].slice(0, 32) || '历史帖子')}</h3>
      <p>历史帖子（文案${f.images && f.images.length ? '+海报' : ''}）</p>
      <p>${esc((f.caption || '').slice(0, 140))}</p>
      <div class="result-actions"><button class="btn quiet small" onclick="delFeed('${f.id}')">删除</button></div>
    </article>`);
  });
  return cards.join('') || '<div class="empty">还没有资料。把文件拖进来即可。</div>';
}

function renderStyleSummary(d, copy, visual, r) {
  const f = d.fields || {};
  const ev = d.evidence || {};
  const rows = [
    ['账号定位', f.positioning],
    ['目标客户', f.audience],
    ['品牌语气', f.tone],
    ['标题规律', f.titleFormula || ('平均' + (copy.titleLen || '-') + '字（依据' + (copy.n || ev.captions || 0) + '篇文案）')],
    ['开场规律', f.hookFormula],
    ['正文结构', f.bodyStructure || ('平均' + (copy.avgChars || '-') + '字，约' + (copy.avgParas || '-') + '段')],
    ['CTA规律', f.ctaRule],
    ['Hashtag规律', f.hashtagRule || copy.hashtags],
    ['视觉规律', (visual && visual.insufficient) ? '尚未上传海报，无法分析视觉风格。' : f.posterLayout],
    ['推荐内容比例', f.mix],
    ['禁用表达', f.banned]
  ];
  return `<section class="panel">
    <h2>CPLUS账号风格摘要</h2>
    <p class="hint">标题平均字数 ${esc(copy.titleLen || '-')} · 正文平均 ${esc(copy.avgChars || '-')} 字 · 依据 ${esc(String(copy.n || ev.captions || 0))} 篇历史Caption · 置信度 ${Number(copy.n) >= 5 ? '高' : (Number(copy.n) >= 3 ? '中' : '低')}</p>
    ${visual && visual.insufficient ? `<div class="warn">尚未上传海报，无法分析视觉风格。如需专属海报风格，请至少再上传3张历史海报。</div>` : ''}
    ${rows.map(([lab, val]) => val ? `<div class="field-line"><span>${esc(lab)}</span>${esc(val)}</div>` : '').join('')}
    <div class="result-actions">
      <button class="btn" onclick="confirmDna()">确认并开始创作</button>
      <button class="btn ghost" onclick="runStyleAnalyze()">重新分析</button>
      <button class="btn quiet" onclick="state.advancedOpen=!state.advancedOpen; draw()">${state.advancedOpen ? '收起高级修改' : '高级修改'}</button>
    </div>
    ${state.advancedOpen ? renderAdvanced() : ''}
  </section>`;
}

function renderAdvanced() {
  const f = (state.dna && state.dna.fields) || {};
  return `<div class="panel" style="margin-top:12px">${[
    ['positioning', '账号定位'], ['audience', '目标客户'], ['tone', '品牌语气'],
    ['titleFormula', '标题规律'], ['hookFormula', '开场规律'], ['bodyStructure', '正文结构'],
    ['ctaRule', 'CTA'], ['hashtagRule', 'Hashtag'], ['banned', '禁用表达']
  ].map(([k, lab]) => `<div class="field"><label>${esc(lab)}</label><textarea id="dna_${k}" rows="2">${esc(f[k] || '')}</textarea></div>`).join('')}
  <button class="btn ghost" onclick="saveDnaFields()">保存修改</button></div>`;
}

async function uploadBatch() {
  const input = document.getElementById('batchFiles');
  const files = input && input.files ? [...input.files] : [];
  const paste = val('pasteText');
  if (!files.length && !paste) { toast('请选择文件或粘贴文字', true); return; }
  busy(true, '正在上传');
  try {
    for (const file of files) {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const res = await fetch('/api/knowledge/upload', { method: 'POST', body: fd, credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '上传失败');
      if (/^image\//.test(file.type)) {
        const dataUrl = await readFileData(file);
        await post('/api/feed', [{ caption: paste || file.name, images: [{ name: file.name, mime: file.type, dataUrl }] }]);
      }
    }
    if (paste && !files.length) {
      const fd = new FormData();
      fd.append('text', paste);
      const res = await fetch('/api/knowledge/upload', { method: 'POST', body: fd, credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '上传失败');
      if ((paste.match(/#/g) || []).length >= 2) await post('/api/feed', [{ caption: paste }]);
    }
    toast('已开始解析，请稍候查看识别结果');
    await pollKnowledge();
  } catch (e) { toast(e.message, true); }
  finally { busy(false); }
}

async function pollKnowledge() {
  for (let i = 0; i < 45; i++) {
    const d = await api('/api/knowledge').catch(() => ({ items: [] }));
    state.knowledge = d.items || [];
    draw();
    const pending = (d.items || []).some((k) => k.status === 'parsing' || k.status === 'ocr' || k.status === 'uploading');
    if (!pending) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  await reloadLearn();
}

async function viewExtract(id) {
  const d = await api('/api/knowledge/' + id + '/preview');
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  sheet.classList.remove('hidden');
  sheet.innerHTML = `<div class="sheet-card" onclick="event.stopPropagation()">
    <h2>${esc(d.name)}</h2>
    <p>${esc(d.label || '')} · ${esc(d.status)} · ${esc(d.charCount)} 字 · ${esc(d.pageCount)} 页</p>
    ${d.parseError ? `<div class="warn">${esc(d.parseError)}</div>` : ''}
    <h3>标题</h3><p>${esc((d.titles || []).join(' / ') || '无')}</p>
    <h3>业务事实</h3>${(d.facts || []).slice(0, 8).map((f) => `<p>${esc(f.content || f)} <span class="hint">p.${esc(f.page || '')}</span></p>`).join('') || '<p>无</p>'}
    <h3>正文预览</h3>
    <div class="safe-text">${esc((d.preview || '').slice(0, 1800))}</div>
    <button class="btn" onclick="closeSheet()">关闭</button>
  </div>`;
  sheet.onclick = closeSheet;
}

async function reloadLearn() {
  const [k, f, b] = await Promise.all([
    api('/api/knowledge').catch(() => ({ items: [] })),
    api('/api/feed').catch(() => ({ items: [] })),
    api('/api/bootstrap').catch(() => ({}))
  ]);
  state.knowledge = k.items || [];
  state.feed = f.items || [];
  if (b.readiness) state.readiness = b.readiness;
  if (b.dna) state.dna = b.dna;
  draw();
}

async function delFeed(id) {
  if (!confirm('删除这条历史帖子？')) return;
  await del('/api/feed/' + id);
  await reloadLearn();
}

async function runStyleAnalyze() {
  const box = document.getElementById('analyzeProgress');
  const steps = ['正在读取资料', '正在提取业务事实', '正在分析文案结构', '正在分析Hashtag', '正在分析海报版式', '正在整理分析结果'];
  if (box) { box.classList.remove('hidden'); box.textContent = steps[0]; }
  let i = 0;
  const t = setInterval(() => {
    i = Math.min(i + 1, steps.length - 1);
    if (box) box.textContent = steps[i];
  }, 2500);
  busy(true, '正在分析');
  try {
    const res = await post('/api/dna/analyze', {});
    state.dna = res.dna;
    state.readiness = res.readiness || state.readiness;
    draw();
    toast('分析完成，请确认后开始创作');
  } catch (e) { toast(e.message, true); }
  finally { clearInterval(t); busy(false); }
}

async function saveDnaFields() {
  const fields = {};
  ['positioning','audience','tone','titleFormula','hookFormula','bodyStructure','ctaRule','hashtagRule','banned'].forEach((k) => {
    const el = document.getElementById('dna_' + k);
    if (el) fields[k] = el.value;
  });
  const res = await post('/api/dna', { fields });
  state.dna = res.dna;
  toast('已保存');
}

async function confirmDna() {
  if (state.advancedOpen) await saveDnaFields();
  const res = await post('/api/dna/confirm', {});
  state.dna = res.dna;
  state.readiness = res.readiness || state.readiness;
  toast('已确认，可以开始创作');
  go('studio');
}

function viewStudio() {
  const r = state.readiness || {};
  const topics = state.topics || [];
  return `
    <h1>内容制作中心</h1>
    <p class="lead">用一句话说本月重点。AI根据已学习的资料和风格生成主题，再直接在卡片里写成文案和海报。</p>
    ${lockNote()}
    ${!r.canAnalyzeVisual && r.canGenerate ? `<p class="hint">未上传足够海报，将使用通用模板海报，不会冒充CPLUS历史海报风格。</p>` : ''}
    <div class="field"><textarea id="studio_msg" rows="3" placeholder="例如：下个月重点推广香港公司注册和MSO，每周3篇。">${esc(lastCommand || '')}</textarea></div>
    <div class="result-actions">
      <button class="btn" ${r.canGenerate || state.generalMode ? '' : 'disabled'} onclick="planStudio()">生成主题规划</button>
      ${!r.canGenerate ? `<button class="btn quiet" onclick="state.generalMode=true; toast('测试稿不会当作正式内容'); planStudio()">仅测试</button>` : ''}
      ${topics.length ? `<button class="btn ghost" onclick="exportSchedulePdf()">导出排期PDF</button>` : ''}
    </div>
    <div id="chatProgress" class="progress hidden"></div>
    <div id="topicList">${topics.map((it, i) => topicCard(it, i)).join('')}</div>
  `;
}

function topicCard(it, i) {
  const exp = state.expanded[i];
  return `<article class="result-card topic-card" id="topic-${i}">
    <div class="kicker">${esc(formatDateZh(it.publishAt) || it.publishAt || '')} · ${esc(it.contentType || it.type || '')}</div>
    <h3>${esc(it.title || '')}</h3>
    ${it.audience ? `<p>目标客户：${esc(it.audience)}</p>` : ''}
    ${it.pain ? `<p>角度：${esc(it.pain)}</p>` : ''}
    ${it.sourcesText ? `<p>参考资料：${esc(it.sourcesText)}</p>` : ''}
    <div class="result-actions">
      <button class="btn" onclick="generateThis(${i})">生成这篇</button>
      <button class="btn quiet small" onclick="removeTopic(${i})">删除</button>
    </div>
    ${exp ? renderInlinePost(exp, i) : ''}
  </article>`;
}

function renderInlinePost(item, i) {
  const body = cleanVisibleText(item.body || '');
  const poster = item.posterDataUrl;
  return `<div class="inline-post">
    ${item.title ? `<h3>${esc(item.title)}</h3>` : ''}
    ${item.subtitle ? `<p class="points">${esc(item.subtitle)}</p>` : ''}
    ${body ? `<div class="safe-text">${esc(body)}</div>` : ''}
    ${item.cta ? `<p class="cta">${esc(item.cta)}</p>` : ''}
    ${item.hashtags ? `<p class="tags">${esc(item.hashtags)}</p>` : ''}
    ${item.sourcesText ? `<p>参考资料：${esc(item.sourcesText)}</p>` : ''}
    ${item.pendingConfirm ? `<p>待人工确认：${esc(item.pendingConfirm)}</p>` : ''}
    ${poster ? `<img class="poster-preview" src="${esc(poster)}" alt="海报预览">` : ''}
    <div class="result-actions">
      <button class="btn ghost small" onclick="copyCaption(${i})">复制Caption</button>
      <button class="btn quiet small" onclick="rewriteInline(${i},'title')">重写标题</button>
      <button class="btn quiet small" onclick="rewriteInline(${i},'body')">缩短正文</button>
      <button class="btn quiet small" onclick="downloadInlinePoster(${i})">下载PNG</button>
      <button class="btn quiet small" onclick="saveInline(${i})">保存到成果中心</button>
    </div>
  </div>`;
}

async function planStudio() {
  const message = val('studio_msg') || '生成未来4周的小红书内容排期，每周3篇。';
  lastCommand = message;
  chatBusy = true;
  chatAbort = new AbortController();
  const bot = { role: 'bot', text: '', html: '', time: whenFull(new Date().toISOString()) };
  busy(true, '正在规划主题');
  setProgress('正在规划主题…');
  try {
    await runStreamChat(message, bot);
    const items = (state.lastStructured && state.lastStructured.items) || [];
    state.topics = items;
    state.expanded = {};
    draw();
  } catch (e) { toast(e.message, true); }
  finally { chatBusy = false; chatAbort = null; busy(false); }
}

async function generateThis(i) {
  const it = state.topics[i];
  if (!it) return;
  const msg = '写一篇小红书，只生成一篇。封面标题：' + (it.title || '') + '。目标客户：' + (it.audience || '') + '。内容类型：' + (it.contentType || '') + '。角度：' + (it.pain || '');
  chatBusy = true;
  chatAbort = new AbortController();
  const bot = { role: 'bot', text: '', html: '<div id="streamOut" class="safe-text"></div>', time: '' };
  busy(true, '正在生成这篇');
  try {
    await runStreamChat(msg, bot);
    const item = (state.lastStructured && state.lastStructured.items && state.lastStructured.items[0]) || {};
    item.posterDataUrl = makePosterDataUrl(item);
    state.expanded[i] = item;
    lastResult = [item.body, item.cta, item.hashtags].filter(Boolean).join('\n\n');
    draw();
  } catch (e) { toast(e.message, true); }
  finally { chatBusy = false; chatAbort = null; busy(false); }
}

function removeTopic(i) {
  state.topics.splice(i, 1);
  delete state.expanded[i];
  draw();
}

function copyCaption(i) {
  const it = state.expanded[i];
  if (!it) return;
  copy([it.body, it.cta, it.hashtags].filter(Boolean).join('\n\n'));
  toast('已复制Caption');
}

function downloadInlinePoster(i) {
  const it = state.expanded[i];
  if (!it || !it.posterDataUrl) { toast('请先生成这篇', true); return; }
  const a = document.createElement('a');
  a.href = it.posterDataUrl;
  a.download = 'CPLUS-' + (it.title || 'poster').slice(0, 18) + '.png';
  a.click();
}

async function saveInline(i) {
  const it = state.expanded[i];
  if (!it) return;
  try {
    const saved = await post('/api/contents', {
      title: it.title,
      subtitle: it.subtitle,
      body: it.body,
      cta: it.cta,
      hashtags: it.hashtags,
      audience: it.audience,
      purpose: it.purpose,
      publishAt: (state.topics[i] && state.topics[i].publishAt) || '',
      businessCategory: it.contentType,
      topic: it.title,
      status: 'Draft'
    });
    if (it.posterDataUrl && saved.item) {
      await post('/api/contents/' + saved.item.id + '/poster', { dataUrl: it.posterDataUrl });
    }
    toast('已保存到成果中心');
  } catch (e) { toast(e.message, true); }
}

async function rewriteInline(i, field) {
  const it = state.expanded[i];
  if (!it) return;
  const current = field === 'title' ? it.title : it.body;
  const res = await post('/api/agent/rewrite', { field, instruction: field === 'body' ? '缩短正文，去掉重复CTA和标签' : '重写标题', current });
  if (field === 'title') it.title = cleanVisibleText(res.reply).split('\n')[0];
  else it.body = cleanVisibleText(res.reply);
  it.posterDataUrl = makePosterDataUrl(it);
  draw();
}

function makePosterDataUrl(item) {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const g = canvas.getContext('2d');
  const W = 1080, H = 1350;
  g.fillStyle = '#f4f7fb';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#1a4b8c';
  g.fillRect(0, 0, W, 210);
  g.fillStyle = '#c4a35a';
  g.fillRect(0, 210, W, 8);
  g.fillStyle = '#fff';
  g.font = '600 28px "PingFang SC", sans-serif';
  g.fillText('CPLUS GROUP', 56, 70);
  g.font = '20px "PingFang SC", sans-serif';
  g.fillText('全球业务，合规先行', 56, 110);
  g.fillStyle = '#10263f';
  wrapText(g, item.title || '封面标题', 56, 320, W - 112, 58, '700 48px "PingFang SC", sans-serif');
  const pts = String(item.subtitle || item.points || '').split(/\n|；|;|、/).filter(Boolean).slice(0, 3);
  pts.forEach((p, idx) => {
    g.fillStyle = '#1a4b8c';
    g.fillRect(56, 640 + idx * 120, 10, 70);
    g.fillStyle = '#10263f';
    g.font = '32px "PingFang SC", sans-serif';
    wrapText(g, String(p), 84, 688 + idx * 110, W - 160, 40, '32px "PingFang SC", sans-serif');
  });
  g.fillStyle = '#1a4b8c';
  g.font = '22px "PingFang SC", sans-serif';
  g.fillText('CPLUS', 56, H - 70);
  return canvas.toDataURL('image/png');
}

function viewResults() {
  const items = state.contents || [];
  return `
    <h1>成果中心</h1>
    <p class="lead">已保存的文案、海报和排期。导出PDF或PNG给同事使用。</p>
    <div class="schedule-table-wrap"><table class="schedule-table">
      <thead><tr><th>发布日期</th><th>业务</th><th>封面标题</th><th>文案</th><th>海报</th><th></th></tr></thead>
      <tbody>${items.map((it) => `<tr>
        <td class="col-date">${esc((it.publishAt || '').slice(0,10))}</td>
        <td>${esc(it.businessCategory || '')}</td>
        <td class="col-title">${esc(it.title || '')}</td>
        <td>${it.body ? '已有' : '待写'}</td>
        <td>${it.posterUrl ? '已有' : '待做'}</td>
        <td><button class="btn quiet small" onclick="openContent('${it.id}')">查看</button></td>
      </tr>`).join('') || '<tr><td colspan="6">还没有成果。请先在内容制作中心生成并保存。</td></tr>'}</tbody>
    </table></div>
    <div class="schedule-cards">${items.map((it) => `<article class="result-card">
      <h3>${esc(it.title || '')}</h3>
      <p>${esc((it.publishAt || '').slice(0,10))} · ${esc(it.businessCategory || '')}</p>
      <button class="btn ghost small" onclick="openContent('${it.id}')">查看</button>
    </article>`).join('')}</div>
    <div class="result-actions">
      <button class="btn" ${items.length ? '' : 'disabled'} onclick="exportSchedulePdf()">导出排期PDF</button>
      <button class="btn ghost" ${items.some((i) => i.body) ? '' : 'disabled'} onclick="exportPostsPdf()">导出文案合集PDF</button>
      <button class="btn ghost" ${state.dna && state.dna.analyzedAt ? '' : 'disabled'} onclick="exportStylePdf()">导出风格分析PDF</button>
    </div>
  `;
}

async function exportStylePdf() {
  const f = (state.dna && state.dna.fields) || {};
  if (!Object.values(f).some(Boolean)) { toast('还没有可导出的分析', true); return; }
  const rows = Object.keys(f).map((k) => `<h3>${esc(k)}</h3><p>${esc(f[k] || '')}</p>`).join('');
  await downloadPdf(wrapPdf('CPLUS账号风格分析报告', rows), 'CPLUS-风格分析.pdf');
}
async function exportVisualPdf() {
  const v = (state.dna && state.dna.visual) || {};
  if (v.insufficient) { toast('海报样本不足，不能导出视觉分析', true); return; }
  const rows = Object.keys(v).map((k) => `<h3>${esc(k)}</h3><p>${esc(String(v[k] || ''))}</p>`).join('');
  await downloadPdf(wrapPdf('CPLUS海报视觉规律分析报告', rows || '<p>暂无</p>'), 'CPLUS-海报规律.pdf');
}
async function exportSchedulePdf() {
  const items = state.topics.length ? state.topics : (state.contents || []);
  if (!items.length) { toast('没有可导出的排期', true); return; }
  const table = `<table><thead><tr><th>日期</th><th>类型</th><th>标题</th></tr></thead><tbody>${
    items.map((it) => `<tr><td>${esc(it.publishAt || '')}</td><td>${esc(it.contentType || '')}</td><td>${esc(it.title || '')}</td></tr>`).join('')
  }</tbody></table>`;
  await downloadPdf(wrapPdf('未来4周内容排期', table), 'CPLUS-排期.pdf');
}
async function exportPostsPdf() {
  const items = (state.contents || []).filter((c) => c.body);
  if (!items.length) { toast('没有可导出的文案', true); return; }
  const html = items.map((it) => `<h2>${esc(it.title || '')}</h2><p>${esc(it.body || '').replace(/\n/g, '<br>')}</p>`).join('');
  await downloadPdf(wrapPdf('小红书文案合集', html), 'CPLUS-文案合集.pdf');
}

async function refreshReady() {
  try {
    const b = await api('/api/bootstrap');
    state.readiness = b.readiness || state.readiness;
    state.dna = Object.assign({}, state.dna, b.dna || {});
    state.series = b.series || state.series;
    state.me = { mode: b.mode, serviceAvailable: !!b.serviceAvailable };
  } catch (e) {}
}

const _runStreamChat = typeof runStreamChat === 'function' ? runStreamChat : null;
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
    throw new Error(data.error || '请先完成资料学习');
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
};

function viewHome() { return viewLearn(); }
function viewFacts() { return viewLearn(); }
function viewSamples() { return viewLearn(); }
function viewStyle() { return viewLearn(); }
function viewRules() { return viewLearn(); }
function viewTopics() { return viewStudio(); }
function viewProduce() { return viewStudio(); }
function viewSchedule() { return viewResults(); }
function viewReports() { return viewResults(); }
function enableGeneralMode() { state.generalMode = true; toast('测试稿不会当作正式内容'); draw(); }
