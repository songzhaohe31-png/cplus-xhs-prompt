const crypto = require('crypto');

const sessions = new Map();

function parseCookie(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function publicUser(user) {
  if (!user) return { id: 'guest', name: '访客', role: 'editor' };
  return { id: user.id, name: user.name, role: user.role };
}

function createAuth(opts) {
  const { readData, writeData, ensureDataFile, newId } = opts;

  const DEFAULT_USERS = {
    items: [
      { id: 'u-admin', name: 'Admin', role: 'admin', pin: process.env.ADMIN_PIN || '2468' },
      { id: 'u-editor', name: 'Editor', role: 'editor', pin: process.env.EDITOR_PIN || '1357' },
      { id: 'u-reviewer', name: 'Reviewer', role: 'reviewer', pin: process.env.REVIEWER_PIN || '8642' }
    ]
  };
  ensureDataFile('users.json', DEFAULT_USERS);

  function loadUsers() {
    const data = readData('users.json') || DEFAULT_USERS;
    return Array.isArray(data.items) ? data.items : DEFAULT_USERS.items;
  }

  function saveUsers(items) {
    writeData('users.json', { items });
  }

  function authRequired() {
    const settings = readData('settings.json') || {};
    return !!settings.authRequired;
  }

  function currentUser(req) {
    const sid = parseCookie(req).cplus_sid;
    const sess = sid && sessions.get(sid);
    if (sess) return sess;
    if (!authRequired()) return { id: 'guest-admin', name: '开放模式', role: 'admin' };
    return { id: 'guest', name: '访客', role: 'viewer' };
  }

  function can(user, action) {
    const role = (user && user.role) || 'viewer';
    if (role === 'admin') return true;
    const map = {
      editor: ['content.write', 'content.submit', 'knowledge.upload', 'calendar.view', 'chat.use'],
      reviewer: ['content.review', 'calendar.view', 'chat.use'],
      viewer: ['calendar.view']
    };
    return (map[role] || []).includes(action);
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      const user = currentUser(req);
      req.user = user;
      if (roles.length && !roles.includes(user.role) && user.role !== 'admin') {
        return res.status(403).json({ error: '没有权限', code: 'FORBIDDEN' });
      }
      next();
    };
  }

  function login(pin) {
    const user = loadUsers().find((u) => String(u.pin) === String(pin));
    if (!user) return null;
    const sid = crypto.randomBytes(18).toString('hex');
    const sess = { id: user.id, name: user.name, role: user.role };
    sessions.set(sid, sess);
    return { sid, user: publicUser(sess) };
  }

  function logout(req) {
    const sid = parseCookie(req).cplus_sid;
    if (sid) sessions.delete(sid);
  }

  function setSessionCookie(res, sid) {
    res.setHeader('Set-Cookie', `cplus_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
  }

  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', 'cplus_sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  }

  return {
    loadUsers,
    saveUsers,
    currentUser,
    publicUser,
    can,
    requireRole,
    login,
    logout,
    setSessionCookie,
    clearSessionCookie,
    authRequired
  };
}

module.exports = { createAuth };
