const https = require('https');
const http = require('http');

const ALLOWED = [
  { keys: ['公司注册', '周年申报', '年审', 'SCR', '公司秘书', '商业登记'], name: '香港公司注册处', url: 'https://www.cr.gov.hk/' },
  { keys: ['税务', '利得税', '报税', '审计'], name: '香港税务局', url: 'https://www.ird.gov.hk/' },
  { keys: ['MSO', '金钱服务', '汇款', '兑换'], name: '香港海关金钱服务', url: 'https://www.customs.gov.hk/' },
  { keys: ['SFC', '证监会', '证券', '9号', '4号', '1号牌'], name: '香港证监会', url: 'https://www.sfc.hk/' },
  { keys: ['金管局', '银行开户', 'HKMA', 'AML'], name: '香港金融管理局', url: 'https://www.hkma.gov.hk/' },
  { keys: ['法例', '公司条例'], name: '电子版香港法例', url: 'https://www.elegislation.gov.hk/' },
  { keys: ['FINTRAC', '加拿大', 'MSB', 'PSP'], name: 'FINTRAC', url: 'https://fintrac-canafe.canada.ca/' },
  { keys: ['FinCEN', '美国MSB', 'MTL'], name: 'FinCEN', url: 'https://www.fincen.gov/' },
  { keys: ['NMLS'], name: 'NMLS', url: 'https://www.nmlsconsumeraccess.org/' }
];

function chunkText(text, name, meta) {
  const clean = String(text || '').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n+/);
  const chunks = [];
  let buf = '';
  let n = 1;
  paras.forEach((p) => {
    if ((buf + '\n' + p).length > 900 && buf) {
      chunks.push({ id: meta.id + '-' + n, knowledgeId: meta.id, name, page: n, text: buf.trim(), ...meta });
      n += 1;
      buf = p;
    } else buf = buf ? buf + '\n' + p : p;
  });
  if (buf.trim()) chunks.push({ id: meta.id + '-' + n, knowledgeId: meta.id, name, page: n, text: buf.trim(), ...meta });
  return chunks;
}

function score(text, query) {
  const q = String(query || '').toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!q || !t) return 0;
  const words = q.split(/[\s,，。！？、]+/).filter((w) => w.length > 1);
  if (!words.length) return 0;
  let n = 0;
  words.forEach((w) => { if (t.includes(w)) n += 1; });
  return n / words.length;
}

function searchChunks(chunks, query, limit) {
  const now = new Date().toISOString().slice(0, 10);
  return (chunks || [])
    .map((c) => {
      const expired = c.expiresAt && c.expiresAt < now;
      return { chunk: c, score: score((c.text || '') + ' ' + (c.name || ''), query), expired };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 8);
}

function pickOfficial(query) {
  const q = String(query || '');
  return ALLOWED.filter((s) => s.keys.some((k) => q.includes(k))).slice(0, 3);
}

function fetchUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) return resolve({ ok: false, error: 'bad protocol' });
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'CPLUS-Agent/1.0' },
        timeout: timeoutMs || 8000
      }, (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
          if (data.length > 200000) req.destroy();
        });
        res.on('end', () => {
          const text = data.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2500);
          resolve({ ok: true, url, status: res.statusCode, text, fetchedAt: new Date().toISOString() });
        });
      });
      req.on('error', (e) => resolve({ ok: false, url, error: e.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, url, error: 'timeout' });
      });
    } catch (e) {
      resolve({ ok: false, url, error: e.message });
    }
  });
}

async function lookupOfficial(query) {
  const sites = pickOfficial(query).slice(0, 2);
  const rows = await Promise.all(sites.map(async (s) => {
    const got = await fetchUrl(s.url, 2500);
    return {
      name: s.name,
      url: s.url,
      fetchedAt: got.fetchedAt || new Date().toISOString(),
      ok: !!got.ok,
      excerpt: got.ok ? String(got.text || '').slice(0, 800) : '',
      error: got.ok ? '' : (got.error || 'fetch failed'),
      note: got.ok ? '已抓取页面公开文字，请人工核对是否为最新规定。' : '未能访问官方页面，相关时限/费用必须标待人工确认。'
    };
  }));
  return rows;
}

module.exports = { chunkText, searchChunks, lookupOfficial, ALLOWED };
