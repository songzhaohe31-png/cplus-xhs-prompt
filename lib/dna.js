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
  ['titleFormula', '标题公式'],
  ['hookFormula', '开场公式'],
  ['bodyStructure', '正文结构'],
  ['ctaRule', 'CTA规则'],
  ['hashtagRule', 'Hashtag规则'],
  ['posterColors', '海报色彩'],
  ['posterLayout', '海报版式'],
  ['imageElements', '图片元素'],
  ['mix', '内容类型比例'],
  ['banned', '禁用表达'],
  ['directions', '推荐内容方向']
];

function emptyDna() {
  const fields = {};
  DNA_FIELDS.forEach(([k]) => { fields[k] = ''; });
  return {
    confirmed: false,
    analyzedAt: '',
    confirmedAt: '',
    series: {},
    fields,
    copy: {},
    visual: {},
    strategy: {}
  };
}

function isFact(k) {
  return k && k.zone !== 'sample';
}
function isSample(k) {
  return k && k.zone === 'sample';
}

function computeReadiness(opts) {
  const knowledge = opts.knowledge || [];
  const feed = opts.feed || [];
  const dna = opts.dna || emptyDna();
  const facts = knowledge.filter(isFact);
  const samples = knowledge.filter(isSample);
  const posters = feed.filter((f) => (f.images && f.images.length) || f.posterUrl);
  const captions = feed.filter((f) => f.caption) .concat(samples.filter((s) => s.caption || s.excerpt));
  let percent = 0;
  if (facts.length) percent = 25;
  if (facts.length && (captions.length || posters.length)) percent = 50;
  if (percent >= 50 && dna.analyzedAt) percent = 75;
  if (percent >= 75 && dna.confirmed) percent = 100;
  const canAnalyze = facts.length + captions.length + posters.length >= 1;
  const canGenerate = percent === 100;
  return {
    percent,
    canAnalyze,
    canGenerate,
    facts: facts.length,
    captions: captions.length,
    posters: posters.length,
    samples: samples.length + feed.length,
    analyzed: !!dna.analyzedAt,
    confirmed: !!dna.confirmed,
    next: !facts.length && !captions.length
      ? 'upload'
      : !dna.analyzedAt
        ? 'analyze'
        : !dna.confirmed
          ? 'confirm'
          : 'generate'
  };
}

function dnaToPrompt(dna) {
  if (!dna || !dna.confirmed) return '';
  const f = dna.fields || {};
  return [
    '已确认的CPLUS账号风格DNA（必须遵守，不要复述给用户）：',
    f.positioning && ('定位：' + f.positioning),
    f.audience && ('客户：' + f.audience),
    f.tone && ('语气：' + f.tone),
    f.titleFormula && ('标题：' + f.titleFormula),
    f.hookFormula && ('开场：' + f.hookFormula),
    f.bodyStructure && ('正文：' + f.bodyStructure),
    f.ctaRule && ('CTA：' + f.ctaRule),
    f.hashtagRule && ('标签：' + f.hashtagRule),
    f.posterLayout && ('海报：' + f.posterLayout),
    f.banned && ('禁用：' + f.banned)
  ].filter(Boolean).join('\n');
}

function analyzePrompt(facts, samples, feed) {
  const factText = (facts || []).slice(0, 8).map((k) => `《${k.name}》${k.business || ''} ${String(k.excerpt || '').slice(0, 400)}`).join('\n');
  const capText = (feed || []).concat(samples || []).slice(0, 8).map((s, i) => `样本${i + 1}：${String(s.caption || s.excerpt || '').slice(0, 280)}`).join('\n');
  return `根据以下CPLUS资料和历史样本，输出账号风格DNA。只输出一个JSON对象，不要Markdown。
JSON形状：
{"fields":{"positioning":"","audience":"","tone":"","titleFormula":"","hookFormula":"","bodyStructure":"","ctaRule":"","hashtagRule":"","posterColors":"","posterLayout":"","imageElements":"","mix":"","banned":"","directions":""},"copy":{"script":"","formality":"","spoken":"","titleLen":"","hooks":"","avgChars":"","emoji":"","hashtags":"","banned":""},"visual":{"ratio":"4:5","size":"1122x1402","colors":"","layout":"","logo":"","density":""},"strategy":{"themes":"","repeatRisk":"","highPerform":"","nextTopics":""}}
每项用中文短句。不要编造费用或监管数字。

业务资料：
${factText || '（暂无）'}

历史文案：
${capText || '（暂无）'}`;
}

module.exports = {
  SERIES,
  DNA_FIELDS,
  emptyDna,
  computeReadiness,
  dnaToPrompt,
  analyzePrompt,
  isFact,
  isSample
};
