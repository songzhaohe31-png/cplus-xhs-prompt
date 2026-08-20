const state = {
  rules: null,
  materials: [],
  schedules: [],
  posts: [],
  feed: [],
  style: { count: 0, captionCount: 0, avgChars: 0, tags: [], hooks: [], ratings: { good: 0, ok: 0, bad: 0 } },
  settings: null
};

let page = 'produce';
let rulesDirty = false;
let saveTimer = null;
let lastSavedAt = null;
let lastBrief = '';
let lastCommand = '';
let lastResult = '';
let previewIdb = null;

const composer = {
  images: [],
  caption: '',
  rating: '',
  note: ''
};

const RULE_FIELDS = [
  'accountPosition', 'targetAudience', 'persona', 'coverTitleStyle', 'coverTitleMaxLength',
  'bodyStructure', 'writingStyle', 'wordCountMin', 'wordCountMax', 'imageSuggestions',
  'tagRule', 'prohibitions', 'materialConstraint'
];

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options
  });
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) {
    const err = new Error(data.error || '请求失败');
    err.status = res.status;
    err.code = data.code;
    err.body = data;
    throw err;
  }
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

function localFeed() {
  try {
    const raw = localStorage.getItem('cplus_feed');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function rememberFeed(items) {
  state.feed = items;
  try {
    const slim = items.map((item) => ({
      ...item,
      images: (item.images || []).map((img, i) => ({
        name: img.name || String(i),
        mime: img.mime || 'image/jpeg',
        url: img.url || '',
        preview: img.preview || ''
      }))
    }));
    localStorage.setItem('cplus_feed', JSON.stringify(slim));
  } catch (e) {
    try {
      const slimmer = items.map((item) => ({
        ...item,
        images: (item.images || []).map((img) => ({
          name: img.name,
          mime: img.mime,
          url: img.url || ''
        }))
      }));
      localStorage.setItem('cplus_feed', JSON.stringify(slimmer));
    } catch (err) { /* ignore quota */ }
  }
}

function mergeById(a, b) {
  const map = new Map();
  [...a, ...b].forEach((item) => {
    if (!item || !item.id) return;
    const prev = map.get(item.id) || {};
    map.set(item.id, {
      ...prev,
      ...item,
      images: (item.images && item.images.length) ? item.images : (prev.images || [])
    });
  });
  return [...map.values()].sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')));
}

function openIdb() {
  if (previewIdb) return previewIdb;
  previewIdb = new Promise((resolve, reject) => {
    const req = indexedDB.open('cplus-xhs', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('previews')) db.createObjectStore('previews');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return previewIdb;
}

async function idbSet(key, value) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('previews', 'readwrite');
      tx.objectStore('previews').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* ignore */ }
}

async function idbGet(key) {
  try {
    const db = await openIdb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('previews', 'readonly');
      const req = tx.objectStore('previews').get(key);
      req.onsuccess = () => resolve(req.result || '');
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return '';
  }
}

async function idbDel(key) {
  try {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('previews', 'readwrite');
      tx.objectStore('previews').delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* ignore */ }
}

function coverSrc(item, index) {
  const img = (item.images || [])[index || 0];
  if (!img) return '';
  return img.preview || img.dataUrl || img.url || '';
}

async function hydratePreviews(items) {
  const next = [];
  for (const item of items) {
    const images = [];
    for (let i = 0; i < (item.images || []).length; i++) {
      const img = item.images[i];
      let preview = img.preview || img.dataUrl || '';
      if (!preview) preview = await idbGet(item.id + ':' + i);
      images.push({ ...img, preview });
    }
    next.push({ ...item, images });
  }
  return next;
}

function compressFile(file, maxW = 1400, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片无法读取'));
    };
    img.src = url;
  });
}

