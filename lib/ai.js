const http = require('http');
const https = require('https');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const XAI_DEFAULT_BASE = 'https://api.x.ai/v1';
const XAI_MODELS = ['grok-4.6', 'grok-4.5', 'grok-4'];

class AiError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.status = extra && extra.status;
    this.publicMessage = (extra && extra.publicMessage) || message;
  }
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
  const a = cleanSecret(process.env.AI_API_KEY || '');
  const b = cleanSecret(process.env.XAI_API_KEY || '');
  const ranked = [a, b].filter(Boolean);
  return ranked.find((k) => classifyKey(k) === 'xai')
    || ranked.find((k) => classifyKey(k) === 'openai')
    || ranked[0]
    || '';
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
  const rawBase = process.env.AI_API_BASE || '';
  const apiBaseUrl = sanitizeBase(rawBase, fallbackBase);
  const model = process.env.AI_MODEL || (gemini ? 'gemini-2.0-flash' : xai ? 'grok-4.6' : 'gpt-4o-mini');
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
    imageModel,
    configured: !!apiKey,
    imageConfigured: !!imageKey,
    source: classifyKey(process.env.AI_API_KEY) === 'xai' || process.env.AI_API_KEY
      ? 'AI_API_KEY'
      : (process.env.XAI_API_KEY ? 'XAI_API_KEY' : 'none'),
    keyKind,
    keyLooksValid,
    keyLen: apiKey.length,
    baseHost,
    baseInvalid: !!(rawBase && sanitizeBase(rawBase, '') === '')
  };
}

function keyHint(cfg) {
  if (!cfg || !cfg.configured) {
    return '未配置 AI 密钥。请在 Render 的 Environment 里设置 AI_API_KEY 为 console.x.ai 创建的 xai- 开头密钥。';
  }
  if (cfg.keyKind === 'uuid') {
    return '当前填的是团队/账户 ID，不是 API 密钥。请到 console.x.ai → API Keys → Create API key，复制完整的 xai- 开头密钥，粘贴到 Render 的 AI_API_KEY（不要填到 AI_API_BASE）。';
  }
  if (cfg.keyKind === 'truncated') {
    return '当前密钥太短，像是控制台列表里带省略号的预览，不是完整密钥。请到 console.x.ai 重新 Create API key，在弹窗里立刻复制整串 xai- 密钥（很长），粘贴到 Render 的 AI_API_KEY。';
  }
  if (cfg.provider === 'xai' && !cfg.keyLooksValid) {
    return 'AI_API_KEY 格式不对。xAI 密钥必须以 xai- 开头，创建时只显示一次，请重新创建并完整复制。';
  }
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function requestJson(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new AiError('NETWORK', 'AI 接口地址无效', {
        publicMessage: 'AI 接口地址无效。请把 Render 的 AI_API_BASE 改成 https://api.x.ai/v1'
      }));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const payload = body ? Buffer.from(body) : null;
    const req = (isHttps ? https : http).request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve({ status: res.statusCode, data: data.toString('utf8'), buf: data });
      });
    });
    req.setTimeout(timeoutMs || 90000, () => {
      req.destroy(new AiError('TIMEOUT', 'AI 请求超时，请稍后重试', {
        publicMessage: 'AI 请求超时，请稍后再试。'
      }));
    });
    req.on('error', (e) => {
      if (e.code === 'TIMEOUT' || (e instanceof AiError && e.code === 'TIMEOUT')) {
        reject(e);
        return;
      }
      reject(new AiError('NETWORK', e.message, {
        publicMessage: '无法连接 AI 服务，请稍后再试。'
      }));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.includes('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function publicFromUpstream(status, data) {
  const raw = String(data || '');
  if (status === 401 || status === 403) {
    return 'xAI 拒绝了当前密钥（401）。请到 console.x.ai 新建一把 API key，在弹窗里复制完整的 xai- 字符串（不要复制列表里带 … 的预览），粘贴到 Render → Environment → AI_API_KEY，保存等待重新部署。同时确认控制台 Billing 有余额。';
  }
  if (status === 402 || (status === 429 && /quota|billing|credit|spend|balance/i.test(raw))) {
    return 'xAI 账户额度不足。请到 console.x.ai 充值后再试。';
  }
  if (status === 429) return '请求过多，请稍后再试。';
  if (status === 400 && /model/i.test(raw)) {
    return '当前模型不可用。请在 Render 把 AI_MODEL 设为 grok-4.6。';
  }
  if (status === 400) return 'AI 请求被拒绝，请稍后重试。';
  return '';
}

function assertKeyUsable(cfg) {
  if (!cfg.configured) {
    throw new AiError('AI_API_NOT_CONFIGURED', '未配置 AI。请管理员在 Render 设置环境变量 AI_API_KEY。', {
      publicMessage: keyHint(cfg)
    });
  }
  const hint = keyHint(cfg);
  if (hint && !cfg.keyLooksValid) {
    throw new AiError('BAD_KEY', hint, { publicMessage: hint });
  }
}

async function callOpenAIOnce(messages, cfg, options) {
  const url = chatCompletionsUrl(cfg.apiBaseUrl);
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: options.temperature != null ? options.temperature : 0.6,
    max_tokens: options.maxTokens || 2200
  });
  console.log('[ai] POST', cfg.baseHost, cfg.model, 'timeout=' + (options.timeoutMs || 70000));
  const res = await requestJson('POST', url, { Authorization: 'Bearer ' + cfg.apiKey }, body, options.timeoutMs || 70000);
  if (res.status !== 200) {
    const hint = String(res.data || '').replace(/xai-[A-Za-z0-9_-]+/g, 'xai-***').slice(0, 240);
    console.error('[ai] upstream', res.status, cfg.model, cfg.baseHost, hint);
    const publicMessage = publicFromUpstream(res.status, res.data) || `AI 服务返回 ${res.status}`;
    throw new AiError('UPSTREAM', `AI 服务返回 ${res.status}`, {
      status: res.status,
      publicMessage
    });
  }
  const json = JSON.parse(res.data);
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new AiError('EMPTY', 'AI 没有返回内容', { publicMessage: 'AI 没有返回内容，请换一句再试。' });
  return content;
}

