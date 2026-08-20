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
  return k && k.zone !== 'sample';
}
function isSample(k) {
  return k && k.zone === 'sample';
}

function classifyUpload({ name, mime, text, hasImage }) {
  const blob = ((name || '') + ' ' + (text || '')).toLowerCase();
  if (hasImage || /^image\//.test(mime || '')) {
    if (text && String(text).trim().length > 40) {
      return { kind: 'post', zone: 'sample', label: '历史帖子（文案+海报）' };
    }
    return { kind: 'poster', zone: 'sample', label: '历史海报' };
  }
  if (/监管|海关|证监会|金管局|税务局|fincen|fintrac|法例|牌照指引|官方/.test(blob)) {
    return { kind: 'official', zone: 'facts', label: '监管及事实资料' };
  }
  const tags = String(text || '').match(/#[^\s#]+/g) || [];
  const short = String(text || '').length > 0 && String(text || '').length < 900;
  if (tags.length >= 2 || (/小红书|caption|话题/.test(blob) && short)) {
    return { kind: 'caption', zone: 'sample', label: '历史文案' };
  }
  if (!text && !hasImage) return { kind: 'unknown', zone: 'facts', label: '无法分类，请确认' };
  return { kind: 'company', zone: 'facts', label: '公司及服务资料' };
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

function computeReadiness(opts) {
  const knowledge = opts.knowledge || [];
  const feed = opts.feed || [];
  const dna = opts.dna || emptyDna();
  const facts = knowledge.filter(isFact);
  const samples = knowledge.filter(isSample);
  const posters = feed.filter((f) => (f.images && f.images.length) || f.posterUrl);
  const captions = feed.filter((f) => f.caption).concat(samples.filter((s) => s.caption || s.excerpt));
  const canAnalyzeCopy = captions.length >= 1;
  const canAnalyzeVisual = posters.length >= 3;
  const stale = !!(dna.analyzedAt || dna.confirmed) && (facts.length < 1 || captions.length < 3);
  const analyzed = !!(dna.analyzedAt) && !stale && !dna.stale;
  const confirmed = !!(dna.confirmed) && analyzed;
  const canGenerate = facts.length >= 1 && captions.length >= 3 && analyzed && confirmed;
  let status = '尚未上传资料';
  if (facts.length || captions.length || posters.length) status = '资料已读取';
  if (captions.length && captions.length < 3) status = '风格样本不足';
  if (facts.length >= 1 && captions.length >= 3 && !analyzed) status = '可以分析文案风格';
  if (canAnalyzeVisual && !analyzed) status = '可以分析文案和海报风格';
  if (analyzed && !confirmed) status = '分析完成，等待确认';
  if (canGenerate) status = '已准备，可以生成正式内容';
  if (stale || dna.stale) status = '资料已变更，需要重新分析';
  return {
    percent: canGenerate ? 100 : (analyzed ? 70 : (facts.length && captions.length >= 3 ? 40 : (facts.length || captions.length ? 15 : 0))),
    status,
    canAnalyze: canAnalyzeCopy,
    canAnalyzeCopy,
    canAnalyzeVisual,
    canGenerate,
    facts: facts.length,
    captions: captions.length,
    posters: posters.length,
    samples: samples.length + feed.length,
    analyzed,
    confirmed,
    stale: stale || !!dna.stale,
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

function analyzePrompt(facts, samples, feed, stats, posterCount) {
  const factText = (facts || []).slice(0, 8).map((k) => `《${k.name}》${k.business || ''} ${String(k.excerpt || '').slice(0, 400)}`).join('\n');
  const capText = (feed || []).concat(samples || []).slice(0, 8).map((s, i) => `样本${i + 1}：${String(s.caption || s.excerpt || '').slice(0, 280)}`).join('\n');
  return `根据CPLUS资料和历史样本，输出风格摘要JSON，不要Markdown。
程序已统计，必须原样使用这些数字，禁止改写：
文案篇数=${stats.n}；平均字数=${stats.avgChars}；平均标题字数=${stats.avgTitle}；平均段落=${stats.avgParas}；平均Emoji=${stats.avgEmoji}；平均Hashtag=${stats.avgTags}；常用标签=${(stats.topTags || []).map((t) => t.tag).join(' ')}；海报数量=${posterCount}。
${posterCount < 3 ? '海报样本不足。visual和fields里的海报色彩/版式/图片元素必须写“尚未上传海报，无法分析视觉风格”，禁止填写4:5、1122×1402、蓝白、Logo位置。' : '可根据海报描述视觉，并写明依据几张海报。'}
JSON：{"fields":{"positioning":"","audience":"","tone":"","titleFormula":"","hookFormula":"","bodyStructure":"","ctaRule":"","hashtagRule":"","posterColors":"","posterLayout":"","imageElements":"","mix":"","banned":"","directions":""},"copy":{"formality":"","spoken":"","hooks":"","points":""},"strategy":{"themes":"","repeatRisk":"","highPerform":"","nextTopics":""}}
每项标明是观察还是建议。不要编造费用或监管数字。

业务资料：
${factText || '（暂无）'}

历史文案：
${capText || '（暂无）'}`;
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
  applyMix
};
