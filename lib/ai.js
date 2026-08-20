const http = require('http');
const https = require('https');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const XAI_DEFAULT_BASE = 'https://api.x.ai/v1';

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 4,
  keepAliveMsecs: 15000
});

let runtimeModel = '';
let availableModels = [];

class AiError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.status = extra && extra.status;
    this.publicMessage = (extra && extra.publicMessage) || message;
    this.timeoutType = extra && extra.timeoutType;
  }
}

function estTokens(s) {
  return Math.ceil(String(s || '').length / 2);
}

function maskSecret(s) {
  const t = String(s || '');
  if (t.length < 8) return t ? '****' : '';
  return t.slice(0, 4) + '****' + t.slice(-4);
}

function cleanSecret(raw) {
  return String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .trim();
}

function classifyKey(key) {
  const t = cleanSecret(key);
  if (!t) return 'empty';
  if (t.startsWith('xai-') && t.length >= 32) return 'xai';
  if (t.startsWith('xai-')) return 'truncated';
  if (t.startsWith('sk-') && t.length > 12) return 'openai';
  if (UUID_RE.test(t)) return 'uuid';
  return 'other';
}

function sanitizeBase(raw, fallback) {
  const t = String(raw || '').trim().replace(/\/$/, '');
  if (!t) return fallback;
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fallback;
    if (!u.hostname || !u.hostname.includes('.')) return fallback;
    return t;
  } catch (e) {
    return fallback;
  }
}

