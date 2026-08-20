const path = require('path');
const fs = require('fs');
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) return;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && process.env[k] == null) process.env[k] = v;
  });
})();

const express = require('express');
const http = require('http');
const https = require('https');
const { callChat, AiError, resolveAiConfig } = require('./lib/ai');
const { createAuth } = require('./lib/auth');
const { attachWorkspace, isBlocked, limited, clientIp } = require('./lib/workspace');

const app = express();
const PORT = process.env.PORT || 3210;

app.use(express.json({ limit: '50mb' }));
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// ==================== Data Layer ====================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function ensureDataFile(filename, defaultContent) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultContent, null, 2), 'utf-8');
  }
  return filePath;
}

function readData(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeData(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
  if (global.__cplusPg) {
    global.__cplusPg.query(
      'INSERT INTO kv(key, value, updated_at) VALUES($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()',
      [filename, data]
    ).catch((e) => console.error('[db] kv write failed', e.message));
  }
  return data;
}

function loadList(filename) {
  try {
    const data = readData(filename);
    if (Array.isArray(data)) return { items: data.filter(Boolean) };
    if (data && Array.isArray(data.items)) return { items: data.items.filter(Boolean) };
  } catch (e) {
    console.error('loadList', filename, e.message);
  }
  return { items: [] };
}

const lists = {
  materials: loadList('materials.json'),
  schedules: loadList('schedules.json'),
  posts: loadList('posts.json'),
  feed: loadList('feed.json'),
  knowledge: loadList('knowledge.json'),
  contents: loadList('contents.json'),
  metrics: loadList('metrics.json'),
  chat: loadList('chat.json'),
  suggestions: loadList('suggestions.json')
};

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function persistList(name) {
  writeData(name + '.json', { items: lists[name].items });
  return lists[name];
}

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Initialize data files
const DEFAULT_RULES = {
  accountPosition: 'CPLUS GROUP LIMITED (HK) 企业合规干货号。面向要出海、已有或准备开香港公司的企业主，讲公司注册、秘书合规、SCR/KYC、年审开户、金融牌照与跨境架构。只做能落地的硬知识，不做品牌软文号。',
  targetAudience: '25-45岁内地企业主、财务/法务负责人、跨境电商与支付/资管从业者；正在办香港公司，或已被催做 SCR、KYC、年审、开户、牌照的决策人。',
  persona: '专业但不端着。像一个在香港做过真合规的同事提醒你：这件事不做会卡在哪、怎么补。不鸡汤、不恐吓营销、不写秘书公司长软广。',
  coverTitleStyle: '12-18字，要有痛点/结果/反差，拒绝书面长标题，不使用公众号式标题',
  coverTitleMaxLength: '18',
  bodyStructure: '开篇钩子1-2句 -> 3-4个分点核心内容（短句多换行） -> 简短总结 -> 1条互动提问',
  writingStyle: '口语化专业干货，少华丽辞藻，拒绝官样书面长句；专有名词第一次出现用括号补一句人话',
  wordCountMin: '350',
  wordCountMax: '550',
  imageSuggestions: '2-3个具体画面方向，适合小红书图文，方便 Xixi 按固定海报模板落版；写清主标题、副标题、2-4个信息块，不要笼统说「做一张专业封面」',
  tagRule: '每篇6-8个标签：固定可带 #香港公司 #企业合规；再加2个大流量词 + 4-6个垂直细分词（如 #SCR备案 #KYC #MSO牌照 #公司秘书）',
  prohibitions: '公众号式长篇铺垫、学术式长句、生硬说教、营销感过重话术、编造罚款金额或牌照案例、把 CPLUS 写成软广、恐吓式监管话术',
  materialConstraint: '优先模仿已喂入的真实小红书旧帖语气和版式。如另有公众号摘录，只萃取论点后打散重写，禁止整段搬原文。',
  outputFormat: '封面标题 | 笔记正文 | 配图思路建议 | 标签组',
  iterations: [],
  updatedAt: new Date().toISOString()
};

ensureDataFile('rules.json', DEFAULT_RULES);

ensureDataFile('materials.json', { items: [] });
ensureDataFile('schedules.json', { items: [] });
ensureDataFile('posts.json', { items: [] });
ensureDataFile('settings.json', {
  apiBaseUrl: '',
  apiKey: '',
  model: 'gpt-4o',
  postsPerWeek: 3,
  planWeeks: 4
});

// ==================== AI Call Helper ====================
async function callAI(prompt, settings, systemPrompt) {
  const cfg = resolveAiConfig(settings || {});
  if (!cfg.configured) throw new Error('AI_API_NOT_CONFIGURED');
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });
  try {
    return await callChat(messages, settings, { timeoutMs: 90000, retries: 2 });
  } catch (e) {
    if (e instanceof AiError && e.code === 'AI_API_NOT_CONFIGURED') throw new Error('AI_API_NOT_CONFIGURED');
    throw e;
  }
}