function toGeminiContents(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = [];
  messages.filter((m) => m.role !== 'system').forEach((m) => {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    });
  });
  if (system && contents[0] && contents[0].role === 'user') {
    contents[0].parts[0].text = system + '\n\n' + contents[0].parts[0].text;
  }
  return { contents, system };
}

async function callGemini(messages, cfg, options) {
  const model = cfg.model || 'gemini-2.0-flash';
  const url = `${cfg.apiBaseUrl.replace(/\/$/, '')}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const packed = toGeminiContents(messages);
  const body = JSON.stringify({
    contents: packed.contents,
    generationConfig: {
      temperature: options.temperature != null ? options.temperature : 0.6,
      maxOutputTokens: options.maxTokens || 8000
    }
  });
  const res = await requestJson('POST', url, {}, body, options.timeoutMs || 120000);
  if (res.status !== 200) {
    throw new AiError('UPSTREAM', `AI 服务返回 ${res.status}`, {
      status: res.status,
      publicMessage: publicFromUpstream(res.status, res.data) || `AI 服务返回 ${res.status}`
    });
  }
  const json = JSON.parse(res.data);
  const text = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts
    ? json.candidates[0].content.parts.map((p) => p.text || '').join('')
    : '';
  if (!text) throw new AiError('EMPTY', 'AI 没有返回内容', { publicMessage: 'AI 没有返回内容，请换一句再试。' });
  return text;
}

function uniqueModels(preferred) {
  const list = [preferred].concat(XAI_MODELS);
  const seen = new Set();
  return list.filter((m) => {
    if (!m || seen.has(m)) return false;
    seen.add(m);
    return true;
  });
}

async function callChat(messages, settings, options) {
  const cfg = resolveAiConfig(settings || {});
  assertKeyUsable(cfg);
  const opts = options || {};
  const retries = opts.retries == null ? 0 : opts.retries;
  let lastErr;
  const models = cfg.provider === 'xai' ? uniqueModels(cfg.model) : [cfg.model];
  for (let m = 0; m < models.length; m++) {
    const attemptCfg = { ...cfg, model: models[m] };
    for (let i = 0; i <= retries; i++) {
      try {
        if (cfg.provider === 'gemini') return await callGemini(messages, attemptCfg, opts);
        return await callOpenAIOnce(messages, attemptCfg, opts);
      } catch (e) {
        lastErr = e.code ? e : new AiError('NETWORK', e.message, { publicMessage: '无法连接 AI 服务，请稍后再试。' });
        const status = lastErr.status;
        if (status === 401 || status === 403 || lastErr.code === 'BAD_KEY') throw lastErr;
        if (lastErr.code === 'TIMEOUT') {
          throw new AiError('TIMEOUT', lastErr.message, {
            publicMessage: '生成超时。请先到 console.x.ai 的 Billing 确认已有余额，再试一次较短的指令。'
          });
        }
        if (status === 400 && m < models.length - 1) break;
        if (status && status >= 400 && status < 500 && status !== 429) throw lastErr;
        if (i < retries) await sleep(700 * (i + 1));
      }
    }
  }
  throw lastErr;
}

async function probeAi() {
  const cfg = resolveAiConfig({});
  if (!cfg.configured) return { ok: false, reason: 'empty', cfg };
  if (!cfg.keyLooksValid) return { ok: false, reason: cfg.keyKind, cfg };
  const base = cfg.apiBaseUrl.replace(/\/$/, '');
  const url = base.includes('/v1') ? `${base}/models` : `${base}/v1/models`;
  try {
    const res = await requestJson('GET', url, { Authorization: 'Bearer ' + cfg.apiKey }, null, 15000);
    return { ok: res.status === 200, status: res.status, cfg };
  } catch (e) {
    return { ok: false, reason: e.message, cfg };
  }
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

module.exports = { resolveAiConfig, callChat, generateImage, AiError, maskSecret, probeAi, keyHint, classifyKey };