function pickApiKey() {
  const a = cleanSecret(process.env.XAI_API_KEY || '');
  const b = cleanSecret(process.env.AI_API_KEY || '');
  const ranked = [a, b].filter(Boolean);
  return ranked.find((k) => classifyKey(k) === 'xai')
    || ranked.find((k) => classifyKey(k) === 'openai')
    || ranked[0]
    || '';
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveAiConfig(settings) {
  const apiKey = pickApiKey();
  let provider = (process.env.AI_PROVIDER || '').toLowerCase();
  if (!provider) provider = 'xai';
  const xai = provider === 'xai' || provider === 'grok' || provider === 'spacexai';
  const gemini = provider === 'gemini';
  const fallbackBase = gemini
    ? 'https://generativelanguage.googleapis.com/v1beta'
    : xai
      ? XAI_DEFAULT_BASE
      : 'https://api.openai.com/v1';
  const rawBase = process.env.XAI_BASE_URL || process.env.AI_API_BASE || '';
  const apiBaseUrl = sanitizeBase(rawBase, fallbackBase);
  const requested = process.env.XAI_MODEL || process.env.AI_MODEL || '';
  const model = runtimeModel || requested || (gemini ? 'gemini-2.0-flash' : xai ? 'grok-4.6' : 'gpt-4o-mini');
  const imageKey = process.env.IMAGE_API_KEY || apiKey;
  const imageModel = process.env.IMAGE_MODEL || (xai ? 'grok-imagine-image' : 'dall-e-3');
  const keyKind = classifyKey(apiKey);
  const keyLooksValid = xai ? keyKind === 'xai' : (gemini ? keyKind !== 'empty' && keyKind !== 'uuid' : keyKind === 'openai' || keyKind === 'xai');
  let baseHost = '';
  try { baseHost = new URL(apiBaseUrl).hostname; } catch (e) { baseHost = ''; }
  return {
    provider: xai ? 'xai' : provider,
    apiKey,
    imageKey,
    apiBaseUrl,
    model,
    requestedModel: requested,
    imageModel,
    configured: !!apiKey,
    imageConfigured: !!imageKey,
    source: process.env.XAI_API_KEY ? 'XAI_API_KEY' : (process.env.AI_API_KEY ? 'AI_API_KEY' : 'none'),
    keyKind,
    keyLooksValid,
    keyLen: apiKey.length,
    baseHost,
    baseInvalid: !!(rawBase && sanitizeBase(rawBase, '') === ''),
    timeoutMs: envNum('XAI_TIMEOUT_MS', 180000),
    firstTokenMs: envNum('XAI_FIRST_TOKEN_MS', 20000),
    maxTokens: envNum('XAI_MAX_OUTPUT_TOKENS', 1800)
  };
}

function keyHint(cfg) {
  if (!cfg || !cfg.configured) return 'AI服务暂时不可用，请稍后再试。';
  if (!cfg.keyLooksValid) return 'AI服务暂时不可用，请稍后再试。';
  return '';
}

function publicFromUpstream(status, data) {
  const raw = String(data || '');
  if (/credit|license|billing|quota|余额|no credits/i.test(raw)) {
    return 'x.ai额度不足，请到 console.x.ai 充值。';
  }
  if (status === 401 || status === 403) return 'x.ai授权失败。';
  if (status === 402) return 'x.ai额度不足，请到 console.x.ai 充值。';
  if (status === 429) return '请求频率过高，请稍后再试。';
  if (status === 400 && /model/i.test(raw)) return '模型不可用，请稍后重试。';
  if (status === 400) return 'AI请求被拒绝，请稍后重试。';
  if (status >= 500) return '服务器内部错误，请稍后重试。';
  return '';
}

function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.includes('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function modelsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (base.endsWith('/models')) return base;
  if (base.includes('/v1')) return `${base}/models`;
  return `${base}/v1/models`;
}

function pickFromList(ids, preferred) {
  const list = (ids || []).map(String);
  if (preferred && list.includes(preferred)) return preferred;
  const skip = /imagine|tts|whisper|embed|vision|image|video|voice|audio/i;
  const chat = list.filter((id) => !skip.test(id));
  const fast = chat.find((id) => /fast|mini|flash|lite/i.test(id) && !/reason/i.test(id));
  if (fast) return fast;
  const preferredFallbacks = ['grok-3-mini', 'grok-3-fast', 'grok-2-mini', 'grok-4-fast', 'grok-4.6'];
  for (let i = 0; i < preferredFallbacks.length; i++) {
    if (chat.includes(preferredFallbacks[i])) return preferredFallbacks[i];
  }
  return chat[0] || preferred || 'grok-4.6';
}

function requestOpts(parsed, method, headers, payload) {
  return {
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method,
    agent: parsed.protocol === 'https:' ? keepAliveAgent : undefined,
    headers: {
      ...headers,
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
    }
  };
}

function requestJson(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new AiError('NETWORK', 'AI 接口地址无效', { publicMessage: '网络连接失败。' }));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const payload = body ? Buffer.from(body) : null;
    const req = (isHttps ? https : http).request(requestOpts(parsed, method, headers, payload), (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve({ status: res.statusCode, data: data.toString('utf8'), buf: data });
      });
    });
    req.setTimeout(timeoutMs || 30000, () => {
      req.destroy(new AiError('TIMEOUT', 'AI 请求超时，请重试', { publicMessage: 'AI请求超时，请重试。' }));
    });
    req.on('error', (e) => {
      if (e.code === 'TIMEOUT' || (e instanceof AiError && e.code === 'TIMEOUT')) {
        reject(e);
        return;
      }
      reject(new AiError('NETWORK', e.message, { publicMessage: '网络连接失败。' }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function parseSseDelta(line) {
  const t = String(line || '').trim();
  if (!t.startsWith('data:')) return null;
  const data = t.slice(5).trim();
  if (!data || data === '[DONE]') return { done: data === '[DONE]', text: '' };
  try {
    const json = JSON.parse(data);
    const text = json.choices && json.choices[0] && json.choices[0].delta
      ? (json.choices[0].delta.content || '')
      : '';
    return { done: false, text };
  } catch (e) {
    return null;
  }
}

async function listModels(cfg) {
  const url = modelsUrl(cfg.apiBaseUrl);
  const res = await requestJson('GET', url, { Authorization: 'Bearer ' + cfg.apiKey }, null, 15000);
  if (res.status !== 200) {
    throw new AiError('UPSTREAM', `models ${res.status}`, {
      status: res.status,
      publicMessage: publicFromUpstream(res.status, res.data) || '模型列表不可用。'
    });
  }
  const json = JSON.parse(res.data);
  const ids = (json.data || json.models || []).map((m) => m.id || m.name).filter(Boolean);
  return ids;
}

async function refreshRuntimeModel() {
  const cfg = resolveAiConfig({});
  if (!cfg.configured || !cfg.keyLooksValid) return cfg.model;
  try {
    const ids = await listModels(cfg);
    availableModels = ids;
    runtimeModel = pickFromList(ids, cfg.requestedModel);
    console.log('[ai] models', ids.join(', '));
    console.log('[ai] using model=' + runtimeModel + (cfg.requestedModel && cfg.requestedModel !== runtimeModel ? ' (requested ' + cfg.requestedModel + ' not used as-is)' : ''));
    return runtimeModel;
  } catch (e) {
    runtimeModel = cfg.requestedModel || cfg.model;
    console.warn('[ai] models probe failed', e.status || e.message, 'fallback=' + runtimeModel);
    return runtimeModel;
  }
}

function getRuntimeModel() {
  return runtimeModel || resolveAiConfig({}).model;
}

function assertKeyUsable(cfg) {
  if (!cfg.configured || !cfg.keyLooksValid) {
    throw new AiError('AI_API_NOT_CONFIGURED', '未配置 AI', {
      publicMessage: 'AI服务暂时不可用，请稍后再试。'
    });
  }
}

async function callChatStream(messages, settings, options) {
  const cfg = resolveAiConfig(settings || {});
  assertKeyUsable(cfg);
  const opts = options || {};
  const model = opts.model || cfg.model;
  const url = chatCompletionsUrl(cfg.apiBaseUrl);
  const maxTokens = opts.maxTokens || cfg.maxTokens;
  const firstTokenMs = opts.firstTokenMs || cfg.firstTokenMs;
  const totalMs = opts.timeoutMs || cfg.timeoutMs;
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature != null ? opts.temperature : 0.5,
    max_tokens: maxTokens,
    stream: true
  });
  const sys = (messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const user = (messages || []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const started = Date.now();
  console.log('[ai] stream start model=' + model + ' system_prompt_tokens=' + estTokens(sys) + ' user_prompt_tokens=' + estTokens(user));

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) {
      reject(new AiError('NETWORK', 'bad url', { publicMessage: '网络连接失败。' }));
      return;
    }
    const payload = Buffer.from(body);
    const req = https.request(requestOpts(parsed, 'POST', { Authorization: 'Bearer ' + cfg.apiKey }, payload), (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const hint = raw.replace(/xai-[A-Za-z0-9_-]+/g, 'xai-***').slice(0, 240);
          console.error('[ai] upstream', res.statusCode, model, cfg.baseHost, hint, 'elapsed=' + (Date.now() - started));
          const publicMessage = publicFromUpstream(res.statusCode, raw) || '服务器内部错误，请稍后重试。';
          reject(new AiError('UPSTREAM', `AI 服务返回 ${res.statusCode}`, {
            status: res.statusCode,
            publicMessage
          }));
        });
        return;
      }
      let buf = '';
      let full = '';
      let firstTokenAt = 0;
      let settled = false;
      const firstTimer = setTimeout(() => {
        if (!firstTokenAt && !settled) {
          settled = true;
          req.destroy();
          console.warn('[ai] first token timeout', Date.now() - started, 'model=' + model);
          reject(new AiError('TIMEOUT', 'first token timeout', {
            publicMessage: 'AI响应较慢，请重新尝试。',
            timeoutType: 'first_token'
          }));
        }
      }, firstTokenMs);
      const totalTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          req.destroy();
          console.warn('[ai] total timeout', Date.now() - started, 'out=' + estTokens(full));
          reject(new AiError('TIMEOUT', 'total timeout', {
            publicMessage: 'AI请求超时，请重试。',
            timeoutType: 'total'
          }));
        }
      }, totalMs);

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(firstTimer);
        clearTimeout(totalTimer);
        const total = Date.now() - started;
        console.log('[ai] stream done model=' + model +
          ' xai_first_token_ms=' + (firstTokenAt || total) +
          ' xai_total_ms=' + total +
          ' output_tokens=' + estTokens(full));
        resolve({ text: full, firstTokenMs: firstTokenAt, totalMs: total, model });
      };

      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        lines.forEach((line) => {
          const parsedLine = parseSseDelta(line);
          if (!parsedLine) return;
          if (parsedLine.done) return;
          if (parsedLine.text) {
            if (!firstTokenAt) firstTokenAt = Date.now() - started;
            full += parsedLine.text;
            if (typeof opts.onDelta === 'function') opts.onDelta(parsedLine.text, full);
          }
        });
      });
      res.on('end', finish);
      res.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(firstTimer);
        clearTimeout(totalTimer);
        reject(new AiError('NETWORK', e.message, { publicMessage: '网络连接失败。' }));
      });
    });

    req.setTimeout(totalMs + 5000, () => {
      req.destroy();
    });
    req.on('error', (e) => {
      reject(e instanceof AiError ? e : new AiError('NETWORK', e.message, { publicMessage: '网络连接失败。' }));
    });
    if (opts.signal) {
      const abort = () => {
        req.destroy();
        reject(new AiError('ABORTED', 'cancelled', { publicMessage: '已取消。' }));
      };
      if (opts.signal.aborted) return abort();
      opts.signal.addEventListener('abort', abort, { once: true });
    }
    req.write(payload);
    req.end();
  });
}

