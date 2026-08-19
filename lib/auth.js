const crypto = require('crypto');

const sessions = new Map();
const fails = new Map();

function parseCookie(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), useSalt, 32).toString('hex');
  return `${useSalt}:${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || !String(stored).includes(':')) return false;
  const [salt, prev] = String(stored).split(':');
  const next = crypto.scryptSync(String(password), salt, 32);
  const prevBuf = Buffer.from(prev, 'hex');
  if (next.length !== prevBuf.length) return false;
  return crypto.timingSafeEqual(next, prevBuf);
}

function publicUser(user) {
  if (!user || user.id === 'guest') return null;
  return { id: user.id, name: user.name, role: user.role };
}

function clientKey(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'ip').toString().split(',')[0].trim();
}

function createAuth(opts) {
  const { readData, writeData, ensureDataFile, newId } = opts;

  ensureDataFile('users.json', { items: [] });

  function loadUsers() {
    const data = readData('users.json') || { items: [] };
    return Array.isArray(data.items) ? data.items : [];
  }

  function saveUsers(items) {
    writeData('users.json', { items });
  }

  function bootstrap() {
    let items = loadUsers()
      .map((u) => {
        const copy = { ...u };
        delete copy.pin;
        return copy;
      })
      .filter((u) => u.passwordHash);
    const hasAdmin = items.some((u) => u.role === 'admin' && u.passwordHash);
    const pwd = process.env.ADMIN_PASSWORD || '';
    if (!hasAdmin) {
      if (!pwd) {
        console.warn('[auth] 没有管理员。请设置环境变量 ADMIN_PASSWORD 后重启。');
      } else {
        items.push({
          id: 'u-admin',
          name: process.env.ADMIN_NAME || 'Admin',
          role: 'admin',
          passwordHash: hashPassword(pwd),
          createdAt: new Date().toISOString()
        });
        console.log('[auth] 已从 ADMIN_PASSWORD 创建管理员，口令不会写入日志。');
      }
    }
    saveUsers(items);
  }

  bootstrap();

  function currentUser(req) {
    const sid = parseCookie(req).cplus_sid;
    const sess = sid && sessions.get(sid);
    if (sess && sess.exp > Date.now()) return sess;
    if (sess) sessions.delete(sid);
    return { id: 'guest', name: '访客', role: 'viewer' };
  }

  function isAuthed(user) {
    return user && user.id && user.id !== 'guest' && ['admin', 'editor', 'reviewer'].includes(user.role);
  }

  function locked(ip) {
    const row = fails.get(ip);
    if (!row) return false;
    if (row.until && row.until > Date.now()) return true;
    if (row.until && row.until <= Date.now()) fails.delete(ip);
    return false;
  }

  function hitFail(ip) {
    const row = fails.get(ip) || { n: 0, until: 0 };
    row.n += 1;
    if (row.n >= 8) row.until = Date.now() + 15 * 60 * 1000;
    fails.set(ip, row);
  }

  function login(name, password) {
    const ip = this && this.ip;
    void ip;
    const user = loadUsers().find((u) => String(u.name).toLowerCase() === String(name || '').trim().toLowerCase());
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) return null;
    const sid = crypto.randomBytes(24).toString('hex');
    const sess = {
      id: user.id,
      name: user.name,
      role: user.role,
      exp: Date.now() + 7 * 24 * 3600 * 1000
    };
    sessions.set(sid, sess);
    return { sid, user: publicUser(sess) };
  }

  function logout(req) {
    const sid = parseCookie(req).cplus_sid;
    if (sid) sessions.delete(sid);
  }

  function setSessionCookie(res, sid) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `cplus_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`);
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', 'cplus_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  }

  return {
    loadUsers,
    saveUsers,
    currentUser,
    publicUser,
    isAuthed,
    login,
    logout,
    setSessionCookie,
    clearSessionCookie,
    hashPassword,
    clientKey,
    locked,
    hitFail,
    clearFail: (ip) => fails.delete(ip),
    authRequired: () => true
  };
}

module.exports = { createAuth, hashPassword, verifyPassword };
