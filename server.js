const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3210;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return data;
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
  materialConstraint: '输入素材来自 CPLUS GROUP LIMITED (HK) 公众号文章。严禁直接复制原文段落；只萃取核心论点、案例、数据后重新解构重组；剔除铺垫、客套、文末商务推广。',
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
  if (!settings.apiBaseUrl || !settings.apiKey) {
    throw new Error('AI_API_NOT_CONFIGURED');
  }

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const baseUrl = settings.apiBaseUrl.replace(/\/$/, '');
  // Support both full endpoint URLs and base URLs
  const url = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : baseUrl.includes('/v1')
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;

  const body = JSON.stringify({
    model: settings.model || 'gpt-4o',
    messages: messages,
    temperature: 0.8,
    max_tokens: 8000
  });

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`AI API returned ${res.statusCode}: ${data.substring(0, 500)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || '';
          resolve(content);
        } catch (e) {
          reject(new Error(`Failed to parse AI response: ${e.message}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(body);
    req.end();
  });
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
  // Mask API key for security
  res.json({
    ...settings,
    apiKey: settings.apiKey ? settings.apiKey.substring(0, 4) + '****' + settings.apiKey.substring(settings.apiKey.length - 4) : '',
    apiKeyConfigured: !!settings.apiKey
  });
});

app.post('/api/settings', (req, res) => {
  const current = readData('settings.json');
  const updates = req.body;
  // Don't overwrite API key with masked value
  if (updates.apiKey && updates.apiKey.includes('****')) {
    delete updates.apiKey;
  }
  const newSettings = { ...current, ...updates };
  writeData('settings.json', newSettings);
  res.json({ success: true, settings: { ...newSettings, apiKey: newSettings.apiKey ? newSettings.apiKey.substring(0, 4) + '****' + newSettings.apiKey.substring(newSettings.apiKey.length - 4) : '', apiKeyConfigured: !!newSettings.apiKey } });
});

// --- Rules ---
app.get('/api/rules', (req, res) => {
  const rules = readData('rules.json');
  res.json(rules);
});

app.post('/api/rules', (req, res) => {
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
  const data = readData('materials.json');
  res.json(data);
});

app.post('/api/materials', (req, res) => {
  const data = readData('materials.json');
  const item = {
    id: Date.now().toString(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  data.items.push(item);
  writeData('materials.json', data);
  res.json({ success: true, item });
});

app.put('/api/materials/:id', (req, res) => {
  const data = readData('materials.json');
  const idx = data.items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.items[idx] = { ...data.items[idx], ...req.body, id: req.params.id };
  writeData('materials.json', data);
  res.json({ success: true, item: data.items[idx] });
});

app.delete('/api/materials/:id', (req, res) => {
  const data = readData('materials.json');
  data.items = data.items.filter(i => i.id !== req.params.id);
  writeData('materials.json', data);
  res.json({ success: true });
});

// --- Schedules ---
app.get('/api/schedules', (req, res) => {
  const data = readData('schedules.json');
  res.json(data);
});

app.post('/api/schedules', (req, res) => {
  const data = readData('schedules.json');
  const item = {
    id: Date.now().toString(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  data.items.push(item);
  writeData('schedules.json', data);
  res.json({ success: true, item });
});

app.delete('/api/schedules/:id', (req, res) => {
  const data = readData('schedules.json');
  data.items = data.items.filter(i => i.id !== req.params.id);
  writeData('schedules.json', data);
  res.json({ success: true });
});

// --- Posts ---
app.get('/api/posts', (req, res) => {
  const data = readData('posts.json');
  res.json(data);
});

app.post('/api/posts', (req, res) => {
  const data = readData('posts.json');
  const item = {
    id: Date.now().toString(),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  data.items.push(item);
  writeData('posts.json', data);
  res.json({ success: true, item });
});

app.put('/api/posts/:id', (req, res) => {
  const data = readData('posts.json');
  const idx = data.items.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  data.items[idx] = { ...data.items[idx], ...req.body, id: req.params.id };
  writeData('posts.json', data);
  res.json({ success: true, item: data.items[idx] });
});

app.delete('/api/posts/:id', (req, res) => {
  const data = readData('posts.json');
  data.items = data.items.filter(i => i.id !== req.params.id);
  writeData('posts.json', data);
  res.json({ success: true });
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

// --- Export all data ---
app.get('/api/export', (req, res) => {
  const data = {
    rules: readData('rules.json'),
    materials: readData('materials.json'),
    schedules: readData('schedules.json'),
    posts: readData('posts.json'),
    settings: { ...readData('settings.json'), apiKey: '***' },
    exportedAt: new Date().toISOString()
  };
  res.json(data);
});

// --- Import data ---
app.post('/api/import', (req, res) => {
  const { rules, materials, schedules, posts } = req.body;
  if (rules) writeData('rules.json', rules);
  if (materials) writeData('materials.json', materials);
  if (schedules) writeData('schedules.json', schedules);
  if (posts) writeData('posts.json', posts);
  res.json({ success: true });
});

app.get('/healthz', (req, res) => {
  res.status(200).type('text').send('ok');
});

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`XHS Content Agent running at http://localhost:${PORT}`);
});
