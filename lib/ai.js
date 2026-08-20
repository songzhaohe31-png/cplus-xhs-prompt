const http = require('http');
const https = require('https');

class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function maskSecret(s) {
  const t = String(s || '');
  if (t.length < 8) return t ? '****' : '';
  return t.slice(0, 3) + '****' + t.slice(-2);
}

function resolveAiConfig(settings) {
  const apiKey = process.env.AI_API_KEY || process.env.XAI_API_KEY || '';
  let provider = (process.env.AI_PROVIDER || '').toLowerCase();
  if (!provider) {
    provider = process.env.XAI_API_KEY && !process.env.AI_API_KEY ? 'xai' : (apiKey ? 'xai' : 'xai');
  }
  const xai = provider === 'xai' || provider === 'grok' || provider === 'spacexai';
  const gemini = provider === 'gemini';
  const apiBaseUrl = process.env.AI_API_BASE || (gemini
    ? 'https://generativelanguage.googleapis.com/v1beta'
    : xai
      ? 'https://api.x.ai/v1'
      : 'https://api.openai.com/v1');
  const model = process.env.AI_MODEL || (gemini ? 'gemini-2.0-flash' : xai ? 'grok-4.6' : 'gpt-4o-mini');
  const imageKey = process.env.IMAGE_API_KEY || apiKey;
  const imageModel = process.env.IMAGE_MODEL || (xai ? 'grok-imagine-image' : 'dall-e-3');
  return {
    provider: xai ? 'xai' : provider,
    apiKey,
    imageKey,
    apiBaseUrl,
    model,
    imageModel,
    configured: !!apiKey,
    imageConfigured: !!imageKey,
    source: process.env.AI_API_KEY ? 'AI_API_KEY' : (process.env.XAI_API_KEY ? 'XAI_API_KEY' : 'none')
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function requestJson(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
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
      req.destroy(new AiError('TIMEOUT', 'AI 请求超时，请稍后重试'));
    });
    req.on('error', (e) => reject(e.code === 'TIMEOUT' ? e : new AiError('NETWORK', e.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function callOpenAI(messages, cfg, options) {
  const baseUrl = cfg.apiBaseUrl.replace(/\/$/, '');
  const url = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : (baseUrl.includes('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`);
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: options.temperature != null ? options.temperature : 0.6,
    max_tokens: options.maxTokens || 8000
  });
  const res = await requestJson('POST', url, { Authorization: 'Bearer ' + cfg.apiKey }, body, options.timeoutMs || 120000);
  if (res.status !== 200) {
    const hint = String(res.data || '').replace(/xai-[A-Za-z0-9_-]+/g, 'xai-***').slice(0, 240);
    console.error('[ai] upstream', res.status, hint);
    throw new AiError('UPSTREAM', `AI 服务返回 ${res.status}`);
  }
  const json = JSON.parse(res.data);
  const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new AiError('EMPTY', 'AI 没有返回内容');
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
  if (res.status >= 500 || res.status === 429) throw new AiError('UPSTREAM', `AI 服务返回 ${res.status}`);
  if (res.status !== 200) throw new AiError('UPSTREAM', `AI 服务返回 ${res.status}`);
  const json = JSON.parse(res.data);
  const text = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts
    ? json.candidates[0].content.parts.map((p) => p.text || '').join('')
    : '';
  if (!text) throw new AiError('EMPTY', 'AI 没有返回内容');
  return text;
}

async function callChat(messages, settings, options) {
  const cfg = resolveAiConfig(settings || {});
  if (!cfg.configured) {
    throw new AiError('AI_API_NOT_CONFIGURED', '未配置 AI。请管理员在 Render 设置环境变量 AI_API_KEY。');
  }
  const opts = options || {};
  const retries = opts.retries == null ? 2 : opts.retries;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      if (cfg.provider === 'gemini') return await callGemini(messages, cfg, opts);
      return await callOpenAI(messages, cfg, opts);
    } catch (e) {
      lastErr = e.code ? e : new AiError('NETWORK', e.message);
      if (e.code === 'UPSTREAM' && /返回 4/.test(e.message) && !/429/.test(e.message)) break;
      if (i < retries) await sleep(700 * (i + 1));
    }
  }
  throw lastErr;
}

async function generateImage(prompt, settings, options) {
  const cfg = resolveAiConfig(settings || {});
  if (!cfg.imageConfigured) throw new AiError('IMAGE_NOT_CONFIGURED', '未配置图片模型。请设置 IMAGE_API_KEY 或 AI_API_KEY。');
  if (cfg.provider === 'gemini') {
    throw new AiError('IMAGE_NOT_CONFIGURED', '当前 Gemini 通道未启用图片生成，请使用 OpenAI 图片或快速模板。');
  }
  const baseUrl = (process.env.IMAGE_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = baseUrl + '/images/generations';
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

module.exports = { resolveAiConfig, callChat, generateImage, AiError, maskSecret };
