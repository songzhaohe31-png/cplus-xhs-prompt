const crypto = require('crypto');

function parseCookie(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip').toString().split(',')[0].trim();
}

const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const row = buckets.get(key) || { n: 0, start: now };
  if (now - row.start > windowMs) {
    row.n = 0;
    row.start = now;
  }
  row.n += 1;
  buckets.set(key, row);
  return row.n > max;
}

function attachWorkspace(req, res) {
  const cookies = parseCookie(req);
  let id = cookies.cplus_ws;
  if (!id || !/^[a-z0-9]{16,64}$/i.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
  }
  req.workspaceId = id;
  const prev = res.getHeader('Set-Cookie');
  const cookie = `cplus_ws=${id}; Path=/; SameSite=Lax; Max-Age=31536000; HttpOnly`;
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', [].concat(prev).concat(cookie));
}

const BLOCK_PREFIXES = [
  '/api/users',
  '/api/logs',
  '/api/settings',
  '/api/rules',
  '/api/ai/status',
  '/api/jobs',
  '/api/export-full',
  '/api/auth',
  '/api/prompt',
  '/api/produce',
  '/api/generate',
  '/api/review/apply'
];

function isBlocked(url) {
  const u = String(url || '').split('?')[0];
  if (u === '/api/agent/chat' || u === '/api/agent/rewrite') return false;
  if (u === '/api/agent' || u.startsWith('/api/agent/')) return true;
  return BLOCK_PREFIXES.some((p) => u === p || u.startsWith(p + '/'));
}

const busy = new Set();

module.exports = {
  clientIp,
  limited,
  attachWorkspace,
  isBlocked,
  busy
};