function fasterFallback(current) {
  const skip = /imagine|tts|whisper|embed|vision|image|video|voice|audio/i;
  const chat = availableModels.filter((id) => id && !skip.test(id));
  const fast = chat.find((id) => /fast|mini|flash|lite/i.test(id) && id !== current);
  if (fast) return fast;
  return chat.find((id) => id !== current) || '';
}

async function callChatStreamWithRetry(messages, settings, options) {
  const cfg = resolveAiConfig(settings || {});
  const opts = options || {};
  const firstMs = opts.firstTokenMs || cfg.firstTokenMs || 20000;
  const primary = opts.model || cfg.model;
  const models = [primary];
  const fast = fasterFallback(primary);
  if (fast) models.push(fast);
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    try {
      return await callChatStream(messages, settings, { ...opts, model: models[i], firstTokenMs: firstMs });
    } catch (e) {
      lastErr = e;
      if (opts.signal && opts.signal.aborted) throw e;
      if (e.code === 'TIMEOUT' && i < models.length - 1) {
        console.warn('[ai] first-token timeout model=' + models[i] + ' retry=' + models[i + 1]);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function callChat(messages, settings, options) {
  const result = await callChatStreamWithRetry(messages, settings, options);
  if (!result.text) throw new AiError('EMPTY', 'AI 没有返回内容', { publicMessage: 'AI没有返回内容，请换一句再试。' });
  return result.text;
}

async function probeAi() {
  const cfg = resolveAiConfig({});
  if (!cfg.configured) return { ok: false, reason: 'empty', cfg };
  if (!cfg.keyLooksValid) return { ok: false, reason: cfg.keyKind, cfg };
  try {
    const ids = await listModels(cfg);
    return { ok: true, models: ids, cfg };
  } catch (e) {
    return { ok: false, status: e.status, reason: e.message, cfg };
  }
}

async function describeImage(filePath, mime) {
  const fs = require('fs');
  const cfg = resolveAiConfig({});
  assertKeyUsable(cfg);
  const buf = fs.readFileSync(filePath);
  if (!buf.length) throw new AiError('EMPTY', 'empty image', { publicMessage: '图片文件是空的。' });
  if (buf.length > 8 * 1024 * 1024) {
    throw new AiError('UPSTREAM', 'image too large', { publicMessage: '图片超过8MB，请压缩后重试。' });
  }
  const mimeType = mime && String(mime).startsWith('image/') ? mime : 'image/jpeg';
  const dataUrl = 'data:' + mimeType + ';base64,' + buf.toString('base64');
  const prompt = [
    '识别这张图中的全部可见中文和英文文字，并判断用途。只输出一个JSON对象，不要Markdown。',
    '{"type":"poster|license|screenshot|photo|other","text":"按阅读顺序的全部文字","title":"主标题","colors":["主色","辅色"],"layout":"版式简述","logo":"Logo位置","ratio":"比例如4:5","points":["要点1"]}'
  ].join('\n');
  const models = [cfg.model, 'grok-4.6', 'grok-2-vision-1212'].filter((v, i, a) => v && a.indexOf(v) === i);
  let lastErr;
  for (let i = 0; i < models.length; i++) {
    const payload = JSON.stringify({
      model: models[i],
      temperature: 0,
      max_tokens: 1600,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }]
    });
    const url = chatCompletionsUrl(cfg.apiBaseUrl);
    try {
      const res = await requestJson('POST', url, { Authorization: 'Bearer ' + cfg.apiKey }, payload, 90000);
      if (res.status !== 200) {
        const hint = String(res.data || '').replace(/xai-[A-Za-z0-9_-]+/g, 'xai-***').slice(0, 200);
        console.error('[vision] upstream', res.status, models[i], hint);
        lastErr = new AiError('UPSTREAM', 'vision ' + res.status, {
          status: res.status,
          publicMessage: publicFromUpstream(res.status, res.data) || '图片识别失败。'
        });
        if (res.status === 400 || res.status === 404) continue;
        throw lastErr;
      }
      const json = JSON.parse(res.data);
      const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!content) throw new AiError('EMPTY', 'vision empty', { publicMessage: '图片识别没有返回文字。' });
      console.log('[vision] ok model=' + models[i] + ' chars=' + String(content).length);
      return { model: models[i], content: String(content) };
    } catch (e) {
      lastErr = e;
      if (e.code === 'TIMEOUT' || (e.status && e.status >= 500)) continue;
    }
  }
  throw lastErr || new AiError('UPSTREAM', 'vision failed', { publicMessage: '图片识别失败，请稍后重试。' });
}

