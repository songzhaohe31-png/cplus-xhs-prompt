const fs = require('fs');
const path = require('path');
const { resolveAiConfig, callChat, callChatStreamWithRetry, generateImage, AiError, keyHint, estTokens } = require('./ai');
const { hongKongDate, isDateQuestion } = require('./dates');
const { createAuth, hashPassword } = require('./auth');
const { extractText, extractDocument } = require('./extract');
const multer = require('multer');
const { findDuplicates, suggestAngle } = require('./duplicate');
const { DEFAULT_AGENT, buildContext, detectIntent, isLegacyAgent, splitWeekJobs } = require('./agent');
const { emptyDna, computeReadiness, dnaToPrompt, analyzePrompt, SERIES, DNA_FIELDS, isFact, classifyUpload, captionStats, applyMix } = require('./dna');
const { parseAgentReply } = require('./parse-output');
const { chunkText, searchChunks, lookupOfficial } = require('./retrieve');
const { startJobRunner } = require('./jobs');
const { busy, limited, clientIp } = require('./workspace');

const PUBLIC_AI_ERR = 'AI服务暂时不可用，请稍后再试。';

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
  ensureDataFile('dna.json', { items: [] });

  lists.knowledge = lists.knowledge || { items: (readData('knowledge.json') || { items: [] }).items || [] };
  lists.contents = lists.contents || { items: (readData('contents.json') || { items: [] }).items || [] };
  lists.metrics = lists.metrics || { items: (readData('metrics.json') || { items: [] }).items || [] };
  lists.chat = lists.chat || { items: (readData('chat.json') || { items: [] }).items || [] };
  lists.suggestions = lists.suggestions || { items: (readData('suggestions.json') || { items: [] }).items || [] };
  lists.dna = lists.dna || { items: (readData('dna.json') || { items: [] }).items || [] };
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
  const fileUpload = multer({
    dest: KNOW_DIR,
    limits: { fileSize: 40 * 1024 * 1024 }
  });

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

  function corpus(req) {
    const contents = req ? mine(req, lists.contents.items) : lists.contents.items;
    const posts = req ? mine(req, lists.posts.items) : lists.posts.items;
    const feed = req ? mine(req, lists.feed.items) : lists.feed.items;
    return [
      ...contents,
      ...posts.map((p) => ({ id: p.id, title: p.title, body: p.content, createdAt: p.createdAt })),
      ...feed.map((f) => ({ id: f.id, title: (f.caption || '').split('\n')[0], body: f.caption, createdAt: f.createdAt }))
    ];
  }

  function mine(req, items) {
    return (items || []).filter((i) => i && i.workspaceId === req.workspaceId);
  }

  function workspaceDna(req) {
    const row = (lists.dna.items || []).find((d) => d.workspaceId === req.workspaceId);
    return row ? row : { ...emptyDna(), workspaceId: req.workspaceId };
  }

  function saveDna(req, next) {
    const items = lists.dna.items || [];
    const idx = items.findIndex((d) => d.workspaceId === req.workspaceId);
    const row = { ...emptyDna(), ...next, workspaceId: req.workspaceId, updatedAt: new Date().toISOString() };
    if (idx >= 0) items[idx] = { ...items[idx], ...row };
    else items.push(row);
    lists.dna.items = items;
    persistList('dna');
    return row;
  }

  function maybeInvalidateDna(req) {
    const ready = computeReadiness({
      knowledge: mine(req, lists.knowledge.items),
      feed: mine(req, lists.feed.items),
      dna: workspaceDna(req)
    });
    if (ready.stale) {
      const cur = workspaceDna(req);
      saveDna(req, { ...emptyDna(), workspaceId: req.workspaceId, stale: true, fields: cur.fields, copy: cur.copy, visual: cur.visual });
    }
    return readinessOf(req);
  }

  function readinessOf(req) {
    return computeReadiness({
      knowledge: mine(req, lists.knowledge.items),
      feed: mine(req, lists.feed.items),
      dna: workspaceDna(req)
    });
  }

  global.__cplusOnWorkspaceChange = function (workspaceId) {
    try { maybeInvalidateDna({ workspaceId }); } catch (e) {}
  };

  app.get('/api/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const cfg = resolveAiConfig(settings());
    res.json({
      mode: 'public',
      serviceAvailable: !!(cfg.configured && cfg.keyLooksValid)
    });
  });

  app.get('/api/bootstrap', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const cfg = resolveAiConfig(settings());
    const ready = readinessOf(req);
    const dna = workspaceDna(req);
    res.json({
      mode: 'public',
      serviceAvailable: !!(cfg.configured && cfg.keyLooksValid),
      workspaceSummary: {
        contentCount: mine(req, lists.contents.items).length,
        knowledgeCount: mine(req, lists.knowledge.items).length
      },
      readiness: ready,
      dna: {
        confirmed: !!dna.confirmed,
        analyzedAt: dna.analyzedAt || '',
        fields: dna.fields || {}
      },
      series: SERIES
    });
  });

  app.get('/api/readiness', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(readinessOf(req));
  });

  app.get('/api/dna', (req, res) => {
    const dna = workspaceDna(req);
    res.json({ dna, fields: DNA_FIELDS, series: SERIES, readiness: readinessOf(req) });
  });

  app.post('/api/dna', (req, res) => {
    const cur = workspaceDna(req);
    const body = req.body || {};
    const next = { ...cur };
    if (body.fields && typeof body.fields === 'object') next.fields = { ...cur.fields, ...body.fields };
    if (body.copy) next.copy = { ...cur.copy, ...body.copy };
    if (body.visual) next.visual = { ...cur.visual, ...body.visual };
    if (body.strategy) next.strategy = { ...cur.strategy, ...body.strategy };
    if (body.seriesId && body.seriesPatch) {
      next.series = next.series || {};
      next.series[body.seriesId] = { ...(next.series[body.seriesId] || {}), ...body.seriesPatch };
    }
    const saved = saveDna(req, next);
    res.json({ success: true, dna: saved });
  });

  app.post('/api/dna/confirm', (req, res) => {
    const cur = workspaceDna(req);
    const ready = computeReadiness({
      knowledge: mine(req, lists.knowledge.items),
      feed: mine(req, lists.feed.items),
      dna: { ...cur, confirmed: false, stale: false }
    });
    if (!cur.analyzedAt || cur.stale) return res.status(400).json({ error: '请先完成风格分析。' });
    if (ready.facts < 1 || ready.captions < 3) {
      return res.status(400).json({ error: '正式创作至少需要1份业务资料和3篇历史文案。' });
    }
    const saved = saveDna(req, { ...cur, confirmed: true, stale: false, confirmedAt: new Date().toISOString() });
    res.json({ success: true, dna: saved, readiness: readinessOf(req) });
  });

  app.post('/api/dna/analyze', async (req, res) => {
    const cfg = resolveAiConfig(settings());
    if (!cfg.configured || !cfg.keyLooksValid) return res.status(503).json({ error: PUBLIC_AI_ERR });
    const facts = mine(req, lists.knowledge.items).filter(isFact);
    const samples = mine(req, lists.knowledge.items).filter((k) => k.zone === 'sample');
    const feed = mine(req, lists.feed.items);
    const stats = captionStats(feed.map((f) => f.caption).concat(samples.map((s) => s.caption || s.excerpt)));
    const posterCount = feed.filter((f) => f.images && f.images.length).length;
    if (!facts.length && !stats.n) {
      return res.status(400).json({ error: '请先上传公司资料或历史文案。' });
    }
    try {
      const reply = await callChat([
        { role: 'system', content: '你是CPLUS内容风格分析师。只输出JSON。数字必须使用用户给出的程序统计，禁止改写平均字数。没有海报时禁止编造视觉规格。' },
        { role: 'user', content: analyzePrompt(facts, samples, feed, stats, posterCount) }
      ], settings(), { timeoutMs: 90000, firstTokenMs: 20000, maxTokens: 1800 });
      const { extractJson } = require('./parse-output');
      const json = extractJson(reply) || {};
      const cur = workspaceDna(req);
      const visual = posterCount < 3
        ? { insufficient: true, note: '尚未上传海报，无法分析视觉风格。', n: posterCount }
        : (json.visual || {});
      const fields = { ...emptyDna().fields, ...(json.fields || {}) };
      if (posterCount < 3) {
        fields.posterColors = '尚未上传海报，无法分析视觉风格。';
        fields.posterLayout = '尚未上传海报，无法分析视觉风格。';
        fields.imageElements = '尚未上传海报，无法分析视觉风格。';
      }
      const next = {
        ...cur,
        analyzedAt: new Date().toISOString(),
        confirmed: false,
        stale: false,
        fields,
        copy: {
          ...(json.copy || {}),
          script: stats.script,
          avgChars: String(stats.avgChars),
          titleLen: String(stats.avgTitle),
          avgParas: String(stats.avgParas),
          avgEmoji: String(stats.avgEmoji),
          avgTags: String(stats.avgTags),
          hashtags: (stats.topTags || []).map((t) => t.tag + '×' + t.n).join(' '),
          n: stats.n
        },
        visual,
        strategy: json.strategy || {},
        evidence: { captions: stats.n, posters: posterCount, facts: facts.length }
      };
      const saved = saveDna(req, next);
      res.json({ success: true, dna: saved, stats, readiness: readinessOf(req) });
    } catch (e) {
      console.error('[dna/analyze]', e && e.message);
      res.status(503).json({ error: (e && e.publicMessage) || '风格分析失败，请稍后重试。' });
    }
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
    res.status(404).json({ error: 'Not found' });
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

  function packChat(req, message) {
    const ws = req.workspaceId || 'public';
    const intent = detectIntent(message);
    const hits = searchChunks(
      (lists.chunks.items || []).filter((c) => (c.workspaceId === ws || c.workspaceId === 'global' || !c.workspaceId) && c.kind !== 'internal'),
      message,
      6
    ).slice(0, 4);
    const knowledgeHits = hits.map((h) => ({
      id: h.chunk.knowledgeId,
      name: h.chunk.name,
      category: h.chunk.category || '',
      excerpt: String(h.chunk.text || '').slice(0, 500),
      expired: h.expired
    }));
    const packed = buildContext({
      agent: agentRules(),
      rules: readData('rules.json'),
      knowledge: knowledgeHits.length ? knowledgeHits : mine(req, lists.knowledge.items).filter(isFact).slice(0, 4),
      feed: mine(req, lists.feed.items).slice(-4),
      contents: mine(req, lists.contents.items).slice(-20),
      materials: mine(req, lists.materials.items).slice(-2),
      message
    });
    const dna = workspaceDna(req);
    const dnaLine = dnaToPrompt(dna);
    if (dnaLine) packed.system += '\n' + dnaLine;
    packed.readiness = readinessOf(req);
    packed.generalMode = false;
    if (packed.tokenStats) {
      console.log('[ai] pack', JSON.stringify(packed.tokenStats), 'intent=' + packed.intent);
    }
    return packed;
  }

  function gateFormal(req, intent, generalMode) {
    const ready = readinessOf(req);
    const formal = ['month', 'week', 'single', 'explode', 'poster'].includes(intent);
    if (!formal || ready.canGenerate || generalMode) return null;
    if (ready.facts < 1) {
      return '现有资料不足，无法生成正式内容。请先上传相关服务资料或官方来源。';
    }
    if (ready.captions < 3) {
      return '风格样本不足。请至少上传3篇历史文案，再分析并确认后生成正式内容。';
    }
    if (!ready.analyzed || !ready.confirmed || ready.stale) {
      return '请先完成风格分析并确认。没有海报时仍可生成主题和文案，但不会使用历史海报风格。';
    }
    return '请先完成资料学习并确认风格，再生成正式内容。';
  }

  function sseWrite(res, event, data) {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
  }

  app.post('/api/agent/chat', async (req, res) => {
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: '请输入内容' });
    if (message.length > 4000) return res.status(400).json({ error: '内容过长，请缩短后再试。' });
    const ws = req.workspaceId || 'public';
    if (busy.has('chat:' + ws)) return res.status(429).json({ error: '正在生成中，请稍候。' });
    if (limited('chat:' + ws, 20, 10 * 60 * 1000) || limited('chatip:' + clientIp(req), 30, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '请求频率过高，请稍后再试。' });
    }
    const packed = packChat(req, message);
    const cfg = resolveAiConfig(settings());
    if (!cfg.configured || !cfg.keyLooksValid) {
      return res.status(503).json({ error: PUBLIC_AI_ERR });
    }
    const blocked = gateFormal(req, packed.intent, !!(req.body && req.body.generalMode));
    if (blocked) return res.status(403).json({ error: blocked, code: 'NOT_READY' });
    busy.add('chat:' + ws);
    try {
      const reply = await callChat([
        { role: 'system', content: packed.system },
        { role: 'user', content: packed.user }
      ], settings(), { timeoutMs: cfg.timeoutMs, maxTokens: packed.intent === 'month' ? 1200 : cfg.maxTokens });
      const parsed = parseAgentReply(reply, packed.intent, packed.slots);
      addLog({ kind: 'chat', user: 'public', status: 'ok', intent: packed.intent, message, model: '' });
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        intent: packed.intent,
        reply: parsed.visible,
        structured: parsed,
        sources: (packed.sources || []).map((s) => ({ name: s.name, type: s.type })),
        duplicates: packed.duplicates,
        dupHint: packed.dupHint
      });
    } catch (e) {
      addLog({ kind: 'chat', user: 'public', status: 'error', intent: packed.intent, message, model: '' });
      console.error('[chat]', e && e.code, e && e.message);
      res.status(503).json({ error: (e && e.publicMessage) || PUBLIC_AI_ERR });
    } finally {
      busy.delete('chat:' + ws);
    }
  });

  app.post('/api/agent/chat/stream', async (req, res) => {
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: '请输入内容' });
    if (message.length > 4000) return res.status(400).json({ error: '内容过长，请缩短后再试。' });
    const ws = req.workspaceId || 'public';
    if (busy.has('chat:' + ws)) return res.status(429).json({ error: '正在生成中，请稍候。' });
    if (limited('chat:' + ws, 20, 10 * 60 * 1000) || limited('chatip:' + clientIp(req), 30, 10 * 60 * 1000)) {
      return res.status(429).json({ error: '请求频率过高，请稍后再试。' });
    }
    const cfg = resolveAiConfig(settings());
    if (!cfg.configured || !cfg.keyLooksValid) {
      return res.status(503).json({ error: PUBLIC_AI_ERR });
    }
    const packed = packChat(req, message);
    const blocked = gateFormal(req, packed.intent, !!(req.body && req.body.generalMode));
    if (blocked) return res.status(403).json({ error: blocked, code: 'NOT_READY' });
    const ac = new AbortController();
    const abortUp = () => { try { if (!res.writableEnded) ac.abort(); } catch (e) {} };
    req.on('aborted', abortUp);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
    try { res.write(':' + (' '.repeat(2048)) + '\n\n'); } catch (e) {}
    sseWrite(res, 'status', { text: '正在生成内容…' });
    if (typeof res.flush === 'function') res.flush();
    busy.add('chat:' + ws);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) {}
    }, 15000);
    try {
      if (isDateQuestion(message)) {
        const today = packed.currentDate || hongKongDate();
        sseWrite(res, 'delta', { text: today });
        sseWrite(res, 'done', { success: true, intent: 'general', reply: today });
        addLog({ kind: 'chat', user: 'public', status: 'ok', intent: 'date', message, model: 'local-date' });
        return;
      }
      const jsonIntent = packed.intent === 'month' || packed.intent === 'week' || packed.intent === 'single' || packed.intent === 'explode' || packed.intent === 'compliance';
      const result = await callChatStreamWithRetry([
        { role: 'system', content: packed.system },
        { role: 'user', content: packed.user }
      ], settings(), {
        timeoutMs: cfg.timeoutMs,
        firstTokenMs: 20000,
        maxTokens: packed.intent === 'month' ? 2500 : (packed.intent === 'single' ? 1800 : cfg.maxTokens),
        signal: ac.signal,
        onDelta: (delta) => {
          if (jsonIntent) return;
          if (/[{}`|]/.test(delta) && /[{[]|"type"\s*:|```|<<<JSON/.test(delta)) return;
          sseWrite(res, 'delta', { text: delta });
        }
      });
      let parsed = parseAgentReply(result.text, packed.intent, packed.slots);
      if (parsed.type === 'schedule' && parsed.items && parsed.items.length) {
        parsed.items = applyMix(parsed.items);
      }
      const srcLine = (packed.sources || []).map((s) => s.name).filter(Boolean).join('；');
      if (parsed.items) {
        parsed.items = parsed.items.map((it) => ({
          ...it,
          sourcesText: it.sourcesText || srcLine || '现有资料不足，事实请人工核对。'
        }));
      }
      if (parsed.parseFailed || (jsonIntent && !(parsed.items && parsed.items.length))) {
        console.error('[chat/stream] parse failed intent=' + packed.intent + ' rawLength=' + parsed.rawLength);
        sseWrite(res, 'error', { error: '结果整理失败，请重新生成' });
        addLog({ kind: 'chat', user: 'public', status: 'parse_failed', intent: packed.intent, message, model: result.model || '' });
        return;
      }
      if (parsed.items && parsed.items.length) {
        sseWrite(res, 'structured', { type: parsed.type, items: parsed.items });
      } else if (parsed.visible) {
        sseWrite(res, 'delta', { text: parsed.visible });
      }
      addLog({ kind: 'chat', user: 'public', status: 'ok', intent: packed.intent, message, model: result.model || '' });
      sseWrite(res, 'done', { success: true });
    } catch (e) {
      addLog({ kind: 'chat', user: 'public', status: 'error', intent: packed.intent, message, model: '' });
      console.error('[chat/stream]', e && e.code, e && e.timeoutType, e && e.message);
      const msg = (e && e.code === 'TIMEOUT') ? 'AI响应较慢，请重新尝试。' : ((e && e.publicMessage) || PUBLIC_AI_ERR);
      sseWrite(res, 'error', { error: msg });
    } finally {
      clearInterval(ping);
      busy.delete('chat:' + ws);
      res.end();
    }
  });

  app.post('/api/agent/batch', (req, res) => {
    const message = String((req.body && req.body.message) || '').trim();
    if (!message) return res.status(400).json({ error: '请输入内容' });
    const cfg = resolveAiConfig(settings());
    if (!cfg.configured || !cfg.keyLooksValid) return res.status(503).json({ error: PUBLIC_AI_ERR });
    const blocked = gateFormal(req, 'week', !!(req.body && req.body.generalMode));
    if (blocked) return res.status(403).json({ error: blocked, code: 'NOT_READY' });
    const groupId = newId();
    const parts = splitWeekJobs(message);
    const jobs = parts.map((p, i) => {
      const job = {
        id: newId(),
        groupId,
        workspaceId: req.workspaceId,
        type: 'single_generate',
        title: p.title,
        payload: { message: p.message, index: i },
        runAt: new Date().toISOString(),
        status: 'queued',
        error: '',
        result: null,
        createdAt: new Date().toISOString()
      };
      lists.jobs.items.push(job);
      return { id: job.id, title: job.title, status: job.status };
    });
    persistList('jobs');
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, groupId, jobs, notice: '已拆成3篇后台任务，完成一篇即显示一篇。' });
  });

  app.get('/api/agent/jobs', (req, res) => {
    const groupId = String((req.query && req.query.groupId) || '');
    const items = (lists.jobs.items || []).filter((j) => j.workspaceId === req.workspaceId && (!groupId || j.groupId === groupId));
    res.set('Cache-Control', 'no-store');
    res.json({
      items: items.map((j) => ({
        id: j.id,
        groupId: j.groupId,
        title: j.title,
        status: j.status,
        error: j.error || '',
        preview: j.result && j.result.preview,
        reply: j.result && j.result.reply,
        structured: j.result && j.result.structured
      }))
    });
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
    if (!cfg.configured || !cfg.keyLooksValid) {
      return res.status(503).json({ error: keyHint(cfg) || PUBLIC_AI_ERR });
    }
    try {
      const reply = await callChat([
        { role: 'system', content: packed.system + '\n只输出改写后的该字段，不要其他解释。' },
        { role: 'user', content: packed.user }
      ], settings(), { maxTokens: 2500, retries: 1 });
      res.json({ success: true, mode: 'ai', reply, sources: packed.sources });
    } catch (e) {
      res.status(503).json({ error: (e && e.publicMessage) || PUBLIC_AI_ERR });
    }
  });

  app.get('/api/knowledge', (req, res) => {
    res.json({
      items: mine(req, lists.knowledge.items).map((k) => ({
        id: k.id,
        name: k.name,
        zone: k.zone || 'facts',
        kind: k.kind || '',
        label: k.label || '',
        factCount: k.factCount || 0,
        needsConfirm: !!k.needsConfirm,
        category: k.category,
        business: k.business,
        jurisdiction: k.jurisdiction,
        uploadedAt: k.uploadedAt,
        contentDate: k.contentDate || '',
        timely: !!k.timely,
        analyzed: k.status === 'ok' && (k.charCount || 0) > 0,
        facts: (k.excerpt || '').slice(0, 280),
        titles: k.titles || [],
        charCount: k.charCount || 0,
        pageCount: k.pageCount || 0,
        parseError: k.parseError || '',
        ocrNote: k.ocrNote || '',
        source: k.url || k.filename || '',
        status: k.status || (k.excerpt ? 'ok' : 'failed')
      }))
    });
  });

  function publicKnowledge(k) {
    return {
      id: k.id,
      name: k.name,
      zone: k.zone,
      kind: k.kind,
      label: k.label,
      status: k.status,
      charCount: k.charCount || 0,
      pageCount: k.pageCount || 0,
      factCount: k.factCount || 0,
      titles: k.titles || [],
      parseError: k.parseError || '',
      ocrNote: k.ocrNote || '',
      needsConfirm: !!k.needsConfirm,
      facts: (k.excerpt || '').slice(0, 280)
    };
  }

  async function finishParse(item, abs) {
    item.status = /^image\//.test(item.mime || '') ? 'ocr' : 'parsing';
    persistList('knowledge');
    const doc = await extractDocument(abs, item.mime, item.name);
    if (!doc.ok || !doc.charCount) {
      item.status = 'failed';
      item.parseError = doc.error || '提取字符为0，识别失败。';
      item.charCount = doc.charCount || 0;
      item.pageCount = doc.pageCount || 0;
      item.excerpt = '';
      persistList('knowledge');
      maybeInvalidateDna({ workspaceId: item.workspaceId });
      return item;
    }
    item.excerpt = String(doc.text || '').slice(0, 100000);
    item.charCount = doc.charCount;
    item.pageCount = doc.pageCount;
    item.pages = (doc.pages || []).map((p) => ({
      page: p.page,
      sheet: p.sheet || '',
      charCount: p.charCount || (p.text || '').length,
      preview: String(p.text || '').slice(0, 500)
    }));
    item.titles = doc.titles || [];
    item.extractedFacts = doc.facts || [];
    item.factCount = (doc.facts || []).length;
    item.ocrUsed = !!doc.ocrUsed;
    item.ocrNote = doc.ocrNote || '';
    item.visual = doc.visual || null;
    item.parseError = '';
    const guessed = classifyUpload({
      name: item.name,
      mime: item.mime,
      text: item.excerpt,
      hasImage: /^image\//.test(item.mime || '') || (doc.visual && doc.visual.type === 'poster')
    });
    item.zone = guessed.zone === 'sample' ? 'sample' : (guessed.kind === 'internal' ? 'brief' : 'facts');
    item.kind = guessed.kind;
    item.label = guessed.label;
    item.needsConfirm = !!guessed.needsConfirm;
    if (doc.visual && doc.visual.type === 'poster') {
      item.zone = 'sample';
      item.kind = 'poster';
      item.label = '历史海报';
    }
    if (doc.visual && doc.visual.type === 'license') {
      item.zone = 'facts';
      item.kind = 'official';
      item.label = '牌照或证件图片';
    }
    item.status = 'ok';
    const pageChunks = [];
    (doc.pages || [{ page: 1, text: item.excerpt }]).forEach((p) => {
      pageChunks.push(...chunkText(p.text || '', item.name, {
        id: item.id,
        category: item.category,
        business: item.business,
        jurisdiction: item.jurisdiction,
        expiresAt: item.expiresAt,
        workspaceId: item.workspaceId,
        page: p.page,
        sheet: p.sheet || '',
        kind: item.kind
      }));
    });
    lists.chunks.items = lists.chunks.items.filter((c) => c.knowledgeId !== item.id).concat(pageChunks);
    persistList('chunks');
    persistList('knowledge');
    return item;
  }

  app.post('/api/knowledge/upload', fileUpload.single('file'), async (req, res) => {
    const file = req.file;
    const paste = String((req.body && (req.body.text || req.body.caption)) || '').trim();
    if (!file && !paste) return res.status(400).json({ error: '请选择文件或粘贴文字' });
    const id = newId();
    const rawName = (file && (file.originalname || file.filename)) || '粘贴文案.txt';
    let orig = rawName;
    try { orig = Buffer.from(rawName, 'latin1').toString('utf8') || rawName; } catch (e) { orig = rawName; }
    const ext = path.extname(orig).toLowerCase() || '.txt';
    const filename = id + ext;
    const abs = path.join(KNOW_DIR, filename);
    if (file && file.path) {
      try { fs.renameSync(file.path, abs); } catch (e) { fs.copyFileSync(file.path, abs); }
    } else {
      fs.writeFileSync(abs, paste, 'utf8');
    }
    const item = {
      id,
      name: orig,
      zone: 'facts',
      kind: '',
      label: '',
      status: 'parsing',
      uploadedAt: new Date().toISOString(),
      filename,
      mime: (file && file.mimetype) || 'text/plain',
      excerpt: paste && !file ? paste : '',
      charCount: 0,
      pageCount: 0,
      workspaceId: req.workspaceId
    };
    lists.knowledge.items.push(item);
    persistList('knowledge');
    res.json({ success: true, item: publicKnowledge(item) });
    finishParse(item, abs).catch((e) => {
      item.status = 'failed';
      item.parseError = e.message || '解析失败';
      persistList('knowledge');
      console.error('[parse]', e);
    });
  });

  app.get('/api/knowledge/:id/preview', (req, res) => {
    const item = lists.knowledge.items.find((x) => x.id === req.params.id && x.workspaceId === req.workspaceId);
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({
      id: item.id,
      name: item.name,
      status: item.status,
      label: item.label,
      kind: item.kind,
      charCount: item.charCount || 0,
      pageCount: item.pageCount || 0,
      titles: item.titles || [],
      facts: item.extractedFacts || [],
      pages: item.pages || [],
      preview: (item.excerpt || '').slice(0, 2500),
      parseError: item.parseError || '',
      ocrNote: item.ocrNote || '',
      visual: item.visual || null
    });
  });

  app.post('/api/knowledge', async (req, res) => {
    const raw = req.body || {};
    const id = newId();
    const item = {
      id,
      name: raw.name || raw.filename || '未命名资料',
      zone: raw.zone === 'sample' ? 'sample' : 'facts',
      kind: raw.kind || '',
      label: raw.label || '',
      category: raw.category || '其他',
      business: raw.business || '',
      jurisdiction: raw.jurisdiction || '香港',
      uploadedAt: new Date().toISOString(),
      contentDate: raw.contentDate || '',
      timely: !!raw.timely,
      caption: raw.caption || '',
      rating: raw.rating || '',
      note: raw.note || '',
      expiresAt: raw.expiresAt || '',
      needsUpdate: !!raw.needsUpdate,
      sourceType: raw.sourceType || 'upload',
      filename: '',
      mime: raw.mime || '',
      excerpt: raw.excerpt || raw.text || '',
      workspaceId: req.workspaceId
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
    const guessed = classifyUpload({
      name: item.name,
      mime: item.mime,
      text: item.excerpt || item.caption || raw.text || '',
      hasImage: /\.(png|jpe?g|webp|gif)$/i.test(item.filename || item.name || '') || /^image\//.test(item.mime || '')
    });
    if (!raw.zone) item.zone = guessed.zone;
    item.kind = item.kind || guessed.kind;
    item.label = item.label || guessed.label;
    item.needsConfirm = guessed.kind === 'unknown';
    item.factCount = item.excerpt ? item.excerpt.split(/[。！？\n]/).filter((s) => s.trim().length > 8).length : 0;
    lists.knowledge.items.push(item);
    persistList('knowledge');
    const chunks = chunkText(item.excerpt || '', item.name, {
      id: item.id,
      category: item.category,
      business: item.business,
      jurisdiction: item.jurisdiction,
      expiresAt: item.expiresAt,
      workspaceId: req.workspaceId
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
    res.json({
      success: true,
      item: {
        id: item.id,
        name: item.name,
        zone: item.zone,
        kind: item.kind,
        label: item.label,
        factCount: item.factCount,
        status: item.excerpt ? '已提取' : '处理失败'
      },
      items: mine(req, lists.knowledge.items),
      readiness: readinessOf(req)
    });
  });

  app.post('/api/knowledge/:id/reindex', async (req, res) => {
    const item = lists.knowledge.items.find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const chunks = chunkText(item.excerpt || '', item.name, {
      id: item.id,
      category: item.category,
      business: item.business,
      jurisdiction: item.jurisdiction,
      expiresAt: item.expiresAt,
      workspaceId: req.workspaceId
    });
    lists.chunks.items = lists.chunks.items.filter((c) => c.knowledgeId !== item.id).concat(chunks);
    persistList('chunks');
    res.json({ success: true, chunkCount: chunks.length });
  });

  app.put('/api/knowledge/:id', (req, res) => {
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
    const item = lists.knowledge.items.find((x) => x.id === req.params.id && x.workspaceId === req.workspaceId);
    if (!item) return res.status(404).json({ error: 'Not found' });
    lists.knowledge.items = lists.knowledge.items.filter((x) => x.id !== req.params.id);
    persistList('knowledge');
    lists.chunks.items = lists.chunks.items.filter((c) => c.knowledgeId !== req.params.id);
    persistList('chunks');
    if (item && item.filename) {
      const abs = path.join(KNOW_DIR, item.filename);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
    const ready = maybeInvalidateDna(req);
    res.json({ success: true, items: mine(req, lists.knowledge.items), readiness: ready });
  });

  app.get('/api/knowledge/file/:id', (req, res) => {
    const item = lists.knowledge.items.find((x) => x.id === req.params.id);
    if (!item || !item.filename) return res.status(404).end();
    const abs = path.join(KNOW_DIR, item.filename);
    if (!fs.existsSync(abs)) return res.status(404).end();
    res.sendFile(abs);
  });

  app.post('/api/contents/batch', (req, res) => {
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
        owner: 'CPLUS User',
        workspaceId: req.workspaceId,
        status: 'Draft',
        reviewNotes: '',
        posterUrl: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metrics: {}
      };
      const dups = findDuplicates(item, corpus(req));
      if (dups.length) warnings.push({ id: item.id, title: item.title, duplicates: dups, dupHint: suggestAngle(dups) });
      lists.contents.items.push(item);
      created.push(item);
    });
    persistList('contents');
    res.json({ success: true, items: created, warnings, all: mine(req, lists.contents.items) });
  });

  app.get('/api/contents', (req, res) => {
    res.json({ items: mine(req, lists.contents.items) });
  });

  app.post('/api/contents', (req, res) => {
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
      owner: 'CPLUS User',
      workspaceId: req.workspaceId,
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
    const idx = lists.contents.items.findIndex((x) => x.id === req.params.id && x.workspaceId === req.workspaceId);
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

    }
    const next = { ...cur, ...req.body, id: cur.id, updatedAt: new Date().toISOString() };
    if (next.status === 'Draft' && cur.status === 'Published') next.status = cur.status;
    lists.contents.items[idx] = next;
    persistList('contents');
    const dups = findDuplicates(next, corpus(req));
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
    lists.contents.items = lists.contents.items.filter((x) => !(x.id === req.params.id && x.workspaceId === req.workspaceId));
    persistList('contents');
    res.json({ success: true, items: mine(req, lists.contents.items) });
  });

  app.post('/api/duplicate-check', (req, res) => {
    const hits = findDuplicates(req.body || {}, corpus(req));
    res.json({ duplicates: hits, dupHint: suggestAngle(hits) });
  });

  app.get('/api/metrics', (req, res) => {
    res.json({ items: mine(req, lists.metrics.items) });
  });

  app.post('/api/metrics', (req, res) => {

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
      createdAt: new Date().toISOString(),
      workspaceId: req.workspaceId
    };
    lists.metrics.items.push(item);
    persistList('metrics');
    if (item.contentId) {
      const c = lists.contents.items.find((x) => x.id === item.contentId && x.workspaceId === req.workspaceId);
      if (c) c.metrics = item;
      persistList('contents');
    }
    res.json({ success: true, item, items: mine(req, lists.metrics.items) });
  });

  app.post('/api/review/suggest', async (req, res) => {

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
    const title = (req.body && req.body.title) || '';
    const subtitle = (req.body && req.body.subtitle) || '';
    const points = (req.body && req.body.points) || [];
    const cfg = resolveAiConfig(settings());
    if (!cfg.imageConfigured) {
      return res.status(503).json({ error: PUBLIC_AI_ERR });
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
      res.status(503).json({ error: PUBLIC_AI_ERR });
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
    concurrency: 2,
    runJob: async (job) => {
      const cfg = resolveAiConfig(settings());
      if (!cfg.configured) throw new Error('AI 未配置');
      const message = (job.payload && job.payload.message) || '写一篇香港合规小红书。只生成一篇。';
      const fakeReq = { workspaceId: job.workspaceId };
      const packed = packChat(fakeReq, message);
      const reply = await callChat([
        { role: 'system', content: packed.system },
        { role: 'user', content: packed.user }
      ], settings(), { timeoutMs: cfg.timeoutMs, maxTokens: 1600 });
      const parsed = parseAgentReply(reply, 'single', packed.slots);
      return {
        preview: (parsed.visible || '').slice(0, 280),
        reply: parsed.visible,
        structured: parsed,
        count: (parsed.items || []).length
      };
    }
  });

  app.get('/api/workspace/export', (req, res) => {
    res.json({
      workspace: true,
      exportedAt: new Date().toISOString(),
      contents: mine(req, lists.contents.items),
      knowledge: mine(req, lists.knowledge.items).map((k) => ({ ...k, filename: undefined })),
      metrics: mine(req, lists.metrics.items),
      feed: mine(req, lists.feed.items)
    });
  });

  app.post('/api/workspace/import', (req, res) => {
    const body = req.body || {};
    const add = (name, rows) => {
      (rows || []).forEach((row) => {
        if (!row) return;
        lists[name].items.push({ ...row, id: newId(), workspaceId: req.workspaceId, createdAt: new Date().toISOString() });
      });
      persistList(name);
    };
    if (body.contents) add('contents', body.contents);
    if (body.knowledge) add('knowledge', body.knowledge);
    if (body.metrics) add('metrics', body.metrics);
    if (body.feed) add('feed', body.feed);
    res.json({ success: true });
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