async function go(name) {
  if (page === 'feed') stashComposer();
  if (page === 'rules' && name !== 'rules' && rulesDirty) {
    await saveRules(false);
  }
  page = name;
  const url = new URL(location.href);
  url.searchParams.set('p', name);
  history.replaceState(null, '', url);
  document.querySelectorAll('.steps button, .nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.page === name);
  });
  draw();
  window.scrollTo(0, 0);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src && s.src.indexOf(src) >= 0)) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => reject(new Error('脚本加载失败'));
    document.body.appendChild(el);
  });
}

function loadPdfLibs() {
  if (window.html2canvas && window.jspdf) return Promise.resolve();
  return Promise.all([
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'),
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
  ]);
}

async function boot() {
  state.rules = state.rules || {};
  state.materials = state.materials || [];
  state.schedules = state.schedules || [];
  state.posts = state.posts || [];
  state.feed = state.feed || [];
  state.settings = state.settings || {};
  const asked = new URLSearchParams(location.search).get('p');
  const allowed = ['learn', 'studio', 'results', 'home', 'facts', 'samples', 'style', 'rules', 'topics', 'produce', 'schedule', 'reports', 'chat', 'calendar', 'review', 'knowledge', 'library', 'history', 'generate'];
  page = allowed.includes(asked) ? asked : 'learn';
  draw();
}

function analyzeLocal(items) {
  const caps = (items || []).map((i) => i.caption || '').filter(Boolean);
  const tagCount = {};
  caps.forEach((c) => {
    (c.match(/#[^\s#]+/g) || []).forEach((t) => {
      tagCount[t] = (tagCount[t] || 0) + 1;
    });
  });
  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([tag, n]) => ({ tag, n }));
  const hooks = caps.map((c) => c.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ｜ ')).filter(Boolean).slice(0, 10);
  const ratings = { good: 0, ok: 0, bad: 0 };
  (items || []).forEach((i) => { if (ratings[i.rating] != null) ratings[i.rating] += 1; });
  const avg = caps.length ? Math.round(caps.reduce((n, c) => n + c.length, 0) / caps.length) : 0;
  return { count: items.length, captionCount: caps.length, avgChars: avg, tags, hooks, ratings };
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
    return;
  }
  showSavebar(false);
  if (page === 'produce') root.innerHTML = viewProduce();
  else if (page === 'feed') {
    root.innerHTML = viewFeed();
    bindDrop();
  } else if (page === 'style') root.innerHTML = viewStyle();
  else root.innerHTML = viewArchive();
}

function viewProduce() {
  const n = state.feed.length;
  const recent = [...state.feed].reverse().slice(0, 8);
  return `
    <h1>说一句，出排期和成稿</h1>
    <p class="lead">先在「喂帖」把小红书海报和 caption 存进来。这里只说一句话，助理会带上已喂的真实旧帖去写。</p>
    <div class="stat-row">
      <span class="pill hot">已喂 ${n} 条真实帖</span>
      <span class="pill">有文案 ${state.style.captionCount || 0}</span>
      <span class="pill">较好 ${state.style.ratings?.good || 0} · 一般 ${state.style.ratings?.ok || 0} · 较差 ${state.style.ratings?.bad || 0}</span>
    </div>
    <section class="command">
      <div class="field">
        <label>这一次要出什么</label>
        <textarea id="cmd" rows="3" placeholder="例如：出下周 4 篇，围绕香港公司年审和开户">${esc(lastCommand)}</textarea>
      </div>
      ${recent.length ? `
        <label>可一并丢给 AI 的参考海报</label>
        <div class="cover-strip">
          ${recent.map((item) => {
            const src = coverSrc(item, 0);
            return src
              ? `<div class="ph"><img src="${esc(src)}" alt=""></div>`
              : `<div class="ph"></div>`;
          }).join('')}
        </div>
        <p class="hint">电脑上可以把这几张封面一起拖进 Grok / 豆包 / Kimi，海报风格会更像。</p>
      ` : `<p class="hint">还没有旧帖。先去喂 10–20 条，出稿才会像你们自己的号。</p>`}
      <div class="actions">
        <button class="btn" onclick="produceNow()">出稿</button>
        <button class="btn ghost" onclick="go('feed')">去喂帖</button>
      </div>
    </section>
    ${lastBrief ? renderProduceResult() : ''}
  `;
}

