const http = require('http');
const https = require('https');

class AiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function resolveAiConfig(settings) {
  const envKey = process.env.AI_API_KEY || '';
  const fileKey = (settings && settings.apiKey) || '';
  const apiKey = envKey || fileKey;
  const apiBaseUrl = process.env.AI_API_BASE || (settings && settings.apiBaseUrl) || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || (settings && settings.model) || 'gpt-4o-mini';
  return {
    apiKey,
    apiBaseUrl,
    model,
    configured: !!(apiKey && apiBaseUrl),
    source: envKey ? 'env' : (fileKey ? 'settings' : 'none')
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function postJson(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const payload = Buffer.from(body);
    const req = (isHttps ? https : http).request({
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.setTimeout(timeoutMs || 90000, () => {
      req.destroy(new AiError('TIMEOUT', 'AI 请求超时，请稍后重试'));
    });
    req.on('error', (e) => reject(e.code === 'TIMEOUT' ? e : new AiError('NETWORK', e.message)));
    req.write(payload);
    req.end();
  });
}

async function callChat(messages, settings, options) {
  const cfg = resolveAiConfig(settings || {});
  if (!cfg.configured) throw new AiError('AI_API_NOT_CONFIGURED', '未配置 AI 接口。请管理员在 Render 环境变量或后台填写 API Key。');

  const baseUrl = cfg.apiBaseUrl.replace(/\/$/, '');
  const url = baseUrl.endsWith('/chat/completions')
    ? baseUrl
    : baseUrl.includes('/v1')
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;

  const body = JSON.stringify({
    model: cfg.model,
    messages,
    temperature: options && options.temperature != null ? options.temperature : 0.7,
    max_tokens: (options && options.maxTokens) || 8000
  });

  const retries = (options && options.retries) || 2;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await postJson(url, { Authorization: 'Bearer ' + cfg.apiKey }, body, (options && options.timeoutMs) || 90000);
      if (res.status >= 500 || res.status === 429) {
        lastErr = new AiError('UPSTREAM', `AI 服务返回 ${res.status}`);
        await sleep(600 * (i + 1));
        continue;
      }
      if (res.status !== 200) {
        throw new AiError('UPSTREAM', `AI 服务返回 ${res.status}: ${res.data.slice(0, 240)}`);
      }
      const json = JSON.parse(res.data);
      const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!content) throw new AiError('EMPTY', 'AI 没有返回内容');
      return content;
    } catch (e) {
      lastErr = e.code ? e : new AiError('NETWORK', e.message);
      if (e.code === 'UPSTREAM' && String(e.message).includes(' 4')) break;
      if (i < retries) await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

module.exports = { resolveAiConfig, callChat, AiError };
