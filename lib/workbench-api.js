const fs = require('fs');
const path = require('path');
const { resolveAiConfig, callChat, generateImage, AiError } = require('./ai');
const { createAuth, hashPassword } = require('./auth');
const { extractText } = require('./extract');
const { findDuplicates, suggestAngle } = require('./duplicate');
const { DEFAULT_AGENT, buildContext, detectIntent, isLegacyAgent } = require('./agent');
const { parseAgentReply } = require('./parse-output');
const { chunkText, searchChunks, lookupOfficial } = require('./retrieve');
const { startJobRunner } = require('./jobs');

const STATUSES = ['Draft', 'Fact Check', 'Compliance Review', 'Design Review', 'Approved', 'Scheduled', 'Published', 'Rejected'];
const REVIEW_NEXT = {
  Draft: 'Fact Check',
  'Fact Check': 'Compliance Review',
  'Compliance Review': 'Design Review',
  'Design Review': 'Approved'
};

function saveBase64File(filePath, dataUrl) {
  const raw = String(dataUrl || '');
  const comma = raw.indexOf(',');
  const payload = comma >= 0 ? raw.slice(comma + 1) : raw;
  if (!payload) throw new Error('empty file');
  const buf = Buffer.from(payload, 'base64');
  if (!buf.length) throw new Error('empty file');
  if (buf.length > 12 * 1024 * 1024) throw new Error('file too large');
  fs.writeFileSync(filePath, buf);
  return buf.length;
}

