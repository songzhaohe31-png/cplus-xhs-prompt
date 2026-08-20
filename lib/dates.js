const TZ = 'Asia/Hong_Kong';

function hongKongDate(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d || new Date());
}

function padIso(y, m, d) {
  return String(y) + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function addDaysIso(iso, days) {
  const parts = String(iso || '').split('-').map(Number);
  if (parts.length < 3 || !parts[0]) return iso;
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return padIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function toIsoDate(value, minIso) {
  const s = String(value || '').trim();
  if (!s) return '';
  let m = s.match(/(20\d{2})[./-](\d{1,2})[./-](\d{1,2})/);
  if (m) return padIso(m[1], m[2], m[3]);
  m = s.match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})/);
  if (m) return padIso(m[1], m[2], m[3]);
  return '';
}

function formatDateZh(iso) {
  const m = String(iso || '').match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return iso || '';
  return m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日';
}

function planFromMessage(message, today) {
  const t = String(message || '');
  const perWeek = 3;
  if (/下个月|下月/.test(t) && !/未来4周|四周/.test(t)) {
    const [y, m] = today.split('-').map(Number);
    const nextM = m === 12 ? 1 : m + 1;
    const nextY = m === 12 ? y + 1 : y;
    return { weeks: 4, perWeek, start: padIso(nextY, nextM, 1), kind: 'month' };
  }
  if (/下周/.test(t) && !/未来4周|四周|4周/.test(t)) {
    return { weeks: 1, perWeek, start: addDaysIso(today, 7), kind: 'week' };
  }
  if (/本周|这周/.test(t) && !/未来4周|四周|4周/.test(t)) {
    return { weeks: 1, perWeek, start: today, kind: 'week' };
  }
  return { weeks: 4, perWeek, start: today, kind: 'month' };
}

function buildScheduleSlots(plan) {
  const weeks = plan.weeks || 4;
  const perWeek = plan.perWeek || 3;
  const start = plan.start;
  const slots = [];
  for (let w = 0; w < weeks; w++) {
    for (let n = 0; n < perWeek; n++) {
      slots.push({
        week: '第' + (w + 1) + '周',
        publishAt: addDaysIso(start, w * 7 + n * 2),
        index: slots.length
      });
    }
  }
  return slots;
}

function coercePublishAt(value, fallback, minIso) {
  const iso = toIsoDate(value);
  if (!iso) return fallback;
  if (minIso && iso < minIso) return fallback;
  if (minIso && minIso.slice(0, 4) >= '2026' && iso.slice(0, 4) < '2026') return fallback;
  return iso;
}

function applyScheduleDates(items, slots, minIso) {
  const list = Array.isArray(items) ? items.slice() : [];
  return slots.map((slot, i) => {
    const src = list[i] || {};
    return {
      week: slot.week,
      publishAt: slot.publishAt,
      title: src.title || src.topic || '',
      contentType: src.contentType || src.type || '',
      type: src.contentType || src.type || '',
      audience: src.audience || '',
      pain: src.pain || '',
      purpose: src.purpose || '',
      offer: src.offer || '',
      subtitle: src.subtitle || '',
      body: src.body || '',
      cta: src.cta || '',
      hashtags: src.hashtags || '',
      status: 'Draft'
    };
  });
}

function isDateQuestion(message) {
  const t = String(message || '');
  if (/排期|年审|小红书|写一篇|生成一篇|内容排期|MSO|开户/.test(t)) return false;
  return /今天|当前|现在/.test(t) && /日期|几号|星期|周几/.test(t);
}

module.exports = {
  TZ,
  hongKongDate,
  addDaysIso,
  toIsoDate,
  formatDateZh,
  planFromMessage,
  buildScheduleSlots,
  coercePublishAt,
  applyScheduleDates,
  isDateQuestion
};
