const SERIES = [
  { id: 'hk-company', name: '香港公司注册及秘书服务' },
  { id: 'hk-annual', name: '香港公司年审审计税务' },
  { id: 'hk-mso', name: '香港MSO' },
  { id: 'hk-tcsp', name: '香港TCSP及信托' },
  { id: 'hk-lender', name: '香港放债人牌照' },
  { id: 'hk-sfc', name: '香港SFC' },
  { id: 'ca-msb', name: '加拿大MSB及PSP' },
  { id: 'us-msb', name: '美国MSB及MTL' },
  { id: 'hnw', name: '信托及高净值服务' }
];

const DNA_FIELDS = [
  ['positioning', '账号定位'],
  ['audience', '目标客户'],
  ['tone', '品牌语气'],
  ['titleFormula', '标题规律'],
  ['hookFormula', '开场规律'],
  ['bodyStructure', '正文结构'],
  ['ctaRule', 'CTA规律'],
  ['hashtagRule', 'Hashtag规律'],
  ['posterColors', '视觉规律'],
  ['posterLayout', '海报版式'],
  ['imageElements', '图片元素'],
  ['mix', '推荐内容比例'],
  ['banned', '禁用表达'],
  ['directions', '推荐方向']
];

const MIX12 = ['干货', '干货', '干货', '干货', '流程', '流程', '避坑', '避坑', '案例', '案例', '政策', '品牌'];

function emptyDna() {
  const fields = {};
  DNA_FIELDS.forEach(([k]) => { fields[k] = ''; });
  return {
    confirmed: false,
    analyzedAt: '',
    confirmedAt: '',
    stale: false,
    series: {},
    fields,
    copy: {},
    visual: {},
    strategy: {},
    evidence: { captions: 0, posters: 0, facts: 0 }
  };
}

function isFact(k) {
  return k && k.zone !== 'sample' && k.kind !== 'internal' && k.status !== 'failed';
}
function isSample(k) {
  return k && k.zone === 'sample';
}