// ==================== Build Rules Prompt ====================
function buildRulesPrompt(rules) {
  return `# 角色：小红书垂直内容策划 & 撰稿人

## 账号基础设定
- 账号定位：${rules.accountPosition || '【待填写】'}
- 目标人群：${rules.targetAudience || '【待填写】'}
- 账号人设：${rules.persona || '【待填写】'}
- 输出产物：小红书图文笔记，包含：封面标题｜笔记正文｜配图思路｜标签组
- 原始素材来源：公众号文章，${rules.materialConstraint || '严禁直接复制公众号原文大段段落，只萃取核心观点、案例、数据，重新解构重写'}

## 硬性格式 & 行文规则
1、封面标题：${rules.coverTitleStyle}，不超过${rules.coverTitleMaxLength}字
2、正文开篇：前2句必须是钩子，直击用户痛点或抛出结论，不要铺垫
3、正文结构：${rules.bodyStructure}
4、行文风格：${rules.writingStyle}
5、字数：单篇正文${rules.wordCountMin}-${rules.wordCountMax}字
6、配图思路：${rules.imageSuggestions}
7、标签：${rules.tagRule}
8、禁止：${rules.prohibitions}

## 输出格式要求（每篇严格按此模板）
【封面标题】：xxx
【笔记正文】：
（正文内容）

【配图思路】：
1、
2、

【标签】：#xxx #xxx`;
}

function buildSchedulePrompt(rules, materials, weeks, postsPerWeek) {
  const rulesPrompt = buildRulesPrompt(rules);
  const materialText = (materials || []).map((m, i) =>
    `${i + 1}. 标题：${m.title}\n   摘要：${m.summary || ''}\n   核心观点：${m.keyPoints || ''}`
  ).join('\n\n');

  return `${rulesPrompt}

---

基于我给到的公众号素材，结合上面账号全部规则，输出未来${weeks || 4}周小红书内容规划。

## 公众号素材列表
${materialText || '（尚未提供素材）'}

## 约束条件
1、每周产出${postsPerWeek || 3}篇小红书图文；
2、打散公众号原有行文逻辑，一个公众号大主题拆成多个小红书细分角度，不要照搬公众号文章结构；
3、选题配比：干货60%，感悟/案例40%，兼顾流量型选题和深度垂直选题，避免主题重复；
4、输出表格形式（用Markdown表格）：| 周数 | 发布序号 | 小红书选题标题 | 内容梗概 | 参考公众号素材序号 |
5、只输出可落地的选题，不要空泛概念。
6、选题标题要符合封面标题风格要求。
7、品牌为 CPLUS GROUP LIMITED (HK)，不要写成软广，不要编造牌照、罚款或客户案例。`;
}

function buildPostsPrompt(rules, scheduleText, materialSnippets) {
  const rulesPrompt = buildRulesPrompt(rules);
  const snippetText = materialSnippets || '（请根据选题梗概自行创作，确保内容专业、有深度，事实不编造）';

  return `${rulesPrompt}

---

根据上面账号规则，以及给到的本周排期和对应公众号参考素材片段，批量生成本周全部小红书图文笔记。

## 本周排期
${scheduleText || '（尚未提供排期）'}

## 公众号参考素材片段
${snippetText}

## 要求
1、每一篇严格遵守输出模板：封面标题、笔记正文、配图思路、标签；
2、每篇独立完整，不要互相复制句子；
3、只萃取素材信息，禁止直接复制公众号原文；
4、事实、案例、数据忠于原始素材，不编造信息；
5、配图思路要写到 Xixi 能按固定海报模板落版：主标题、副标题、2-4个信息块；
6、输出时每篇笔记之间用 ———— 分割隔开，方便复制拆分。`;
}

