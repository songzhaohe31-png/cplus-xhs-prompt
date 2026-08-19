const { pickKnowledge } = require('./extract');
const { findDuplicates, suggestAngle } = require('./duplicate');

const DEFAULT_AGENT = {
  brandBackground: 'CPLUS GROUP LIMITED (HK) / 协加集团（香港）有限公司。总部香港，持牌 TCSP，做公司注册、秘书合规、开户辅导、年审、SCR/KYC、牌照咨询与跨境架构。不是炒币号，不是办卡号。',
  accountPosition: '企业合规干货号。只做能落地的硬知识，不做品牌软文号。',
  targetAudience: '25-45岁内地企业主、财务/法务、跨境电商与支付从业者；正在办香港公司，或已被催 SCR、KYC、年审、开户、牌照。',
  serviceScope: '香港/新加坡公司注册；法定秘书与年审；SCR 与 KYC；银行开户辅导（不承诺开出）；经济实质；TCSP/MSO/Trustee/SFC 1/4/9 门槛解释；LPF/OFC 常识；ODI 与 37 号文科普；EOR/HRO 点到为止。默认不写支付信用卡与 Web3 产品线。',
  copyRules: '封面 12-18 字，痛点/结果/反差。正文 350-550 字：钩子 1-2 句 → 3-4 个短分点 → 收束 → 一条提问。口语专业，专有名词第一次括号补人话。',
  imageRules: '默认海报 1122×1402。写清主标题、副标题、2-4 个信息块。用海军蓝/钴蓝/白，少量青绿或金。不要写「做一张专业封面」。',
  complianceRules: '不承诺包过开户或牌照；不保证免税或不被抽查；不编造罚款金额、客户名、内部通道；不教规避监管；不恐吓式监管话术。事实不清标【待核对】。',
  bannedWords: '包过,稳过,保证开户,保证免税,内幕通道,百分百,稳赚,灰色路径,绕过监管',
  fixedCta: '有在办香港公司、被催年审或开户的，评论区说卡在哪一步。',
  fixedHashtags: '#香港公司 #企业合规',
  officialSources: '公司画册、持牌口径、公众号已审文章、已发布小红书旧帖。官网 c-plusgroup.com。',
  updatedAt: new Date().toISOString()
};

function detectIntent(text) {
  const t = String(text || '');
  if (/合规|违规|敏感|不能写/.test(t)) return 'compliance';
  if (/复盘|数据|曝光|点赞|收藏/.test(t)) return 'review';
  if (/拆|选题|5个|五个/.test(t) && /文|篇|文章/.test(t)) return 'explode';
  if (/单篇|一篇|写一篇/.test(t)) return 'single';
  if (/本周|这周|3篇|三篇|四篇|4篇/.test(t)) return 'week';
  if (/月|下月|月度|排期/.test(t)) return 'month';
  if (/海报|图片|封面图/.test(t)) return 'poster';
  return 'general';
}

function buildSystemPrompt(agent, rules) {
  const a = agent || {};
  const r = rules || {};
  return [
    '你是 CPLUS GROUP LIMITED (HK) 的新媒体运营助理，不是提示词生成器。',
    '用户说一句话，你直接产出可用结果：排期表、成稿、拆解或合规意见。不要先问一堆表格。',
    '分层依据：1) 本系统规则 2) 知识库摘录 3) 历史旧帖 4) 用户这一句。不得编造未提供的数字、案例、时限。',
    '',
    '## 品牌与账号',
    `品牌：${a.brandBackground || r.accountPosition || ''}`,
    `定位：${a.accountPosition || r.accountPosition || ''}`,
    `客户：${a.targetAudience || r.targetAudience || ''}`,
    `服务范围：${a.serviceScope || ''}`,
    `人设：${r.persona || '专业但不端着'}`,
    '',
    '## 文案与图片规则',
    a.copyRules || r.writingStyle || '',
    `封面：${r.coverTitleStyle || ''} 上限${r.coverTitleMaxLength || 18}字`,
    `结构：${r.bodyStructure || ''}`,
    `字数：${r.wordCountMin || 350}-${r.wordCountMax || 550}`,
    a.imageRules || r.imageSuggestions || '',
    `固定 CTA：${a.fixedCta || ''}`,
    `固定标签：${a.fixedHashtags || r.tagRule || ''}`,
    '',
    '## 合规',
    a.complianceRules || '',
    `禁用：${a.bannedWords || r.prohibitions || ''}`,
    `资料来源口径：${a.officialSources || ''}`,
    '',
    '## 成稿模板（单篇必须包含）',
    '【封面标题】',
    '【副标题/三个重点】',
    '【笔记正文】',
    '【CTA】',
    '【Hashtag】',
    '【海报制作说明】',
    '【参考资料】',
    '【待人工确认事项】'
  ].join('\n');
}

function buildContext(opts) {
  const {
    agent, rules, knowledge, feed, contents, materials, message
  } = opts;
  const sources = [];
  const picked = pickKnowledge(knowledge, message, 6);
  picked.forEach((k) => {
    sources.push({ type: 'knowledge', id: k.id, name: k.name, category: k.category || '' });
  });
  const feedText = (feed || []).slice(-12).reverse().map((f, i) => {
    sources.push({ type: 'feed', id: f.id, name: '历史小红书 ' + (i + 1) });
    return `旧帖${i + 1}（${f.rating || '未标'}）：\n${(f.caption || '').slice(0, 500)}`;
  }).join('\n\n');
  const matText = (materials || []).slice(-8).map((m, i) => {
    sources.push({ type: 'material', id: m.id, name: m.title });
    return `素材${i + 1} ${m.title}\n${m.summary || ''}\n${m.keyPoints || ''}`;
  }).join('\n\n');
  const knowText = picked.map((k, i) => `资料${i + 1}《${k.name}》[${k.category || ''} / ${k.jurisdiction || ''}]\n${(k.excerpt || '').slice(0, 1800)}`).join('\n\n');

  const userBlock = [
    '## 知识库摘录',
    knowText || '（无匹配资料）',
    '',
    '## 历史小红书文案',
    feedText || '（暂无）',
    '',
    '## 公众号/已存素材',
    matText || '（暂无）',
    '',
    '## 用户指令',
    message
  ].join('\n');

  const dup = findDuplicates({ title: message, body: message, createdAt: new Date().toISOString() }, [
    ...(contents || []),
    ...(feed || []).map((f) => ({ id: f.id, title: (f.caption || '').split('\n')[0], body: f.caption, createdAt: f.createdAt }))
  ]);

  return {
    system: buildSystemPrompt(agent, rules),
    user: userBlock,
    sources,
    duplicates: dup,
    dupHint: suggestAngle(dup),
    intent: detectIntent(message)
  };
}

module.exports = { DEFAULT_AGENT, detectIntent, buildSystemPrompt, buildContext };