function classifyUpload({ name, mime, text, hasImage }) {
  const blob = ((name || '') + ' ' + (text || '')).toLowerCase();
  if (/文字文稿|内部沟通|@zachary|@kitty|@xixi|规则沉淀|我希望你们|需求文档/.test(blob)) {
    return { kind: 'internal', zone: 'brief', label: '项目需求或内部沟通记录', needsConfirm: true };
  }
  if (hasImage || /^image\//.test(mime || '')) {
    if (text && String(text).trim().length > 40) {
      return { kind: 'post', zone: 'sample', label: '历史帖子（文案+海报）' };
    }
    return { kind: 'poster', zone: 'sample', label: '历史海报' };
  }
  if (/监管|海关|证监会|金管局|税务局|fincen|fintrac|法例|牌照指引|官方/.test(blob)) {
    return { kind: 'official', zone: 'facts', label: '牌照及合规资料' };
  }
  if (/畫冊|画册|brand|手册|profile|corporate/.test(blob)) {
    return { kind: 'brand', zone: 'facts', label: '品牌手册' };
  }
  const tags = String(text || '').match(/#[^\s#]+/g) || [];
  const short = String(text || '').length > 0 && String(text || '').length < 900;
  if (tags.length >= 2 || (/小红书|caption|话题/.test(blob) && short)) {
    return { kind: 'caption', zone: 'sample', label: '历史文案' };
  }
  if (!String(text || '').replace(/\s/g, '')) return { kind: 'unknown', zone: 'facts', label: '无法确定', needsConfirm: true };
  return { kind: 'company', zone: 'facts', label: '企业业务事实 / 服务说明' };
}

function captionStats(texts) {
  const caps = (texts || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!caps.length) return { n: 0, avgTitle: 0, avgChars: 0, avgParas: 0, avgEmoji: 0, avgTags: 0, topTags: [], script: '不足' };
  const titles = caps.map((c) => c.split('\n')[0].replace(/#[^\s#]+/g, '').trim());
  const titleLens = titles.map((t) => [...t].length);
  const avgTitle = Math.round(titleLens.reduce((a, b) => a + b, 0) / titleLens.length);
  const avgChars = Math.round(caps.reduce((a, c) => a + [...c].length, 0) / caps.length);
  const paras = caps.map((c) => c.split(/\n+/).filter(Boolean).length);
  const avgParas = Math.round(paras.reduce((a, b) => a + b, 0) / paras.length);
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
  const emojis = caps.map((c) => (c.match(emojiRe) || []).length);
  const avgEmoji = Number((emojis.reduce((a, b) => a + b, 0) / emojis.length).toFixed(1));
  const tagCount = {};
  caps.forEach((c) => {
    (c.match(/#[^\s#]+/g) || []).forEach((t) => { tagCount[t] = (tagCount[t] || 0) + 1; });
  });
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, n]) => ({ tag, n }));
  const avgTags = Number((caps.reduce((n, c) => n + ((c.match(/#[^\s#]+/g) || []).length), 0) / caps.length).toFixed(1));
  const joined = caps.join('');
  const script = /[\u4e00-\u9fff]/.test(joined) ? '简体中文为主' : '英文或其他';
  return { n: caps.length, avgTitle, avgChars, avgParas, avgEmoji, avgTags, topTags, script };
}

function materialFingerprint(knowledge, feed) {
  const facts = (knowledge || []).filter(isFact);
  const samples = (knowledge || []).filter(isSample);
  const feedCaps = (feed || []).filter((f) => f && f.caption);
  const posters = countPosters(knowledge, feed);
  const captions = feedCaps.concat(samples.filter((s) => s.caption || s.excerpt));
  const times = []
    .concat((knowledge || []).map((k) => k && (k.uploadedAt || k.updatedAt) || ''))
    .concat((feed || []).map((f) => f && (f.createdAt || f.uploadedAt || f.updatedAt) || ''))
    .filter(Boolean)
    .sort();
  return [facts.length, captions.length, posters, times[times.length - 1] || ''].join('|');
}

function countPosters(knowledge, feed) {
  const fromFeed = (feed || []).filter((f) => (f.images && f.images.length) || f.posterUrl).length;
  const fromKnow = (knowledge || []).filter((k) => k && (k.kind === 'poster' || k.kind === 'post' || (k.visual && k.visual.type === 'poster'))).length;
  return Math.max(fromFeed, fromKnow);
}

function posterNotesFrom(knowledge) {
  return (knowledge || []).map((k) => {
    const v = k && k.visual;
    if (!v) return '';
    const bits = [v.layout, Array.isArray(v.colors) ? v.colors.filter(Boolean).join('/') : '', v.logo, v.ratio].filter(Boolean);
    if (!bits.length) return '';
    return (k.name || '海报') + '：' + bits.join('，');
  }).filter(Boolean);
}

function buildLocalAnalysis(opts) {
  const facts = opts.facts || [];
  const stats = opts.stats || { n: 0, avgChars: 0, avgTitle: 0, avgParas: 0, avgEmoji: 0, avgTags: 0, topTags: [], script: '不足' };
  const posterCount = opts.posterCount || 0;
  const posterNotes = opts.posterNotes || [];
  const brand = opts.brand || {};
  const n = stats.n || 0;
  const fields = emptyDna().fields;
  fields.positioning = '建议：' + (brand.accountPosition || '跨境合规、香港企业服务及金融牌照知识型账号。');
  fields.audience = '建议：' + (brand.targetAudience || '准备出海的内地企业主及跨境合规决策人。');
  fields.tone = '建议：专业但不端着，口语化干货，不鸡汤、不恐吓营销。';
  fields.titleFormula = n
    ? `观察：标题平均${stats.avgTitle}字（依据${n}篇文案）。建议控制在10-18字，用痛点/结果/反差。`
    : '样本不足，建议封面标题10-18字。';
  fields.hookFormula = n
    ? `观察：开篇短句切入。建议开头两句切痛点或结论。`
    : '建议开头两句切痛点。';
  fields.bodyStructure = n
    ? `观察：正文平均${stats.avgChars}字，约${stats.avgParas}段。建议300-550字，短句短段，3-5个重点。`
    : '建议300-550字，短句短段。';
  fields.ctaRule = '建议：' + (brand.fixedCta || '自然收束，例如先评估公司架构、人员和合规要求。');
  fields.hashtagRule = n
    ? `观察：平均${stats.avgTags}个标签。常用 ${(stats.topTags || []).map((t) => t.tag).slice(0, 6).join(' ') || '（尚未形成稳定标签）'}。建议6-8个。`
    : '建议每篇6-8个标签，可含#香港公司 #企业合规。';
  fields.mix = brand.contentMix || '专业干货40%；痛点避坑25%；案例15%；政策更新10%；品牌转化10%。禁止12篇都是避坑。';
  fields.banned = '建议：禁用 ' + (brand.bannedWords || '保证获批、100%成功、一定开户、最快获批、零风险');
  fields.directions = facts.length
    ? '建议：从已上传业务资料中拆具体问题，一篇一个切口。'
    : '建议：先补业务资料，再按香港公司/年审/开户/牌照方向出题。';
  const visual = { n: posterCount };
  if (posterCount < 3) {
    fields.posterColors = '尚未上传足够海报，无法分析视觉风格。';
    fields.posterLayout = '尚未上传足够海报，无法分析视觉风格。';
    fields.imageElements = '尚未上传足够海报，无法分析视觉风格。';
    visual.insufficient = true;
    visual.note = '尚未上传海报，无法分析视觉风格。';
  } else {
    visual.insufficient = false;
    visual.note = posterNotes.slice(0, 4).join('；');
    fields.posterColors = posterNotes.length
      ? ('观察：' + posterNotes.slice(0, 3).join('；'))
      : ('观察：已读取' + posterCount + '张海报。建议沿用海军蓝/钴蓝/白信息卡。');
    fields.posterLayout = '建议：4:5直式，主标题+一句副标题+3个重点+CPLUS标识。' + (posterNotes[0] ? ' 已见表样：' + posterNotes[0] : '');
    fields.imageElements = '建议：白色圆角信息卡、清晰标题层级、品牌标识；禁止复杂小字和监管Logo。';
  }
  return {
    fields,
    copy: {
      formality: n ? '观察：口语化专业干货' : '',
      spoken: n ? '观察：简体中文为主' : '',
      script: stats.script || '',
      avgChars: String(stats.avgChars || 0),
      titleLen: String(stats.avgTitle || 0),
      avgParas: String(stats.avgParas || 0),
      avgEmoji: String(stats.avgEmoji || 0),
      avgTags: String(stats.avgTags || 0),
      hashtags: (stats.topTags || []).map((t) => t.tag + '×' + t.n).join(' '),
      n
    },
    visual,
    strategy: {
      themes: '香港公司合规、开户、牌照与出海准备。',
      repeatRisk: n < 3 ? '样本偏少，重复风险待更多历史文案后再判断。' : '已有历史样本，出题时避开近题。',
      highPerform: n ? `标题约${stats.avgTitle}字、正文约${stats.avgChars}字的结构可延续。` : '',
      nextTopics: facts.length ? '从已上传资料中拆一个具体问题。' : '补业务资料后再规划正式选题。'
    },
    source: 'local'
  };
}

function computeReadiness(opts) {
  const knowledge = opts.knowledge || [];
  const feed = opts.feed || [];
  const dna = opts.dna || emptyDna();
  const facts = knowledge.filter(isFact);
  const samples = knowledge.filter(isSample);
  const posters = countPosters(knowledge, feed);
  const captions = feed.filter((f) => f.caption).concat(samples.filter((s) => s.caption || s.excerpt));
  const canAnalyzeCopy = captions.length >= 1;
  const canAnalyzeVisual = posters >= 3;
  const fp = materialFingerprint(knowledge, feed);
  const stale = !!(dna.stale) || !!(dna.analyzedAt && dna.materialKey && dna.materialKey !== fp);
  const analyzed = !!(dna.analyzedAt) && !stale;
  const confirmed = !!(dna.confirmed) && analyzed;
  const canGenerate = facts.length >= 1 && captions.length >= 3 && analyzed && confirmed;
  let status = '尚未上传资料';
  if (facts.length || captions.length || posters) status = '资料已读取';
  if (captions.length && captions.length < 3) status = '风格样本不足，建议至少3篇历史文案';
  if (captions.length >= 1 && !analyzed) status = '可以分析文案风格';
  if (canAnalyzeVisual && !analyzed) status = '可以分析文案和海报风格';
  if (analyzed && !confirmed) status = '分析完成，等待确认';
  if (analyzed && facts.length < 1) status = '风格已分析，生成正式内容还需业务资料';
  if (canGenerate) status = '已准备，可以生成正式内容';
  if (stale) status = '资料已变更，需要重新分析';
  return {
    percent: canGenerate ? 100 : (analyzed ? 70 : (facts.length && captions.length >= 3 ? 40 : (facts.length || captions.length ? 15 : 0))),
    status,
    canAnalyze: canAnalyzeCopy,
    canAnalyzeCopy,
    canAnalyzeVisual,
    canGenerate,
    facts: facts.length,
    captions: captions.length,
    posters,
    samples: samples.length + feed.length,
    analyzed,
    confirmed,
    stale,
    next: canGenerate ? 'generate' : (!facts.length && !captions.length ? 'upload' : (!analyzed ? 'analyze' : 'confirm'))
  };
}

function dnaToPrompt(dna) {
  if (!dna || !dna.confirmed || dna.stale) return '';
  const f = dna.fields || {};
  return [
    '已确认的CPLUS账号风格（必须遵守，不要复述给用户，不要输出这些字段名）：',
    f.positioning && ('定位：' + f.positioning),
    f.audience && ('客户：' + f.audience),
    f.tone && ('语气：' + f.tone),
    f.titleFormula && ('标题：' + f.titleFormula),
    f.hookFormula && ('开场：' + f.hookFormula),
    f.bodyStructure && ('正文：' + f.bodyStructure),
    f.ctaRule && ('CTA：' + f.ctaRule),
    f.hashtagRule && ('标签：' + f.hashtagRule),
    f.banned && ('禁用：' + f.banned),
    '内容类型必须多样，禁止12篇都是避坑。'
  ].filter(Boolean).join('\n');
}

function analyzePrompt(facts, samples, feed, stats, posterCount, posterNotes) {
  const factText = (facts || []).slice(0, 6).map((k) => `《${k.name}》${String(k.excerpt || '').slice(0, 280)}`).join('\n');
  const capText = (feed || []).concat(samples || []).slice(0, 8).map((s, i) => `样本${i + 1}：${String(s.caption || s.excerpt || '').slice(0, 220)}`).join('\n');
  const visText = (posterNotes || []).slice(0, 4).join('\n');
  return `根据CPLUS资料和历史样本，输出风格摘要JSON，不要Markdown。20秒内完成。
程序已统计，必须原样使用这些数字，禁止改写：
文案篇数=${stats.n}；平均字数=${stats.avgChars}；平均标题字数=${stats.avgTitle}；平均段落=${stats.avgParas}；平均Emoji=${stats.avgEmoji}；平均Hashtag=${stats.avgTags}；常用标签=${(stats.topTags || []).map((t) => t.tag).join(' ')}；海报数量=${posterCount}。
${posterCount < 3 ? '海报样本不足。visual和fields里的海报色彩/版式/图片元素必须写“尚未上传海报，无法分析视觉风格”，禁止填写4:5、1122×1402、蓝白、Logo位置。' : '可根据海报描述视觉，并写明依据几张海报。'}
JSON：{"fields":{"positioning":"","audience":"","tone":"","titleFormula":"","hookFormula":"","bodyStructure":"","ctaRule":"","hashtagRule":"","posterColors":"","posterLayout":"","imageElements":"","mix":"","banned":"","directions":""},"copy":{"formality":"","spoken":"","hooks":"","points":""},"strategy":{"themes":"","repeatRisk":"","highPerform":"","nextTopics":""}}
每项标明是观察还是建议。不要编造费用或监管数字。

业务资料：
${factText || '（暂无）'}

历史文案：
${capText || '（暂无）'}

海报观察：
${visText || '（暂无）'}`;
}

function applyMix(items) {
  return (items || []).map((it, i) => {
    const t = MIX12[i % MIX12.length];
    return { ...it, contentType: t, type: t };
  });
}

module.exports = {
  SERIES,
  DNA_FIELDS,
  MIX12,
  emptyDna,
  computeReadiness,
  dnaToPrompt,
  analyzePrompt,
  isFact,
  isSample,
  classifyUpload,
  captionStats,
  applyMix,
  materialFingerprint,
  countPosters,
  posterNotesFrom,
  buildLocalAnalysis
};