function renderProduceResult() {
  return `
    <section class="result-area">
      <div class="brief-box">
        <div class="prompt-head">
          <h2>已复制给 AI 的任务</h2>
          <button class="btn ghost small" onclick="copy(lastBrief); toast('已复制')">再复制</button>
        </div>
        <p class="hint">不接付费 API。打开你们已经在用的 Grok / 豆包 / Kimi，粘贴即可出排期和成稿。海报可从上面一起拖过去。</p>
        <pre>${esc(lastBrief)}</pre>
      </div>
      <div class="field" style="margin-top:18px">
        <label>把 AI 出的排期和成稿贴回来</label>
        <textarea id="pasteBack" rows="10" placeholder="整段贴进来，存进「存档」">${esc(lastResult)}</textarea>
      </div>
      <div class="actions">
        <button class="btn" onclick="saveProduceResult()">保存成稿</button>
        <button class="btn ghost" onclick="exportResultPdf()">导出 PDF</button>
      </div>
    </section>
  `;
}

async function produceNow() {
  const command = val('cmd') || lastCommand;
  if (!command) { toast('先说一句要出什么', true); return; }
  lastCommand = command;
  lastResult = '';
  busy(true, '在整理已喂的旧帖');
  try {
    const res = await post('/api/produce', { command });
    lastBrief = res.brief;
    copy(lastBrief);
    if (res.style) state.style = res.style;
    draw();
    toast(res.feedCount ? `已复制，带上了 ${res.feedCount} 条旧帖` : '已复制。建议先喂一些旧帖');
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy(false);
  }
}

async function saveProduceResult() {
  const content = val('pasteBack');
  if (!content) { toast('先把结果贴进来', true); return; }
  lastResult = content;
  try {
    const parts = content.split(/—{2,}|-{4,}/).map((p) => p.trim()).filter((p) => p.length > 10);
    const chunks = parts.length > 1 ? parts : [content];
    const hasTable = /\|/.test(content) && /封面标题/.test(content);
    if (hasTable) {
      await post('/api/schedules', { name: lastCommand || ('排期 ' + whenFull(new Date().toISOString())), content });
      const sch = await api('/api/schedules');
      state.schedules = sch.items || [];
    }
    for (const p of chunks) {
      const m = p.match(/【封面标题】[：:](.+)/);
      await post('/api/posts', { title: m ? m[1].trim() : (lastCommand || '稿件'), content: p });
    }
    const data = await api('/api/posts');
    state.posts = data.items || [];
    toast('已存进存档');
  } catch (e) {
    toast(e.message, true);
  }
}

function viewFeed() {
  return `
    <h1>喂真实旧帖</h1>
    <p class="lead">在小红书里把海报下载下来，caption 复制过来。一张封面即可，内页有就一起丢。标一下数据好坏，助理才知道该学哪一类。</p>
    <section class="panel">
      <div class="field">
        <label>海报 / 内页</label>
        <div class="drop" id="drop">点击、拖入，或直接粘贴截图</div>
        <input type="file" id="filePick" accept="image/*" multiple hidden>
        <div class="thumbs" id="thumbs">${renderComposerThumbs()}</div>
        <p class="hint">手机可直接从相册选图。一次最多 8 张。</p>
      </div>
      <div class="field">
        <label>Caption 原文</label>
        <textarea id="f_caption" rows="8" placeholder="从小红书复制完整文案，不要先改写">${esc(composer.caption)}</textarea>
      </div>
      <div class="field">
        <label>这条数据怎么样</label>
        <div class="chips">
          ${[['good', '较好'], ['ok', '一般'], ['bad', '较差'], ['', '不标']].map(([k, lab]) => `
            <button type="button" class="chip ${composer.rating === k ? 'on' : ''}" onclick="setRating('${k}')">${lab}</button>
          `).join('')}
        </div>
      </div>
      <div class="field">
        <label>备注（可选）</label>
        <input type="text" id="f_note" value="${esc(composer.note)}" placeholder="例如：封面好但正文太长 / 开户向 / 3月发的">
      </div>
      <div class="actions">
        <button class="btn" onclick="saveFeedItem()">喂进去</button>
        <button class="btn quiet" onclick="resetComposer()">清空</button>
      </div>
    </section>
    <p class="note">已喂 ${state.feed.length} 条。去「风格」回看全部海报和文案。</p>
  `;
}