function stripDataUrl(item) {
  const images = (item.images || []).map((img) => ({
    name: img.name,
    mime: img.mime || 'image/jpeg',
    url: img.url
  }));
  return { ...item, images };
}

function saveBase64Image(dir, index, img) {
  const raw = String(img.data || img.dataUrl || '');
  const comma = raw.indexOf(',');
  const payload = comma >= 0 ? raw.slice(comma + 1) : raw;
  if (!payload) return null;
  const mime = img.mime || (raw.includes('image/png') ? 'image/png' : 'image/jpeg');
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const name = String(index) + '.' + ext;
  const buf = Buffer.from(payload, 'base64');
  if (!buf.length || buf.length > 6 * 1024 * 1024) return null;
  fs.writeFileSync(path.join(dir, name), buf);
  return { name, mime, url: '' };
}

function removeUploadDir(id) {
  const dir = path.join(UPLOAD_DIR, id);
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach((name) => fs.unlinkSync(path.join(dir, name)));
  fs.rmdirSync(dir);
}

function withImageUrls(item) {
  const images = (item.images || []).map((img) => ({
    ...img,
    url: '/api/uploads/' + item.id + '/' + img.name
  }));
  return { ...item, images };
}

function analyzeFeed(items) {
  const caps = (items || []).map((i) => i.caption || '').filter(Boolean);
  const tagCount = {};
  caps.forEach((c) => {
    (c.match(/#[^\s#]+/g) || []).forEach((t) => {
      tagCount[t] = (tagCount[t] || 0) + 1;
    });
  });
  const tags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, n]) => ({ tag, n }));
  const hooks = caps.map((c) => c.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ｜ ')).filter(Boolean).slice(0, 10);
  const ratings = { good: 0, ok: 0, bad: 0 };
  (items || []).forEach((i) => {
    if (ratings[i.rating] != null) ratings[i.rating] += 1;
  });
  const avg = caps.length ? Math.round(caps.reduce((n, c) => n + c.length, 0) / caps.length) : 0;
  return { count: items.length, captionCount: caps.length, avgChars: avg, tags, hooks, ratings };
}

function buildProduceBrief(rules, feedItems, command) {
  const rulesPrompt = buildRulesPrompt(rules || {});
  const samples = (feedItems || []).slice(-20).reverse().map((item, i) => {
    const mark = item.rating === 'good' ? '数据较好' : item.rating === 'bad' ? '数据较差' : item.rating === 'ok' ? '数据一般' : '未标数据';
    const note = item.note ? `\n备注：${item.note}` : '';
    return `### 真实旧帖 ${i + 1}（${mark}）\n${item.caption || '（无文案，只有海报）'}${note}`;
  }).join('\n\n');
  const style = analyzeFeed(feedItems);
  const tagLine = style.tags.length ? style.tags.map((t) => `${t.tag}×${t.n}`).join(' ') : '（还没有标签样本）';

  return `${rulesPrompt}

---

你是 CPLUS GROUP LIMITED (HK) 的小红书运营助理。下面是这个账号已经发过的真实文案。先模仿它们的语气、标题习惯、分段和标签，再完成用户这一句话的任务。
不要输出 prompt，不要解释过程。直接输出可发布的选题排期表和完整图文成稿。

## 用户指令
${command || '出下周 4 篇小红书图文。'}

## 已学会的风格（从真实旧帖统计）
- 已喂 ${style.count} 条，其中 ${style.captionCount} 条有文案
- 文案平均约 ${style.avgChars} 字
- 常用标签：${tagLine}
- 数据较好 ${style.ratings.good} / 一般 ${style.ratings.ok} / 较差 ${style.ratings.bad}

## 真实旧帖文案（按时间，最多 20 条）
${samples || '（还没有喂帖。按账号规则写，不要编造客户案例和罚款数字。）'}

## 必须这样输出
若是排期：先给表 | 周 | 序号 | 封面标题 | 类型 | 目标客户 | 内容目的 | 然后每篇完整成稿。
每篇之间用 ———— 分隔，严格用：

【内容主题】
【目标客户】
【内容目的】
【封面标题】
【封面副标题或3个重点】
【小红书正文】
【CTA】
【Hashtag】
【海报制作说明】
【参考资料及链接】
【需要人工确认的资料】
【合规风险提示】
【内容状态】Draft`;
}

