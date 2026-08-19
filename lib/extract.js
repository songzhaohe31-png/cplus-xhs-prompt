const path = require('path');
const fs = require('fs');

function safeRequire(name) {
  try {
    return require(name);
  } catch (e) {
    return null;
  }
}

async function extractText(filePath, mime, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const kind = mime || '';
  try {
    if (ext === '.txt' || kind.includes('text/plain')) {
      return fs.readFileSync(filePath, 'utf8').slice(0, 40000);
    }
    if (ext === '.pdf' || kind.includes('pdf')) {
      const pdfParse = safeRequire('pdf-parse');
      if (!pdfParse) return '';
      const buf = fs.readFileSync(filePath);
      const out = await pdfParse(buf);
      return String(out.text || '').slice(0, 40000);
    }
    if (ext === '.docx' || kind.includes('wordprocessingml')) {
      const mammoth = safeRequire('mammoth');
      if (!mammoth) return '';
      const out = await mammoth.extractRawText({ path: filePath });
      return String(out.value || '').slice(0, 40000);
    }
    if (ext === '.xlsx' || ext === '.xls' || kind.includes('spreadsheet')) {
      const xlsx = safeRequire('xlsx');
      if (!xlsx) return '';
      const wb = xlsx.readFile(filePath);
      const parts = wb.SheetNames.slice(0, 4).map((name) => {
        const sheet = wb.Sheets[name];
        return `# ${name}\n` + xlsx.utils.sheet_to_csv(sheet);
      });
      return parts.join('\n\n').slice(0, 40000);
    }
  } catch (e) {
    return '';
  }
  return '';
}

function scoreExcerpt(text, query) {
  const q = String(query || '').toLowerCase();
  const t = String(text || '').toLowerCase();
  if (!q || !t) return 0;
  const words = q.split(/[\s,，。]+/).filter((w) => w.length > 1);
  let n = 0;
  words.forEach((w) => { if (t.includes(w)) n += 1; });
  return words.length ? n / words.length : 0;
}

function pickKnowledge(items, query, limit) {
  return (items || [])
    .map((item) => ({ item, score: scoreExcerpt((item.excerpt || '') + ' ' + (item.name || ''), query) }))
    .filter((x) => x.score > 0 || !query)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 6)
    .map((x) => x.item);
}

module.exports = { extractText, pickKnowledge };
