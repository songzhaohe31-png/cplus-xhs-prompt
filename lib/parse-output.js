function pick(text, label) {
  const re = new RegExp('【' + label + '】[：:]?\\s*([\\s\\S]*?)(?=【|$)');
  const m = String(text || '').match(re);
  return m ? m[1].trim() : '';
}

function stripMachine(text) {
  return String(text || '')
    .replace(/<<<JSON[\s\S]*?JSON>>>/g, '')
    .replace(/```json[\s\S]*?```/g, '')
    .trim();
}

function extractJson(text) {
  const block = String(text || '').match(/<<<JSON([\s\S]*?)JSON>>>/);
  const fence = String(text || '').match(/```json([\s\S]*?)```/);
  const raw = (block && block[1]) || (fence && fence[1]) || '';
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw.trim());
  } catch (e) {
    return null;
  }
}

function splitPosts(text) {
  const parts = String(text || '').split(/\n-{3,}\n|————|———/).map((p) => p.trim()).filter((p) => /【封面标题】|【内容主题】/.test(p));
  return parts.length ? parts : (/【封面标题】|【小红书正文】/.test(text) ? [text] : []);
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

function parseTable(text) {
  const lines = String(text || '').split('\n').filter((l) => l.includes('|'));
  if (lines.length < 2) return [];
  const rows = [];
  lines.forEach((line) => {
    if (/^\s*\|?\s*-+/.test(line)) return;
    const cols = line.split('|').map((c) => c.trim()).filter((c, i, arr) => !(i === 0 && !c) && !(i === arr.length - 1 && !c));
    if (!cols.length || /周数|封面标题|选题/.test(cols.join('')) && rows.length === 0 && /周|标题/.test(cols[0] + cols[1])) {
      if (!rows.length && /周|序号|标题/.test(cols.join(''))) return;
    }
    if (cols.length < 3) return;
    rows.push({
      week: cols[0],
      publishAt: cols[1],
      title: cols[2] || cols[1],
      type: cols[3] || '',
      audience: cols[4] || '',
      pain: cols[5] || '',
      purpose: cols[6] || '',
      offer: cols[7] || '',
      source: cols[8] || '',
      status: 'Draft'
    });
  });
  return rows.filter((r) => r.title && r.title.length > 1 && r.title !== '选题标题');
}

function parseAgentReply(raw, intent) {
  const json = extractJson(raw);
  const visible = stripMachine(raw);
  let type = intent === 'month' ? 'schedule' : intent === 'week' || intent === 'single' ? 'posts' : intent === 'compliance' ? 'compliance' : intent === 'review' ? 'review' : 'general';
  let items = [];
  if (json && Array.isArray(json.items) && json.items.length) {
    type = json.type || type;
    items = json.items.map((it) => ({ ...it, status: 'Draft' }));
  } else {
    const posts = splitPosts(visible).map(parsePost).filter(Boolean);
    const table = parseTable(visible);
    if (posts.length) {
      type = posts.length > 1 ? 'posts' : 'single';
      items = posts;
    } else if (table.length) {
      type = 'schedule';
      items = table;
    }
  }
  return { type, items, visible, rawLength: String(raw || '').length };
}

module.exports = { parseAgentReply, parsePost, stripMachine };