function renderComposerThumbs() {
  return composer.images.map((src, i) => `
    <div class="thumb">
      <img src="${src}" alt="">
      <button type="button" onclick="removeComposerImage(${i})">×</button>
    </div>
  `).join('');
}

function stashComposer() {
  const cap = document.getElementById('f_caption');
  const note = document.getElementById('f_note');
  if (cap) composer.caption = cap.value;
  if (note) composer.note = note.value;
}

function setRating(k) {
  stashComposer();
  composer.rating = k;
  draw();
}

function resetComposer() {
  composer.images = [];
  composer.caption = '';
  composer.rating = '';
  composer.note = '';
  draw();
}

function removeComposerImage(i) {
  stashComposer();
  composer.images.splice(i, 1);
  draw();
}

function bindDrop() {
  const drop = document.getElementById('drop');
  const pick = document.getElementById('filePick');
  if (!drop || !pick) return;
  drop.addEventListener('click', () => pick.click());
  pick.addEventListener('change', () => addFiles(pick.files));
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('on');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('on'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('on');
    addFiles(e.dataTransfer.files);
  });
}

document.addEventListener('paste', async (e) => {
  if (page !== 'feed') return;
  const files = [...(e.clipboardData?.items || [])]
    .filter((it) => it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  await addFiles(files);
});

async function addFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => f && f.type.startsWith('image/'));
  if (!files.length) return;
  stashComposer();
  if (composer.images.length + files.length > 8) {
    toast('一篇最多 8 张图', true);
    return;
  }
  busy(true, '在压缩海报');
  try {
    for (const file of files) {
      composer.images.push(await compressFile(file));
    }
    draw();
  } catch (e) {
    toast(e.message || '图片读取失败', true);
  } finally {
    busy(false);
  }
}

async function saveFeedItem() {
  stashComposer();
  if (!composer.caption.trim() && !composer.images.length) {
    toast('至少要有海报或文案', true);
    return;
  }
  busy(true, '在保存');
  try {
    const payload = {
      caption: composer.caption.trim(),
      rating: composer.rating,
      note: composer.note.trim(),
      images: composer.images.map((dataUrl, i) => ({
        name: String(i) + '.jpg',
        mime: 'image/jpeg',
        dataUrl
      }))
    };
    const res = await post('/api/feed', payload);
    const item = res.item;
    if (item) {
      for (let i = 0; i < composer.images.length; i++) {
        await idbSet(item.id + ':' + i, composer.images[i]);
      }
      const merged = await hydratePreviews(mergeById(res.items || [], state.feed));
      rememberFeed(merged);
    }
    if (res.style) state.style = res.style;
    resetComposer();
    toast('已喂入');
  } catch (e) {
    toast(e.message, true);
  } finally {
    busy(false);
  }
}

