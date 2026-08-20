const { applyScheduleDates, coercePublishAt, hongKongDate } = require('./dates');

function pick(text, label) {
  const re = new RegExp('【' + label + '】[：:]?\\s*([\\s\\S]*?)(?=【|$)');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : '';
}

function tryParseJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
    } catch (e2) {
      return null;
    }
  }
}

function extractJson(text) {
  const s = String(text || '');
  const blocks = [];
  const tagged = s.match(/<<<JSON([\s\S]*?)(?:JSON>>>|$)/i);
  if (tagged) blocks.push(tagged[1]);
  const fence = s.match(/```json([\s\S]*?)```/i);
  if (fence) blocks.push(fence[1]);
  const fence2 = s.match(/```([\s\S]*?)```/);
  if (fence2) blocks.push(fence2[1]);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) blocks.push(s.slice(start, end + 1));
  for (let i = 0; i < blocks.length; i++) {
    const parsed = tryParseJson(blocks[i]);
    if (parsed && typeof parsed === 'object') return parsed;
  }
  return null;
}

function stripMachine(text) {
  return String(text || '')
    .replace(/<<<JSON[\s\S]*$/i, '')
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/(^|\n)\s*\|[^\n]*\|[ \t]*/g, '\n')
    .replace(/\n?\s*\|?\s*:?-{3,}:?\s*\|[|\s:-]*/g, '\n')
    .replace(/^\s*[\{\[][\s\S]*[\}\]]\s*$/m, '')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeJsonDump(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.startsWith('{') || t.startsWith('[')) return true;
  if (/<<<JSON|```json|"type"\s*:\s*"schedule"/.test(t)) return true;
  const symbols = (t.match(/[|{}\[\]"]/g) || []).length;
  return symbols > t.length * 0.12 && /"items"\s*:/.test(t);
}

function cleanVisibleText(text) {
  let s = stripMachine(text);
  if (looksLikeJsonDump(s)) return '';
  return s;
}

function parsePost(block) {
  const title = pick(block, '封面标题');
  const body = pick(block, '小红书正文') || pick(block, '笔记正文');
  if (!title && !body) return null;
  const points = pick(block, '封面副标题或3个重点') || pick(block, '副标题/三个重点') || pick(block, '副标题');
  return {
    topic: pick(block, '内容主题') || title,
    audience: pick(block, '目标客户'),
    purpose: pick(block, '内容目的'),
    pain: pick(block, '用户痛点') || pick(block, '痛点'),
    offer: pick(block, '转化服务') || pick(block, '转化方向'),
    title,
    subtitle: points,
    body,
    cta: pick(block, 'CTA'),
    hashtags: pick(block, 'Hashtag') || pick(block, '标签'),
    posterNotes: pick(block, '海报制作说明'),
    sourcesText: pick(block, '参考资料及链接') || pick(block, '参考资料') || pick(block, '参考素材'),
    pendingConfirm: pick(block, '需要人工确认的资料') || pick(block, '待人工确认事项'),
    riskNote: pick(block, '合规风险提示'),
    week: pick(block, '周数') || pick(block, '周'),
    publishAt: pick(block, '发布日期'),
    status: 'Draft'
  };
}

function splitPosts(text) {
  const parts = String(text || '').split(/\n-{3,}\n|————|———/).map((p) => p.trim()).filter((p) => /【封面标题】|【内容主题】/.test(p));
  return parts.length ? parts : (/【封面标题】|【小红书正文】/.test(text) ? [text] : []);
}

function splitCtaHashtags(body, cta, hashtags) {
  let b = String(body || '').trim();
  let c = String(cta || '').trim();
  let h = String(hashtags || '').trim();
  const tagTail = b.match(/((?:#[^\s#]+\s*){2,})\s*$/);
  if (tagTail) {
    if (!h) h = tagTail[1].replace(/\s+/g, ' ').trim();
    b = b.slice(0, tagTail.index).trim();
  }
  const ctaTail = b.match(/(?:如果你正在|欢迎留言|如需了解|想了解申请条件)[\s\S]{6,120}$/);
  if (ctaTail) {
    if (!c) c = ctaTail[0].trim();
    b = b.slice(0, ctaTail.index).trim();
  }
  return { body: b, cta: c, hashtags: h };
}

function cleanSubtitle(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  if (/^(Draft|Approved|Published|Rejected|Scheduled|JSON|status)$/i.test(t)) return '';
  return t;
}

function normalizeItem(it) {
  const row = it || {};
  const split = splitCtaHashtags(
    row.body || row['正文'] || row['小红书正文'] || '',
    row.cta || '',
    row.hashtags || row['Hashtag'] || ''
  );
  const subtitle = cleanSubtitle(row.subtitle || row['副标题'] || row['三个重点'] || '');
  return {
    week: row.week || row['周次'] || row['周'] || '',
    publishAt: row.publishAt || row.date || row['发布日期'] || '',
    title: row.title || row.topic || row['封面标题'] || row['标题'] || '',
    topic: row.topic || row.title || '',
    contentType: row.contentType || row.type || row['类型'] || row['内容类型'] || '',
    type: row.contentType || row.type || row['类型'] || '',
    audience: row.audience || row['目标客户'] || '',
    pain: row.pain || row['痛点'] || '',
    purpose: row.purpose || row['内容目的'] || row['目的'] || '',
    offer: row.offer || row['转化'] || '',
    subtitle,
    points: row.points || subtitle,
    body: split.body,
    cta: split.cta,
    hashtags: split.hashtags,
    posterNotes: row.posterNotes || '',
    sourcesText: row.sourcesText || row.sources || '',
    pendingConfirm: row.pendingConfirm || '',
    riskNote: row.riskNote || '',
    status: 'Draft'
  };
}

function parseAgentReply(raw, intent, slots) {
  const json = extractJson(raw);
  const visible = cleanVisibleText(raw);
  let type = intent === 'month' ? 'schedule' : intent === 'week' || intent === 'single' ? (intent === 'single' ? 'single' : 'posts') : intent === 'compliance' ? 'compliance' : intent === 'review' ? 'review' : 'general';
  let items = [];
  if (json && Array.isArray(json.items) && json.items.length) {
    type = json.type || type;
    items = json.items.map(normalizeItem);
  } else {
    const posts = splitPosts(String(raw || '')).map(parsePost).filter(Boolean);
    if (posts.length) {
      type = posts.length > 1 ? 'posts' : 'single';
      items = posts.map(normalizeItem);
    }
  }
  const today = hongKongDate();
  if (slots && slots.length && items.length && (type === 'schedule' || intent === 'month' || intent === 'week')) {
    type = 'schedule';
    items = applyScheduleDates(items, slots, today).filter((it) => it.title);
  } else {
    items = items.map((it) => ({
      ...it,
      publishAt: it.publishAt ? coercePublishAt(it.publishAt, '', today) : it.publishAt
    })).filter((it) => it.title || it.body);
  }
  const expectSlots = slots && slots.length && (intent === 'month' || intent === 'week' || type === 'schedule');
  const parseFailed = expectSlots ? items.length < Math.min(6, (slots && slots.length) || 6) : (!items.length && looksLikeJsonDump(String(raw || '')) && !visible);
  return {
    type,
    items,
    visible,
    parseFailed,
    rawLength: String(raw || '').length
  };
}

module.exports = { parseAgentReply, parsePost, stripMachine, cleanVisibleText, extractJson, looksLikeJsonDump, normalizeItem, splitCtaHashtags, cleanSubtitle };