module.exports = function attachWorkbench(ctx) {
  const {
    app, lists, persistList, readData, writeData, ensureDataFile,
    DATA_DIR, newId, auth: passedAuth
  } = ctx;

  ensureDataFile('agent.json', DEFAULT_AGENT);
  ensureDataFile('knowledge.json', { items: [] });
  ensureDataFile('contents.json', { items: [] });
  ensureDataFile('metrics.json', { items: [] });
  ensureDataFile('chat.json', { items: [] });
  ensureDataFile('suggestions.json', { items: [] });

  lists.knowledge = lists.knowledge || { items: (readData('knowledge.json') || { items: [] }).items || [] };
  lists.contents = lists.contents || { items: (readData('contents.json') || { items: [] }).items || [] };
  lists.metrics = lists.metrics || { items: (readData('metrics.json') || { items: [] }).items || [] };
  lists.chat = lists.chat || { items: (readData('chat.json') || { items: [] }).items || [] };
  lists.suggestions = lists.suggestions || { items: (readData('suggestions.json') || { items: [] }).items || [] };
  lists.chunks = lists.chunks || loadOrInit('chunks.json');
  lists.jobs = lists.jobs || loadOrInit('jobs.json');
  lists.logs = lists.logs || loadOrInit('logs.json');

  function loadOrInit(file) {
    ensureDataFile(file, { items: [] });
    const data = readData(file);
    return { items: (data && data.items) || [] };
  }

  const KNOW_DIR = path.join(DATA_DIR, 'knowledge');
  const POSTER_DIR = path.join(DATA_DIR, 'posters');
  [KNOW_DIR, POSTER_DIR].forEach((d) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

  const auth = passedAuth || createAuth(ctx);

  function settings() {
    return readData('settings.json') || {};
  }

  function agentRules() {
    const file = readData('agent.json') || {};
    const merged = isLegacyAgent(file) ? { ...DEFAULT_AGENT } : { ...DEFAULT_AGENT, ...file };
    if (isLegacyAgent(file) || !file.roleName || !file.slogan) {
      writeData('agent.json', { ...merged, updatedAt: new Date().toISOString() });
    }
    return merged;
  }

  function corpus() {
    return [
      ...lists.contents.items,
      ...lists.posts.items.map((p) => ({ id: p.id, title: p.title, body: p.content, createdAt: p.createdAt })),
      ...lists.feed.items.map((f) => ({ id: f.id, title: (f.caption || '').split('\n')[0], body: f.caption, createdAt: f.createdAt }))
    ];
  }

  function attachUser(req, res, next) {
    req.user = auth.currentUser(req);
    next();
  }

  app.use('/api', attachUser);

  app.get('/api/me', (req, res) => {
    const cfg = resolveAiConfig(settings());
    res.json({
      user: auth.publicUser(req.user) || { id: 'open', name: 'CPLUS', role: 'admin' },
      authRequired: false,
      ai: {
        configured: cfg.configured,
        source: cfg.source,
        provider: cfg.provider,
        model: cfg.model,
        imageConfigured: cfg.imageConfigured
      }
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = auth.clientKey(req);
    if (auth.locked(ip)) return res.status(429).json({ error: '尝试过多，请 15 分钟后再试' });
    const name = (req.body && (req.body.name || req.body.user)) || '';
    const password = (req.body && req.body.password) || '';
    const result = auth.login(name, password);
    if (!result) {
      auth.hitFail(ip);
      return res.status(401).json({ error: '账号或密码不正确' });
    }
    auth.clearFail(ip);
    auth.setSessionCookie(res, result.sid);
    res.json({ success: true, user: result.user });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.logout(req);
    auth.clearSessionCookie(res);
    res.json({ success: true });
  });

  app.get('/api/users', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
    res.json({
      items: auth.loadUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })),
      authRequired: true
    });
  });

  app.post('/api/users', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
    const items = auth.loadUsers();
    if (req.body.user) {
      const u = req.body.user;
      const idx = items.findIndex((x) => x.id === u.id);
      const next = {
        id: u.id || newId(),
        name: u.name || 'User',
        role: ['admin', 'editor', 'reviewer'].includes(u.role) ? u.role : 'editor'
      };
      if (u.password) next.passwordHash = hashPassword(u.password);
      if (idx >= 0) items[idx] = { ...items[idx], ...next };
      else {
        if (!next.passwordHash) return res.status(400).json({ error: '新用户必须设置密码' });
        items.push({ ...next, createdAt: new Date().toISOString() });
      }
      auth.saveUsers(items);
    }
    res.json({ success: true, items: auth.loadUsers().map((u) => ({ id: u.id, name: u.name, role: u.role })) });
  });

  app.get('/api/agent', (req, res) => {
    res.json(agentRules());
  });

  app.post('/api/agent', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可改系统规则' });
    const cur = agentRules();
    const next = { ...cur, ...req.body, updatedAt: new Date().toISOString() };
    writeData('agent.json', next);
    res.json({ success: true, agent: next });
  });

  app.get('/api/ai/status', (req, res) => {
    const cfg = resolveAiConfig(settings());
    res.json({ configured: cfg.configured, source: cfg.source, model: cfg.model });
  });

  function addLog(row) {
    const item = {
      id: newId(),
      kind: row.kind || 'chat',
      user_name: (reqUserName(row) || ''),
      model: row.model || '',
      status: row.status,
      intent: row.intent || '',
      meta: { message: (row.message || '').slice(0, 200) },
      createdAt: new Date().toISOString()
    };
    lists.logs.items.push(item);
    if (lists.logs.items.length > 300) lists.logs.items = lists.logs.items.slice(-300);
    persistList('logs');
    if (global.__cplusDb && global.__cplusDb.log) {
      global.__cplusDb.log({ ...item, created_at: item.createdAt }).catch(() => {});
    }
  }
  function reqUserName(row) {
    return row.user || '';
  }

  app.post('/api/agent/chat', async (req, res) => {
    if (!['admin', 'editor', 'reviewer'].includes(req.user.role)) {
      return res.status(403).json({ error: '没有权限' });
    }
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: '先输入一句指令' });
    const intent = (req.body && req.body.intent) || detectIntent(message);
    const cfg = resolveAiConfig(settings());

    if (!cfg.configured) {
      addLog({ kind: 'chat', user: req.user.name, status: 'unconfigured', intent, message, model: '' });
      return res.status(503).json({
        error: 'AI 未配置，无法生成内容。',
        code: 'AI_API_NOT_CONFIGURED',
        setup: req.user.role === 'admin' ? {
          vars: ['AI_PROVIDER=openai 或 gemini', 'AI_API_KEY', 'AI_MODEL', '可选 IMAGE_API_KEY', '可选 DATABASE_URL'],
          hint: '在 Render Dashboard → Environment 添加 AI_API_KEY 后手动 Deploy。密钥不会出现在前端。'
        } : { hint: '请联系管理员配置 AI 接口。' }
      });
    }

    const hits = searchChunks(lists.chunks.items, message, 8);
    const knowledgeHits = hits.map((h) => ({
      id: h.chunk.knowledgeId,
      name: h.chunk.name,
      category: h.chunk.category || '',
      excerpt: h.chunk.text,
      expired: h.expired
    }));
    const packed = buildContext({
      agent: agentRules(),
      rules: readData('rules.json'),
      knowledge: knowledgeHits.length ? knowledgeHits : lists.knowledge.items,
      feed: lists.feed.items,
      contents: lists.contents.items,
      materials: lists.materials.items,
      message
    });
    let official = [];
    try {
      official = await lookupOfficial(message);
    } catch (e) {
      official = [];
    }
    const officialText = official.length
      ? '\n\n## 官方页面摘录（查询日期已注明，未抓取成功的不得编造）\n' + official.map((o) => `${o.name} ${o.url} @ ${o.fetchedAt}\n${o.ok ? o.excerpt.slice(0, 1200) : '【待人工确认：未能访问】 ' + o.note}`).join('\n\n')
      : '';
    const extra = packed.duplicates.length
      ? `\n\n系统重复提醒：${packed.duplicates.map((d) => `${d.title}（标题${d.titleScore}/主题${d.topicScore}/正文${d.bodyScore}）`).join('；')}。${packed.dupHint}`
      : '';

    const record = {
      id: newId(),
      user: req.user.name,
      role: req.user.role,
      intent,
      message,
      model: cfg.model,
      createdAt: new Date().toISOString()
    };

    try {
      const reply = await callChat([
        { role: 'system', content: packed.system },
        { role: 'user', content: packed.user + officialText + extra }
      ], settings(), { timeoutMs: 120000, retries: 2 });
      const parsed = parseAgentReply(reply, intent);
      record.mode = 'ai';
      record.status = 'ok';
      record.reply = parsed.visible;
      record.parsed = { type: parsed.type, count: parsed.items.length };
      lists.chat.items.push(record);
      persistList('chat');
      addLog({ kind: 'chat', user: req.user.name, status: 'ok', intent, message, model: cfg.model });
      const expired = knowledgeHits.filter((k) => k.expired).map((k) => k.name);
      res.json({
        success: true,
        mode: 'ai',
        intent,
        reply: parsed.visible,
        structured: parsed,
        sources: packed.sources.concat(official.map((o) => ({ type: 'official', name: o.name, url: o.url, fetchedAt: o.fetchedAt }))),
        official,
        duplicates: packed.duplicates,
        dupHint: packed.dupHint,
        expiredSources: expired
      });
    } catch (e) {
      const code = e instanceof AiError ? e.code : 'ERROR';
      addLog({ kind: 'chat', user: req.user.name, status: 'error', intent, message, model: cfg.model });
      record.status = 'error';
      record.error = e.message;
      lists.chat.items.push(record);
      persistList('chat');
      res.status(code === 'AI_API_NOT_CONFIGURED' ? 503 : 502).json({
        error: e.message,
        code
      });
    }
  });

  app.post('/api/agent/rewrite', async (req, res) => {
    const { field, instruction, current } = req.body || {};
    if (!current) return res.status(400).json({ error: '没有可改写的内容' });
    const cfg = resolveAiConfig(settings());
    const packed = buildContext({
      agent: agentRules(),
      rules: readData('rules.json'),
      knowledge: lists.knowledge.items,
      feed: lists.feed.items,
      contents: lists.contents.items,
      materials: lists.materials.items,
      message: `请只改写「${field || '正文'}」。要求：${instruction || '更自然'}。原文：\n${current}`
    });
    if (!cfg.configured) {
      return res.status(503).json({ error: 'AI 未配置，无法改写。', code: 'AI_API_NOT_CONFIGURED' });
    }
    try {
      const reply = await callChat([
        { role: 'system', content: packed.system + '\n只输出改写后的该字段，不要其他解释。' },
        { role: 'user', content: packed.user }
      ], settings(), { maxTokens: 2500, retries: 1 });
      res.json({ success: true, mode: 'ai', reply, sources: packed.sources });
    } catch (e) {
      res.status(502).json({ error: e.message, code: e.code || 'ERROR' });
    }
  });

  app.get('/api/knowledge', (req, res) => {
    res.json({ items: lists.knowledge.items.map((k) => ({ ...k, excerpt: (k.excerpt || '').slice(0, 400) })) });
  });

  app.post('/api/knowledge', async (req, res) => {
    if (!['admin', 'editor'].includes(req.user.role)) return res.status(403).json({ error: '没有权限' });
    const raw = req.body || {};
    const id = newId();
    const item = {
      id,
      name: raw.name || raw.filename || '未命名资料',
      category: raw.category || '其他',
      business: raw.business || '',
      jurisdiction: raw.jurisdiction || '香港',
      uploadedAt: new Date().toISOString(),
      expiresAt: raw.expiresAt || '',
      needsUpdate: !!raw.needsUpdate,
      sourceType: raw.sourceType || 'upload',
      filename: '',
      mime: raw.mime || '',
      excerpt: raw.excerpt || raw.text || '',
      uploadedBy: req.user.name
    };
    if (raw.dataUrl) {
      const ext = path.extname(raw.filename || raw.name || '').toLowerCase() || '.bin';
      const filename = id + ext;
      const abs = path.join(KNOW_DIR, filename);
      try {
        saveBase64File(abs, raw.dataUrl);
        item.filename = filename;
        item.mime = raw.mime || '';
        if (!item.excerpt) item.excerpt = await extractText(abs, item.mime, raw.filename || filename);
      } catch (e) {
        return res.status(400).json({ error: '文件无法保存：' + e.message });
      }
    }
    if (raw.url && !raw.dataUrl) {
      item.sourceType = 'url';
      item.url = raw.url;
      item.excerpt = item.excerpt || raw.text || raw.url;
    }
    lists.knowledge.items.push(item);
    persistList('knowledge');
    const chunks = chunkText(item.excerpt || '', item.name, {
      id: item.id,
      category: item.category,
      business: item.business,
      jurisdiction: item.jurisdiction,
      expiresAt: item.expiresAt
    });
    lists.chunks.items = lists.chunks.items.filter((c) => c.knowledgeId !== item.id).concat(chunks);
    persistList('chunks');
    if (global.__cplusDb && global.__cplusDb.replaceChunks) {
      global.__cplusDb.replaceChunks(item.id, chunks).catch(() => {});
    }
    if (raw.dataUrl && global.__cplusDb && global.__cplusDb.saveFile) {
      const comma = String(raw.dataUrl).indexOf(',');
      const buf = Buffer.from(String(raw.dataUrl).slice(comma + 1), 'base64');
      global.__cplusDb.saveFile(item.id, item.name, item.mime, buf).catch(() => {});
    }
    res.json({ success: true, item, items: lists.knowledge.items, chunkCount: chunks.length });
  });

  app.post('/api/knowledge/:id/reindex', async (req, res) => {
    if (!['admin', 'editor'].includes(req.user.role)) return res.status(403).json({ error: '没有权限' });
    const item = lists.knowledge.items.find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const chunks = chunkText(item.excerpt || '', item.name, {
      id: item.id,
      category: item.category,
      business: item.business,
      jurisdiction: item.jurisdiction,
      expiresAt: item.expiresAt
    });
    lists.chunks.items = lists.chunks.items.filter((c) => c.knowledgeId !== item.id).concat(chunks);
    persistList('chunks');
    res.json({ success: true, chunkCount: chunks.length });
  });

  app.put('/api/knowledge/:id', (req, res) => {
    if (!['admin', 'editor'].includes(req.user.role)) return res.status(403).json({ error: '没有权限' });
    const idx = lists.knowledge.items.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const allow = ['name', 'category', 'business', 'jurisdiction', 'expiresAt', 'needsUpdate', 'excerpt', 'sourceType'];
    allow.forEach((k) => {
      if (req.body[k] != null) lists.knowledge.items[idx][k] = req.body[k];
    });
    persistList('knowledge');
    res.json({ success: true, item: lists.knowledge.items[idx] });
  });

  app.delete('/api/knowledge/:id', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可删除资料' });
    const item = lists.knowledge.items.find((x) => x.id === req.params.id);
    lists.knowledge.items = lists.knowledge.items.filter((x) => x.id !== req.params.id);
    persistList('knowledge');
    lists.chunks.items = lists.chunks.items.filter((c) => c.knowledgeId !== req.params.id);
    persistList('chunks');
    if (item && item.filename) {
      const abs = path.join(KNOW_DIR, item.filename);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
    res.json({ success: true, items: lists.knowledge.items });
  });

  app.get('/api/knowledge/file/:id', (req, res) => {
    const item = lists.knowledge.items.find((x) => x.id === req.params.id);
    if (!item || !item.filename) return res.status(404).end();
    const abs = path.join(KNOW_DIR, item.filename);
    if (!fs.existsSync(abs)) return res.status(404).end();
    res.sendFile(abs);
  });

  app.post('/api/contents/batch', (req, res) => {
    if (!['admin', 'editor'].includes(req.user.role)) return res.status(403).json({ error: '没有权限' });
    const incoming = Array.isArray(req.body.items) ? req.body.items : [];
    if (!incoming.length) return res.status(400).json({ error: '没有可保存的条目' });
    const created = [];
    const warnings = [];
    incoming.forEach((raw) => {
      const item = {
        id: newId(),
        title: raw.title || '',
        subtitle: raw.subtitle || '',
        body: raw.body || '',
        cta: raw.cta || agentRules().fixedCta,
        hashtags: raw.hashtags || agentRules().fixedHashtags,
        posterNotes: raw.posterNotes || '',
        sources: raw.sourcesText ? [{ name: raw.sourcesText }] : (raw.sources || []),
        pendingConfirm: raw.pendingConfirm || '',
        riskNote: raw.riskNote || '',
        audience: raw.audience || '',
        purpose: raw.purpose || '',
        pain: raw.pain || '',
        offer: raw.offer || '',
        publishAt: raw.publishAt || '',
        topic: raw.topic || raw.title || '',
        businessCategory: raw.businessCategory || raw.offer || '',
        platform: raw.platform || '小红书',
        owner: raw.owner || req.user.name,
        status: 'Draft',
        reviewNotes: '',
        posterUrl: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metrics: {}
      };
      const dups = findDuplicates(item, corpus());
      if (dups.length) warnings.push({ id: item.id, title: item.title, duplicates: dups, dupHint: suggestAngle(dups) });
      lists.contents.items.push(item);
      created.push(item);
    });
    persistList('contents');
    res.json({ success: true, items: created, warnings, all: lists.contents.items });
  });

  app.get('/api/contents', (req, res) => {
    res.json({ items: lists.contents.items });
  });

  app.post('/api/contents', (req, res) => {
    if (!['admin', 'editor'].includes(req.user.role)) return res.status(403).json({ error: '没有权限' });
    const raw = req.body || {};
    const item = {
      id: newId(),
      title: raw.title || '',
      subtitle: raw.subtitle || '',
      body: raw.body || '',
      cta: raw.cta || agentRules().fixedCta,
      hashtags: raw.hashtags || agentRules().fixedHashtags,
      posterNotes: raw.posterNotes || '',
      sources: raw.sources || [],
      pendingConfirm: raw.pendingConfirm || '',
      riskNote: raw.riskNote || '',
      audience: raw.audience || '',
      purpose: raw.purpose || '',
      publishAt: raw.publishAt || '',
      topic: raw.topic || raw.title || '',
      businessCategory: raw.businessCategory || '',
      platform: raw.platform || '小红书',
      owner: raw.owner || req.user.name,
      status: 'Draft',
      reviewNotes: '',
      posterUrl: raw.posterUrl || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metrics: raw.metrics || {}
    };
    if (['Scheduled', 'Published', 'Approved'].includes(raw.status)) {
      return res.status(400).json({ error: '新内容必须从 Draft 进入审核，AI 不能自行批准或发布' });
    }
    const dups = findDuplicates(item, corpus());
    lists.contents.items.push(item);
    persistList('contents');
    res.json({ success: true, item, duplicates: dups, dupHint: suggestAngle(dups), items: lists.contents.items });
  });

  app.put('/api/contents/:id', (req, res) => {
    const idx = lists.contents.items.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const cur = lists.contents.items[idx];
    const nextStatus = req.body.status;
    if (nextStatus && !STATUSES.includes(nextStatus)) {
      return res.status(400).json({ error: '未知状态' });
    }
    if (nextStatus === 'Scheduled' || nextStatus === 'Published') {
      if (cur.status !== 'Approved' && nextStatus === 'Scheduled') {
        return res.status(400).json({ error: '须先 Approved 才能 Scheduled' });
      }
      if (nextStatus === 'Published' && !['Approved', 'Scheduled'].includes(cur.status)) {
        return res.status(400).json({ error: '须先批准并排期后才能 Published' });
      }
    }
    if (nextStatus && ['Fact Check', 'Compliance Review', 'Design Review', 'Approved', 'Rejected'].includes(nextStatus)) {
      if (!['admin', 'reviewer'].includes(req.user.role) && nextStatus !== 'Fact Check') {
        return res.status(403).json({ error: '审核状态仅审核员或管理员可改' });
      }
    }
    const next = { ...cur, ...req.body, id: cur.id, updatedAt: new Date().toISOString() };
    if (next.status === 'Draft' && cur.status === 'Published') next.status = cur.status;
    lists.contents.items[idx] = next;
    persistList('contents');
    const dups = findDuplicates(next, corpus());
    res.json({ success: true, item: next, duplicates: dups, dupHint: suggestAngle(dups) });
  });

  app.post('/api/contents/:id/submit', (req, res) => {
    const idx = lists.contents.items.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const cur = lists.contents.items[idx];
    const nextStatus = REVIEW_NEXT[cur.status] || 'Fact Check';
    lists.contents.items[idx] = {
      ...cur,
      status: nextStatus,
      reviewNotes: req.body.note || cur.reviewNotes,
      updatedAt: new Date().toISOString()
    };
    persistList('contents');
    res.json({ success: true, item: lists.contents.items[idx] });
  });

  app.post('/api/contents/:id/poster', (req, res) => {
    const idx = lists.contents.items.findIndex((x) => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    if (!req.body.dataUrl) return res.status(400).json({ error: '没有图片' });
    const filename = req.params.id + '.png';
    const abs = path.join(POSTER_DIR, filename);
    try {
      saveBase64File(abs, req.body.dataUrl);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    lists.contents.items[idx].posterUrl = '/api/posters/' + filename;
    lists.contents.items[idx].updatedAt = new Date().toISOString();
    persistList('contents');
    res.json({ success: true, item: lists.contents.items[idx] });
  });

  app.get('/api/posters/:file', (req, res) => {
    const abs = path.join(POSTER_DIR, path.basename(req.params.file));
    if (!fs.existsSync(abs)) return res.status(404).end();
    res.sendFile(abs);
  });

  app.delete('/api/contents/:id', (req, res) => {
    if (!['admin', 'editor'].includes(req.user.role)) return res.status(403).json({ error: '没有权限' });
    lists.contents.items = lists.contents.items.filter((x) => x.id !== req.params.id);
    persistList('contents');
    res.json({ success: true, items: lists.contents.items });
  });

  app.post('/api/duplicate-check', (req, res) => {
    const hits = findDuplicates(req.body || {}, corpus());
    res.json({ duplicates: hits, dupHint: suggestAngle(hits) });
  });

  app.get('/api/metrics', (req, res) => {
    res.json({ items: lists.metrics.items });
  });

  app.post('/api/metrics', (req, res) => {
    if (!['admin', 'editor', 'reviewer'].includes(req.user.role)) return res.status(403).json({ error: '没有权限' });
    const item = {
      id: newId(),
      contentId: req.body.contentId || '',
      title: req.body.title || '',
      impressions: Number(req.body.impressions) || 0,
      clicks: Number(req.body.clicks) || 0,
      likes: Number(req.body.likes) || 0,
      saves: Number(req.body.saves) || 0,
      comments: Number(req.body.comments) || 0,
      shares: Number(req.body.shares) || 0,
      follows: Number(req.body.follows) || 0,
      leads: Number(req.body.leads) || 0,
      deals: Number(req.body.deals) || 0,
      note: req.body.note || '',
      createdAt: new Date().toISOString()
    };
    lists.metrics.items.push(item);
    persistList('metrics');
    if (item.contentId) {
      const c = lists.contents.items.find((x) => x.id === item.contentId);
      if (c) c.metrics = item;
      persistList('contents');
    }
    res.json({ success: true, item, items: lists.metrics.items });
  });

  app.post('/api/review/suggest', async (req, res) => {
    if (req.user.role !== 'admin' && req.user.role !== 'reviewer') {
      return res.status(403).json({ error: '仅审核员或管理员可生成规则建议' });
    }
    const packed = buildContext({
      agent: agentRules(),
      rules: readData('rules.json'),
      knowledge: lists.knowledge.items,
      feed: lists.feed.items,
      contents: lists.contents.items,
      materials: lists.materials.items,
      message: '根据这些笔记数据给出选题建议和规则迭代建议，不要直接覆盖正式规则。\n' + JSON.stringify(lists.metrics.items.slice(-20))
    });
    const cfg = resolveAiConfig(settings());
    let reply = '';
    if (cfg.configured) {
      try {
        reply = await callChat([
          { role: 'system', content: packed.system },
          { role: 'user', content: packed.user }
        ], settings(), { retries: 1 });
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    } else {
      reply = '未配置 AI。请把数据较好的选题做成「清单/对比/办理顺序」，较差的避免空泛牌照概念。规则改动须管理员确认。';
    }
    const suggestion = {
      id: newId(),
      reply,
      status: 'pending',
      createdAt: new Date().toISOString(),
      createdBy: req.user.name
    };
    lists.suggestions.items.push(suggestion);
    persistList('suggestions');
    res.json({ success: true, suggestion, notice: '建议未写入正式规则，须管理员确认。' });
  });

  app.post('/api/review/apply', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可确认写入规则' });
    const sug = lists.suggestions.items.find((s) => s.id === req.body.id);
    if (!sug) return res.status(404).json({ error: '找不到建议' });
    sug.status = 'applied';
    sug.appliedAt = new Date().toISOString();
    persistList('suggestions');
    const rules = readData('rules.json') || {};
    rules.iterations = rules.iterations || [];
    rules.iterations.push({ date: new Date().toISOString(), summary: '管理员确认的复盘建议', content: sug.reply });
    writeData('rules.json', rules);
    res.json({ success: true, rules });
  });

  app.get('/api/suggestions', (req, res) => {
    res.json({ items: lists.suggestions.items });
  });

  const oldExport = app._router && app._router.stack;
  void oldExport;

  app.post('/api/posters/ai', async (req, res) => {
    if (!['admin', 'editor'].includes(req.user.role)) return res.status(403).json({ error: '没有权限' });
    const title = (req.body && req.body.title) || '';
    const subtitle = (req.body && req.body.subtitle) || '';
    const points = (req.body && req.body.points) || [];
    const cfg = resolveAiConfig(settings());
    if (!cfg.imageConfigured) {
      return res.status(503).json({
        error: '图片模型未配置。请使用快速模板海报，或设置 IMAGE_API_KEY。',
        code: 'IMAGE_NOT_CONFIGURED',
        mode: 'template'
      });
    }
    const visualPrompt = [
      'Professional fintech corporate poster background, no text, no letters, no watermark, no QR code, no government logos.',
      'Deep navy blue, cobalt, white, subtle gold or teal accents.',
      'Clean international finance / compliance atmosphere, Hong Kong skyline or abstract license geometry, generous whitespace.',
      'Vertical 4:5 composition, high-end, not cluttered.',
      title ? 'Theme: ' + title : ''
    ].join(' ');
    try {
      const img = await generateImage(visualPrompt, settings(), { size: '1024x1792' });
      addLog({ kind: 'image', user: req.user.name, status: 'ok', intent: 'poster', message: title, model: cfg.imageModel });
      res.json({
        success: true,
        mode: 'ai-visual',
        visual: img.dataUrl,
        overlay: { title, subtitle, points: Array.isArray(points) ? points.slice(0, 3) : String(points).split('\n').slice(0, 3), brand: 'CPLUS GROUP' }
      });
    } catch (e) {
      addLog({ kind: 'image', user: req.user.name, status: 'error', intent: 'poster', message: title, model: cfg.imageModel });
      res.status(502).json({ error: e.message, code: e.code || 'ERROR', mode: 'template' });
    }
  });

  app.get('/api/logs', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
    res.json({ items: (lists.logs.items || []).slice(-100).reverse() });
  });

  app.get('/api/jobs', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
    res.json({ items: lists.jobs.items || [] });
  });

  app.post('/api/jobs', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
    const job = {
      id: newId(),
      type: req.body.type || 'weekly_generate',
      payload: req.body.payload || {},
      runAt: req.body.runAt || new Date(Date.now() + 60000).toISOString(),
      status: 'queued',
      error: '',
      createdAt: new Date().toISOString(),
      createdBy: req.user.name
    };
    lists.jobs.items.push(job);
    persistList('jobs');
    res.json({ success: true, item: job, items: lists.jobs.items });
  });

  startJobRunner({
    lists,
    persistList,
    runJob: async (job) => {
      if (job.type !== 'weekly_generate') throw new Error('未知任务类型');
      const cfg = resolveAiConfig(settings());
      if (!cfg.configured) throw new Error('AI 未配置');
      const message = (job.payload && job.payload.message) || '生成本周3篇小红书内容。';
      const packed = buildContext({
        agent: agentRules(),
        rules: readData('rules.json'),
        knowledge: lists.knowledge.items,
        feed: lists.feed.items,
        contents: lists.contents.items,
        materials: lists.materials.items,
        message
      });
      const reply = await callChat([
        { role: 'system', content: packed.system },
        { role: 'user', content: packed.user }
      ], settings(), { timeoutMs: 120000, retries: 1 });
      const parsed = parseAgentReply(reply, 'week');
      return { preview: (parsed.visible || '').slice(0, 500), count: parsed.items.length };
    }
  });

  app.get('/api/export-full', (req, res) => {
    res.json({
      rules: readData('rules.json'),
      agent: agentRules(),
      materials: { items: lists.materials.items },
      schedules: { items: lists.schedules.items },
      posts: { items: lists.posts.items },
      feed: { items: lists.feed.items },
      knowledge: { items: lists.knowledge.items.map((k) => ({ ...k, excerpt: (k.excerpt || '').slice(0, 2000) })) },
      contents: { items: lists.contents.items },
      metrics: { items: lists.metrics.items },
      suggestions: { items: lists.suggestions.items },
      exportedAt: new Date().toISOString()
    });
  });
};