function viewStyle() {
  const items = [...state.feed].reverse();
  const tags = state.style.tags || [];
  return `
    <h1>已学会的风格</h1>
    <p class="lead">这些是你们从小红书存进来的真实帖。点开可看完整文案和海报。</p>
    <div class="stat-row">
      <span class="pill hot">${state.style.count || 0} 条</span>
      <span class="pill">文案均长 ${state.style.avgChars || 0} 字</span>
      ${(tags.slice(0, 6).map((t) => `<span class="pill">${esc(t.tag)} ${t.n}</span>`).join(''))}
    </div>
    ${items.length === 0 ? `
      <div class="empty">还没有旧帖。<div class="actions" style="margin-top:16px"><button class="btn" onclick="go('feed')">去喂帖</button></div></div>
    ` : `
      <div class="style-grid">
        ${items.map((item) => {
          const src = coverSrc(item, 0);
          const rating = item.rating === 'good' ? '较好' : item.rating === 'bad' ? '较差' : item.rating === 'ok' ? '一般' : '';
          return `
            <article class="style-card">
              <div class="card-cover">${src ? `<img src="${esc(src)}" alt="">` : ''}</div>
              <div class="body">
                <div class="cap">${esc((item.caption || '（只有海报）').slice(0, 160))}${(item.caption || '').length > 160 ? '…' : ''}</div>
                <div class="meta">${esc(whenFull(item.createdAt))}${rating ? ' · ' + rating : ''}</div>
                <div class="actions more">
                  <button class="btn ghost small" onclick="openFeedItem('${item.id}')">看</button>
                  <button class="btn quiet small" onclick="removeFeed('${item.id}')">删</button>
                </div>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `}
  `;
}

function openFeedItem(id) {
  const item = state.feed.find((x) => x.id === id);
  if (!item) { toast('找不到这条', true); return; }
  const imgs = (item.images || []).map((img) => {
    const src = img.preview || img.url || '';
    return src ? `<img src="${esc(src)}" alt="" style="width:100%;border-radius:10px;margin:0 0 10px">` : '';
  }).join('');
  const sheet = document.getElementById('sheet');
  sheet.classList.remove('hidden');
  sheet.onclick = null;
  sheet.innerHTML = `
    <div class="sheet-card" onclick="event.stopPropagation()">
      <h2>真实旧帖</h2>
      ${imgs}
      <pre style="white-space:pre-wrap;font-family:var(--sans);font-size:14px;line-height:1.7">${esc(item.caption || '（无文案）')}</pre>
      ${item.note ? `<p class="hint" style="margin-top:10px">${esc(item.note)}</p>` : ''}
      <div class="actions" style="margin-top:18px">
        <button class="btn" type="button" onclick="copyFeedCaption('${item.id}')">复制文案</button>
        <button class="btn ghost" type="button" onclick="closeSheet()">关闭</button>
      </div>
    </div>
  `;
  setTimeout(() => { sheet.onclick = closeSheet; }, 0);
}

function copyFeedCaption(id) {
  const item = state.feed.find((x) => x.id === id);
  copy((item && item.caption) || '');
  toast('文案已复制');
}

async function removeFeed(id) {
  if (!confirm('删除这条旧帖？')) return;
  try {
    const res = await del('/api/feed/' + id);
    const item = state.feed.find((x) => x.id === id);
    const n = item && item.images ? item.images.length : 8;
    for (let i = 0; i < n; i++) await idbDel(id + ':' + i);
    rememberFeed(await hydratePreviews(res.items || state.feed.filter((x) => x.id !== id)));
    if (res.style) state.style = res.style;
    draw();
    toast('已删除');
  } catch (e) {
    toast(e.message, true);
  }
}

function viewRules() {
  const r = state.rules || {};
  return `
    <h1>账号规则</h1>
    <p class="lead">这些规则每次出稿都会带上。真实旧帖优先，规则用来兜底。</p>
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
          <label>旧帖和素材怎么用</label>
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

function closeSheet() {
  const el = document.getElementById('sheet');
  el.classList.add('hidden');
  el.innerHTML = '';
  el.onclick = null;
}

function viewArchive() {
  return `
    <h1>存档</h1>
    <p class="lead">出稿后贴回来的排期和成稿都在这里，可导出 PDF。</p>
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
                <button class="btn ghost small" onclick="event.stopPropagation(); viewSaved('schedules','${x.id}')">看</button>
                <button class="btn quiet small" onclick="removeSchedule('${x.id}')">删</button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </section>
    <section class="archive-block">
      <h2>成稿</h2>
      ${state.posts.length === 0 ? '<div class="empty">还没有成稿。</div>' : `
        <div class="list">
          ${state.posts.map((x) => `
            <div class="item">
              <div>
                <h3>${esc(x.title || '稿件')}</h3>
                <p>${esc((x.content || '').slice(0, 120))}${(x.content || '').length > 120 ? '…' : ''}</p>
                <div class="meta">${whenFull(x.createdAt)}</div>
              </div>
              <div class="actions">
                <button class="btn ghost small" onclick="event.stopPropagation(); viewSaved('posts','${x.id}')">看</button>
                <button class="btn quiet small" onclick="removePost('${x.id}')">删</button>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </section>
    <div class="actions">
      <button class="btn" onclick="exportPdf()">导出全部 PDF</button>
    </div>
  `;
}

function viewSaved(kind, id) {
  const item = (state[kind] || []).find((x) => String(x.id) === String(id));
  if (!item) { toast('找不到这条记录', true); return; }
  openText(item.name || item.title || '详情', item.content || '');
}

function openText(title, content) {
  const sheet = document.getElementById('sheet');
  sheet.classList.remove('hidden');
  sheet.onclick = null;
  sheet.innerHTML = `
    <div class="sheet-card" onclick="event.stopPropagation()">
      <h2>${esc(title)}</h2>
      <pre style="white-space:pre-wrap;font-family:var(--sans);font-size:14px;line-height:1.7">${esc(content || '（没有内容）')}</pre>
      <div class="actions" style="margin-top:18px">
        <button class="btn" type="button" id="copySavedBtn">复制</button>
        <button class="btn ghost" type="button" onclick="closeSheet()">关闭</button>
      </div>
    </div>
  `;
  const copyBtn = document.getElementById('copySavedBtn');
  if (copyBtn) copyBtn.onclick = () => { copy(content || ''); toast('已复制'); };
  setTimeout(() => { sheet.onclick = closeSheet; }, 0);
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
  try { await loadPdfLibs(); } catch (e) {}
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
    ['旧帖和素材怎么用', r.materialConstraint]
  ].map(([k, v]) => `<p><strong>${esc(k)}：</strong>${esc(v || '—')}</p>`).join('');
}

async function exportRulesPdf() {
  if (rulesDirty) await saveRules(false);
  const r = state.rules || {};
  const html = wrapPdf('账号规则', pdfSection('主号设定与格式细则', ruleRowsHtml(r)));
  await downloadPdf(html, `CPLUS-规则-${new Date().toISOString().slice(0, 10)}.pdf`);
}

async function exportResultPdf() {
  const content = val('pasteBack') || lastResult;
  if (!content) { toast('先把成稿贴回来', true); return; }
  const html = wrapPdf(lastCommand || '本周成稿', `<p>${esc(content)}</p>`);
  await downloadPdf(html, `CPLUS-成稿-${new Date().toISOString().slice(0, 10)}.pdf`);
}

async function exportPdf() {
  const data = await api('/api/export');
  const r = data.rules || {};
  const feed = (data.feed && data.feed.items) || state.feed;
  const sch = (data.schedules && data.schedules.items) || [];
  const posts = (data.posts && data.posts.items) || [];
  const feedHtml = feed.length ? feed.map((m) => `
    <div class="pdf-block">
      <h3>${esc((m.caption || '海报').split('\n')[0].slice(0, 40))}</h3>
      <p class="pdf-time">${esc(whenFull(m.createdAt))}${m.rating ? ' · ' + esc(m.rating) : ''}</p>
      <p>${esc(m.caption || '')}</p>
    </div>
  `).join('') : '<p>暂无旧帖</p>';
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
  `).join('') : '<p>暂无成稿</p>';
  const html = wrapPdf('CPLUS 小红书助理存档', `
    ${pdfSection('账号规则', ruleRowsHtml(r))}
    ${pdfSection('已喂旧帖', feedHtml)}
    ${pdfSection('排期', schHtml)}
    ${pdfSection('成稿', postHtml)}
  `);
  await downloadPdf(html, 'CPLUS-小红书存档-' + new Date().toISOString().slice(0, 10) + '.pdf');
}

window.addEventListener('beforeunload', (e) => {
  if (!rulesDirty && !composer.images.length && !composer.caption) return;
  e.preventDefault();
  e.returnValue = '';
});
