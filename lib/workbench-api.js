const fs = require('fs');
const path = require('path');
const { resolveAiConfig, callChat, AiError } = require('./ai');
const { createAuth } = require('./auth');
const { extractText } = require('./extract');
const { findDuplicates, suggestAngle } = require('./duplicate');
const { DEFAULT_AGENT, buildContext, detectIntent } = require('./agent');

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
    DATA_DIR, newId, buildProduceBrief
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

  const KNOW_DIR = path.join(DATA_DIR, 'knowledge');
  const POSTER_DIR = path.join(DATA_DIR, 'posters');
  [KNOW_DIR, POSTER_DIR].forEach((d) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

  const auth = createAuth(ctx);

  function settings() {
    return readData('settings.json') || {};
  }

  function agentRules() {
    return { ...DEFAULT_AGENT, ...(readData('agent.json') || {}) };
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
    res.json({
      user: auth.publicUser(req.user),
      authRequired: auth.authRequired(),
      ai: (() => {
        const cfg = resolveAiConfig(settings());
        return { configured: cfg.configured, source: cfg.source, model: cfg.model };
      })()
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const pin = (req.body && req.body.pin) || '';
    const result = auth.login(pin);
    if (!result) return res.status(401).json({ error: '口令不正确' });
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
      authRequired: auth.authRequired()
    });
  });

  app.post('/api/users', (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
    const items = auth.loadUsers();
    if (req.body.authRequired != null) {
      writeData('settings.json', { ...settings(), authRequired: !!req.body.authRequired });
    }
    if (req.body.user) {
      const u = req.body.user;
      const idx = items.findIndex((x) => x.id === u.id);
      const next = {
        id: u.id || newId(),
        name: u.name || 'User',
        role: ['admin', 'editor', 'reviewer'].includes(u.role) ? u.role : 'editor',
        pin: u.pin || String(Math.floor(1000 + Math.random() * 9000))
      };
      if (idx >= 0) items[idx] = { ...items[idx], ...next, pin: u.pin || items[idx].pin };
      else items.push(next);
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

  app.post('/api/agent/chat', async (req, res) => {
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: '先输入一句指令' });
    const intent = (req.body && req.body.intent) || detectIntent(message);
    const packed = buildContext({
      agent: agentRules(),
      rules: readData('rules.json'),
      knowledge: lists.knowledge.items,
      feed: lists.feed.items,
      contents: lists.contents.items,
      materials: lists.materials.items,
      message
    });
    const cfg = resolveAiConfig(settings());
    const record = {
      id: newId(),
      user: req.user.name,
      role: req.user.role,
      intent,
      message,
      sources: packed.sources,
      duplicates: packed.duplicates,
      createdAt: new Date().toISOString()
    };

    if (!cfg.configured) {
      const brief = buildProduceBrief(readData('rules.json'), lists.feed.items, message);
      record.mode = 'brief';
      record.reply = brief;
      lists.chat.items.push(record);
      persistList('chat');
      return res.json({
        success: true,
        mode: 'brief',
        intent,
        reply: brief,
        sources: packed.sources,
        duplicates: packed.duplicates,
        dupHint: packed.dupHint,
        notice: '未配置服务器 AI。已按规则和旧帖打包任务，可复制到外部模型，或让管理员配置 Render 的 AI_API_KEY。'
      });
    }

    try {
      const extra = packed.duplicates.length
        ? `\n\n系统重复提醒：发现相近历史内容 ${packed.duplicates.map((d) => d.title).join('；')}。${packed.dupHint} 请避开重复角度。`
        : '';
      const reply = await callChat([
        { role: 'system', content: packed.system },
        { role: 'user', content: packed.user + extra }
      ], settings(), { timeoutMs: 90000, retries: 2 });
      record.mode = 'ai';
      record.reply = reply;
      lists.chat.items.push(record);
      persistList('chat');
      res.json({
        success: true,
        mode: 'ai',
        intent,
        reply,
        sources: packed.sources,
        duplicates: packed.duplicates,
        dupHint: packed.dupHint
      });
    } catch (e) {
      const code = e instanceof AiError ? e.code : 'ERROR';
      res.status(code === 'AI_API_NOT_CONFIGURED' ? 400 : 502).json({
        error: e.message,
        code,
        intent,
        sources: packed.sources,
        duplicates: packed.duplicates
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
      return res.json({ success: true, mode: 'brief', reply: packed.user, notice: '未配置 AI，已给出改写任务文本' });
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
    res.json({ success: true, item, items: lists.knowledge.items });
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
    if (['Scheduled', 'Published'].includes(raw.status)) {
      return res.status(400).json({ error: '新内容不能直接进入 Scheduled 或 Published，须先人工批准' });
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