async function generateImage(prompt, settings, options) {
  const cfg = resolveAiConfig(settings || {});
  if (!cfg.imageConfigured) throw new AiError('IMAGE_NOT_CONFIGURED', '未配置图片模型。请设置 IMAGE_API_KEY 或 AI_API_KEY。');
  if (cfg.provider === 'gemini') {
    throw new AiError('IMAGE_NOT_CONFIGURED', '当前 Gemini 通道未启用图片生成，请使用 OpenAI 图片或快速模板。');
  }
  const baseUrl = sanitizeBase(process.env.IMAGE_API_BASE, cfg.provider === 'xai' ? XAI_DEFAULT_BASE : 'https://api.openai.com/v1');
  const url = baseUrl.replace(/\/$/, '') + '/images/generations';
  const body = JSON.stringify({
    model: cfg.imageModel,
    prompt: String(prompt || '').slice(0, 3000),
    size: (options && options.size) || '1024x1792',
    response_format: 'b64_json',
    n: 1
  });
  const res = await requestJson('POST', url, { Authorization: 'Bearer ' + cfg.imageKey }, body, 120000);
  if (res.status !== 200) throw new AiError('UPSTREAM', `图片服务返回 ${res.status}`);
  const json = JSON.parse(res.data);
  const b64 = json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw new AiError('EMPTY', '图片模型没有返回图像');
  return { mime: 'image/png', dataUrl: 'data:image/png;base64,' + b64 };
}

module.exports = {
  resolveAiConfig,
  callChat,
  callChatStream,
  callChatStreamWithRetry,
  describeImage,
  generateImage,
  AiError,
  maskSecret,
  probeAi,
  keyHint,
  classifyKey,
  estTokens,
  refreshRuntimeModel,
  getRuntimeModel,
  availableModels: () => availableModels.slice()
};