function buildIteratePrompt(rules, feedback, goodPosts, badPosts) {
  const rulesPrompt = buildRulesPrompt(rules);

  return `${rulesPrompt}

---

## 数据反馈
我这批小红书笔记数据反馈：
${feedback || ''}

数据较好的笔记选题：${goodPosts || '（未提供）'}
数据较差的笔记选题：${badPosts || '（未提供）'}

结合上面账号规则，复盘问题，更新迭代整套账号内容规则。

## 输出要求
1、现存内容问题总结（分析数据好/差的原因）；
2、更新后的完整新版账号规则（直接可替换使用，包含所有模块）；
3、后续选题优化方向建议（3-5条具体建议）。

请用以下格式输出：

### 一、现存内容问题总结
（分析内容）

### 二、更新后的完整账号规则
（完整的规则文本，可以直接复制使用）

### 三、后续选题优化方向建议
1、
2、
3、`;
}

// ==================== API Routes ====================

const auth = createAuth({ readData, writeData, ensureDataFile, newId });

app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  if (!req.path.startsWith('/api')) return next();
  attachWorkspace(req, res);
  req.user = { id: 'public', name: 'CPLUS User', role: 'public', workspaceId: req.workspaceId };
  if (isBlocked(req.originalUrl)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const ip = clientIp(req);
    if (limited('w:' + req.workspaceId, 80, 10 * 60 * 1000) || limited('ip:' + ip, 120, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试。' });
    }
  }
  next();
});

function scopedItems(req, items) {
  return (items || []).filter((i) => i && i.workspaceId === req.workspaceId);
}

app.post('/api/prompt/schedule', (req, res) => {
  const rules = readData('rules.json');
  const { materials, weeks, postsPerWeek } = req.body || {};
  const prompt = buildSchedulePrompt(rules, materials || [], weeks, postsPerWeek);
  res.json({ success: true, prompt });
});

app.post('/api/prompt/posts', (req, res) => {
  const rules = readData('rules.json');
  const { scheduleText, scheduleItems, materialSnippets } = req.body || {};
  const text = scheduleText || (scheduleItems || []).map((s, i) =>
    `${i + 1}. 选题标题：${s.title}\n   内容梗概：${s.summary || ''}\n   参考素材：${s.materialRef || ''}`
  ).join('\n\n');
  const prompt = buildPostsPrompt(rules, text, materialSnippets);
  res.json({ success: true, prompt });
});

app.post('/api/prompt/iterate', (req, res) => {
  const rules = readData('rules.json');
  const { feedback, goodPosts, badPosts } = req.body || {};
  const prompt = buildIteratePrompt(rules, feedback, goodPosts, badPosts);
  res.json({ success: true, prompt });
});

app.post('/api/rules/reset', (req, res) => {
  const rules = { ...DEFAULT_RULES, updatedAt: new Date().toISOString() };
  writeData('rules.json', rules);
  res.json({ success: true, rules });
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
  const settings = readData('settings.json');
  const cfg = resolveAiConfig(settings || {});
  res.json({
    ...settings,
    apiKey: '',
    apiKeyConfigured: cfg.configured,
    aiSource: cfg.source,
    model: cfg.model,
    apiBaseUrl: settings.apiBaseUrl || process.env.AI_API_BASE || ''
  });
});

