function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\s#@,，。.!！?？:：;；"'“”‘’\-_/\\|·•]/g, '');
}

function grams(s) {
  const t = normalize(s);
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

function dice(a, b) {
  const A = grams(a);
  const B = grams(b);
  if (!A.length || !B.length) return 0;
  const map = {};
  A.forEach((g) => { map[g] = (map[g] || 0) + 1; });
  let hit = 0;
  B.forEach((g) => {
    if (map[g]) {
      hit += 1;
      map[g] -= 1;
    }
  });
  return (2 * hit) / (A.length + B.length);
}

function sameCycle(a, b) {
  if (!a || !b) return false;
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return false;
  const week = (d) => {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return [t.getUTCFullYear(), Math.ceil((((t - yearStart) / 86400000) + 1) / 7)];
  };
  const wa = week(da);
  const wb = week(db);
  return (wa[0] === wb[0] && wa[1] === wb[1]) || (da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth());
}

function findDuplicates(candidate, corpus) {
  const title = candidate.title || candidate.caption || '';
  const body = candidate.body || candidate.caption || candidate.content || '';
  const topic = candidate.topic || candidate.title || '';
  const hits = [];
  (corpus || []).forEach((item) => {
    if (candidate.id && item.id === candidate.id) return;
    const otherTitle = item.title || (item.caption || '').split('\n')[0] || '';
    const otherBody = item.body || item.caption || item.content || '';
    const titleScore = dice(title, otherTitle);
    const topicScore = dice(topic, item.topic || otherTitle);
    const bodyScore = dice(body.slice(0, 600), otherBody.slice(0, 600));
    const score = Math.max(titleScore, topicScore * 0.9, bodyScore * 0.85);
    if (score < 0.34) return;
    hits.push({
      id: item.id,
      title: otherTitle.slice(0, 80),
      titleScore: Number(titleScore.toFixed(2)),
      topicScore: Number(topicScore.toFixed(2)),
      bodyScore: Number(bodyScore.toFixed(2)),
      publishedAt: item.publishAt || item.createdAt || '',
      sameCycle: sameCycle(candidate.publishAt || candidate.createdAt, item.publishAt || item.createdAt),
      score: Number(score.toFixed(2))
    });
  });
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, 5);
}

function suggestAngle(hits) {
  if (!hits.length) return '';
  if (hits[0].sameCycle) return '同一周期已有相近选题，建议换成更细的切口，例如办理顺序、银行问询点或和另一司法辖区对比。';
  return '历史内容里已有相近标题或主题，建议换痛点、换读者身份，或改成清单/对比结构。';
}

module.exports = { dice, findDuplicates, suggestAngle };