app.post('/api/settings', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可改设置' });
  const current = readData('settings.json');
  const updates = req.body || {};
  delete updates.apiKey;
  const newSettings = { ...current, ...updates };
  writeData('settings.json', newSettings);
  const cfg = resolveAiConfig(newSettings);
  res.json({
    success: true,
    settings: { ...newSettings, apiKey: '', apiKeyConfigured: cfg.configured, aiSource: cfg.source, model: cfg.model }
  });
});

// --- Rules ---
app.get('/api/rules', (req, res) => {
  const rules = readData('rules.json');
  res.json(rules);
});

app.post('/api/rules', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可改账号规则' });
  const rules = { ...req.body, updatedAt: new Date().toISOString() };
  writeData('rules.json', rules);
  res.json({ success: true, rules });
});

app.get('/api/rules/prompt', (req, res) => {
  const rules = readData('rules.json');
  res.json({ prompt: buildRulesPrompt(rules) });
});

// --- Materials ---
app.get('/api/materials', (req, res) => {
  res.json({ items: scopedItems(req, lists.materials.items) });
});

app.post('/api/materials', (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const added = [];
  incoming.forEach((raw) => {
    if (!raw || !raw.title) return;
    const exists = raw.id && lists.materials.items.some((i) => i.id === raw.id);
    if (exists) return;
    const item = {
      id: raw.id || newId(),
      title: raw.title || '',
      summary: raw.summary || '',
      keyPoints: raw.keyPoints || '',
      snippet: raw.snippet || '',
      createdAt: raw.createdAt || new Date().toISOString(),
      workspaceId: req.workspaceId
    };
    lists.materials.items.push(item);
    added.push(item);
  });
  persistList('materials');
  res.json({ success: true, item: added[0] || null, items: lists.materials.items });
});

app.put('/api/materials/:id', (req, res) => {
  const idx = lists.materials.items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  lists.materials.items[idx] = {
    ...lists.materials.items[idx],
    title: req.body.title ?? lists.materials.items[idx].title,
    summary: req.body.summary ?? lists.materials.items[idx].summary,
    keyPoints: req.body.keyPoints ?? lists.materials.items[idx].keyPoints,
    snippet: req.body.snippet ?? lists.materials.items[idx].snippet,
    id: req.params.id
  };
  persistList('materials');
  res.json({ success: true, item: lists.materials.items[idx], items: lists.materials.items });
});

app.delete('/api/materials/:id', (req, res) => {
  lists.materials.items = lists.materials.items.filter(i => i.id !== req.params.id);
  persistList('materials');
  res.json({ success: true, items: lists.materials.items });
});

// --- Schedules ---
app.get('/api/schedules', (req, res) => {
  res.json({ items: scopedItems(req, lists.schedules.items) });
});

app.post('/api/schedules', (req, res) => {
  const item = {
    id: newId(),
    name: req.body.name || '',
    content: req.body.content || '',
    createdAt: new Date().toISOString(),
    workspaceId: req.workspaceId
  };
  lists.schedules.items.push(item);
  persistList('schedules');
  res.json({ success: true, item, items: lists.schedules.items });
});

app.delete('/api/schedules/:id', (req, res) => {
  lists.schedules.items = lists.schedules.items.filter(i => i.id !== req.params.id);
  persistList('schedules');
  res.json({ success: true, items: lists.schedules.items });
});

// --- Posts ---
app.get('/api/posts', (req, res) => {
  res.json({ items: scopedItems(req, lists.posts.items) });
});

app.post('/api/posts', (req, res) => {
  const item = {
    id: newId(),
    title: req.body.title || '',
    content: req.body.content || '',
    createdAt: new Date().toISOString(),
    workspaceId: req.workspaceId
  };
  lists.posts.items.push(item);
  persistList('posts');
  res.json({ success: true, item, items: lists.posts.items });
});

app.put('/api/posts/:id', (req, res) => {
  const idx = lists.posts.items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  lists.posts.items[idx] = { ...lists.posts.items[idx], ...req.body, id: req.params.id };
  persistList('posts');
  res.json({ success: true, item: lists.posts.items[idx], items: lists.posts.items });
});

app.delete('/api/posts/:id', (req, res) => {
  lists.posts.items = lists.posts.items.filter(i => i.id !== req.params.id);
  persistList('posts');
  res.json({ success: true, items: lists.posts.items });
});

// --- AI Generation: Schedule ---
app.post('/api/generate/schedule', async (req, res) => {
  try {
    const settings = readData('settings.json');
    const rules = readData('rules.json');
    const { materials, weeks, postsPerWeek } = req.body;

    const rulesPrompt = buildRulesPrompt(rules);
    const materialText = materials.map((m, i) =>
      `${i + 1}. 标题：${m.title}\n   摘要：${m.summary || ''}\n   核心观点：${m.keyPoints || ''}`
    ).join('\n\n');

    const prompt = `${rulesPrompt}

---

基于我给到的公众号素材，结合上面账号全部规则，输出未来${weeks || 4}周小红书内容规划。

## 公众号素材列表
${materialText}

## 约束条件
1、每周产出${postsPerWeek || 3}篇小红书图文；
2、打散公众号原有行文逻辑，一个公众号大主题拆成多个小红书细分角度，不要照搬公众号文章结构；
3、选题配比：干货60%，感悟/案例40%，兼顾流量型选题和深度垂直选题，避免主题重复；
4、输出表格形式（用Markdown表格）：| 周数 | 发布序号 | 小红书选题标题 | 内容梗概 | 参考公众号素材序号 |
5、只输出可落地的选题，不要空泛概念。
6、选题标题要符合封面标题风格要求。`;

    const content = await callAI(prompt, settings, '你是一个专业的小红书内容策划专家，擅长将公众号深度内容拆解重组为小红书爆款选题。');
    res.json({ success: true, content, prompt });
  } catch (error) {
    console.error('Schedule generation error:', error.message);
    if (error.message === 'AI_API_NOT_CONFIGURED') {
      res.status(400).json({ error: '请先在设置中配置 AI API 地址和密钥', code: 'AI_API_NOT_CONFIGURED', prompt: req.body });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// --- AI Generation: Batch Posts ---
app.post('/api/generate/posts', async (req, res) => {
  try {
    const settings = readData('settings.json');
    const rules = readData('rules.json');
    const { scheduleItems, materialSnippets } = req.body;

    const rulesPrompt = buildRulesPrompt(rules);

    const scheduleText = scheduleItems.map((s, i) =>
      `${i + 1}. 选题标题：${s.title}\n   内容梗概：${s.summary || ''}\n   参考素材：${s.materialRef || ''}`
    ).join('\n\n');

    const snippetText = materialSnippets || '（请根据选题梗概自行创作，确保内容专业、有深度）';

    const prompt = `${rulesPrompt}

---

根据上面账号规则，以及给到的本周排期和对应公众号参考素材片段，批量生成本周全部小红书图文笔记。

## 本周排期
${scheduleText}

## 公众号参考素材片段
${snippetText}

## 要求
1、每一篇严格遵守输出模板：封面标题、笔记正文、配图思路、标签；
2、每篇独立完整，不要互相复制句子；
3、只萃取素材信息，禁止直接复制公众号原文；
4、事实、案例、数据忠于原始素材，不编造信息；
5、输出时每篇笔记之间用 ———— 分割隔开，方便复制拆分。`;

    const content = await callAI(prompt, settings, '你是一个专业的小红书内容撰稿人，擅长将专业内容转化为口语化、有钩子、有干货的小红书图文笔记。');
    res.json({ success: true, content, prompt });
  } catch (error) {
    console.error('Posts generation error:', error.message);
    if (error.message === 'AI_API_NOT_CONFIGURED') {
      res.status(400).json({ error: '请先在设置中配置 AI API 地址和密钥', code: 'AI_API_NOT_CONFIGURED' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// --- AI Generation: Iterate Rules ---
app.post('/api/generate/iterate', async (req, res) => {
  try {
    const settings = readData('settings.json');
    const rules = readData('rules.json');
    const { feedback, goodPosts, badPosts } = req.body;

    const rulesPrompt = buildRulesPrompt(rules);

    const prompt = `${rulesPrompt}

---

## 数据反馈
我这批小红书笔记数据反馈：
${feedback || ''}

数据较好的笔记选题：${goodPosts || '（未提供）'}
数据较差的笔记选题：${badPosts || '（未提供）'}

结合上面账号规则，复盘问题，更新迭代整套账号内容规则。

## 输出要求
1、现存内容问题总结（分析数据好/差的原因）；
2、更新后的完整新版账号规则（直接可替换使用，包含所有模块）；
3、后续选题优化方向建议（3-5条具体建议）。

请用以下格式输出：

### 一、现存内容问题总结
（分析内容）

### 二、更新后的完整账号规则
（完整的规则文本，可以直接复制使用）

### 三、后续选题优化方向建议
1、
2、
3、`;

    const content = await callAI(prompt, settings, '你是一个内容运营专家，擅长通过数据分析优化内容策略和创作规则。');
    res.json({ success: true, content, prompt });
  } catch (error) {
    console.error('Iterate error:', error.message);
    if (error.message === 'AI_API_NOT_CONFIGURED') {
      res.status(400).json({ error: '请先在设置中配置 AI API 地址和密钥', code: 'AI_API_NOT_CONFIGURED' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// --- Feed: real XHS posters + captions ---
app.get('/api/feed', (req, res) => {
  const items = scopedItems(req, lists.feed.items).map(withImageUrls);
  res.json({
    items,
    style: analyzeFeed(items)
  });
});

app.post('/api/feed', (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [req.body];
  const added = [];
  incoming.forEach((raw) => {
    if (!raw) return;
    if (raw.id && lists.feed.items.some((i) => i.id === raw.id)) return;
    const hasCaption = !!(raw.caption && String(raw.caption).trim());
    const hasImages = Array.isArray(raw.images) && raw.images.length;
    if (!hasCaption && !hasImages) return;
    const id = raw.id || newId();
    const dir = path.join(UPLOAD_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    const images = [];
    (raw.images || []).slice(0, 8).forEach((img, i) => {
      const saved = saveBase64Image(dir, i, img || {});
      if (saved) {
        saved.url = '/api/uploads/' + id + '/' + saved.name;
        images.push(saved);
      }
    });
    const item = {
      id,
      caption: raw.caption || '',
      rating: ['good', 'ok', 'bad'].includes(raw.rating) ? raw.rating : '',
      note: raw.note || '',
      postedAt: raw.postedAt || '',
      createdAt: raw.createdAt || new Date().toISOString(),
      workspaceId: req.workspaceId,
      images: images.map((img) => ({ name: img.name, mime: img.mime, url: img.url }))
    };
    lists.feed.items.push(item);
    added.push(withImageUrls(item));
  });
  persistList('feed');
  const mine = scopedItems(req, lists.feed.items).map(withImageUrls);
  res.json({
    success: true,
    item: added[0] || null,
    items: mine,
    style: analyzeFeed(mine)
  });
});

app.put('/api/feed/:id', (req, res) => {
  const idx = lists.feed.items.findIndex((i) => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const cur = lists.feed.items[idx];
  const next = {
    ...cur,
    caption: req.body.caption != null ? req.body.caption : cur.caption,
    rating: req.body.rating != null ? req.body.rating : cur.rating,
    note: req.body.note != null ? req.body.note : cur.note,
    postedAt: req.body.postedAt != null ? req.body.postedAt : cur.postedAt,
    id: req.params.id
  };
  lists.feed.items[idx] = stripDataUrl(next);
  persistList('feed');
  res.json({ success: true, item: withImageUrls(lists.feed.items[idx]), items: lists.feed.items.map(withImageUrls) });
});

app.delete('/api/feed/:id', (req, res) => {
  lists.feed.items = lists.feed.items.filter((i) => i.id !== req.params.id);
  persistList('feed');
  removeUploadDir(req.params.id);
  res.json({ success: true, items: lists.feed.items.map(withImageUrls), style: analyzeFeed(lists.feed.items) });
});

app.get('/api/uploads/:id/:file', (req, res) => {
  const id = path.basename(req.params.id);
  const file = path.basename(req.params.file);
  const abs = path.join(UPLOAD_DIR, id, file);
  if (!abs.startsWith(UPLOAD_DIR)) return res.status(400).end();
  if (!fs.existsSync(abs)) return res.status(404).end();
  res.sendFile(abs);
});

app.post('/api/produce', (req, res) => {
  const rules = readData('rules.json');
  const command = (req.body && req.body.command) || '';
  if (!String(command).trim()) {
    return res.status(400).json({ error: '先说一句要出什么' });
  }
  const brief = buildProduceBrief(rules, lists.feed.items, command.trim());
  res.json({
    success: true,
    brief,
    style: analyzeFeed(lists.feed.items),
    feedCount: lists.feed.items.length
  });
});

// --- Export all data ---
app.get('/api/export', (req, res) => {
  const data = {
    rules: readData('rules.json'),
    materials: { items: lists.materials.items },
    schedules: { items: lists.schedules.items },
    posts: { items: lists.posts.items },
    feed: { items: lists.feed.items.map(stripDataUrl) },
    knowledge: { items: lists.knowledge.items },
    contents: { items: lists.contents.items },
    metrics: { items: lists.metrics.items },
    settings: { ...readData('settings.json'), apiKey: '***' },
    exportedAt: new Date().toISOString()
  };
  res.json(data);
});

// --- Import data ---
app.post('/api/import', (req, res) => {
  const { rules, materials, schedules, posts, feed } = req.body;
  if (rules) writeData('rules.json', rules);
  if (materials) {
    const items = Array.isArray(materials) ? materials : (materials.items || []);
    lists.materials.items = items;
    persistList('materials');
  }
  if (schedules) {
    const items = Array.isArray(schedules) ? schedules : (schedules.items || []);
    lists.schedules.items = items;
    persistList('schedules');
  }
  if (posts) {
    const items = Array.isArray(posts) ? posts : (posts.items || []);
    lists.posts.items = items;
    persistList('posts');
  }
  if (feed) {
    const items = Array.isArray(feed) ? feed : (feed.items || []);
    lists.feed.items = items.map(stripDataUrl);
    persistList('feed');
  }
  res.json({ success: true });
});

require('./lib/workbench-api')({
  app,
  lists,
  persistList,
  readData,
  writeData,
  ensureDataFile,
  DATA_DIR,
  newId,
  buildRulesPrompt,
  buildProduceBrief,
  callAI,
  auth
});

app.get('/healthz', (req, res) => {
  res.status(200).type('text').send('ok');
});

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  try {
    const { attachPostgres } = require('./lib/pg');
    const db = await attachPostgres({ DATA_DIR, writeData });
    global.__cplusDb = db;
    console.log('[db]', db.enabled ? 'PostgreSQL connected' : 'JSON fallback');
  } catch (e) {
    console.error('[db] init failed', e.message);
  }
  const { resolveAiConfig, probeAi, maskSecret } = require('./lib/ai');
  const cfg = resolveAiConfig({});
  if (!cfg.configured) {
    console.warn('[ai] 未配置密钥。请设置环境变量 XAI_API_KEY 或 AI_API_KEY 后重启。公开页面只会显示服务暂不可用。');
  } else {
    console.log('[ai] 已配置 provider=' + cfg.provider + ' model=' + cfg.model + ' base=' + cfg.baseHost + ' keyKind=' + cfg.keyKind + ' key=' + maskSecret(cfg.apiKey) + (cfg.baseInvalid ? ' (已忽略无效的 AI_API_BASE)' : ''));
    if (!cfg.keyLooksValid) {
      console.warn('[ai] 密钥格式不正确。xAI 密钥必须以 xai- 开头，团队 UUID 不能当作密钥。');
    } else {
      probeAi().then((p) => {
        if (p.ok) console.log('[ai] probe ok, xAI accepted the key');
        else console.warn('[ai] probe failed', p.status || p.reason);
      }).catch((e) => console.warn('[ai] probe error', e.message));
    }
  }
  console.log(`XHS Content Agent running at http://localhost:${PORT}`);
});
