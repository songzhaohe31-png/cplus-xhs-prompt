const path = require('path');
const fs = require('fs');

function safeRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

function titlesFrom(text) {
  return String(text || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 4 && l.length <= 40 && !/^https?:/.test(l))
    .slice(0, 8);
}

function factsFrom(text, source, page) {
  return String(text || '')
    .split(/[。！？\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12 && /(公司|牌照|服务|注册|合规|MSO|SFC|秘书|年审|开户|信托|MSB)/i.test(s))
    .slice(0, 20)
    .map((content) => ({ content, source, page: page || '', excerpt: content.slice(0, 180) }));
}

async function extractPdf(filePath) {
  const pdfParse = safeRequire('pdf-parse');
  if (!pdfParse) return { ok: false, error: '未安装 PDF 解析库', text: '', pages: [], pageCount: 0, charCount: 0 };
  const buf = fs.readFileSync(filePath);
  const pages = [];
  let out;
  try {
    out = await pdfParse(buf, {
      pagerender(pageData) {
        return pageData.getTextContent({ normalizeWhitespace: true }).then((tc) => {
          let lastY;
          let text = '';
          (tc.items || []).forEach((item) => {
            const y = item.transform && item.transform[5];
            if (lastY != null && Math.abs(lastY - y) > 2) text += '\n';
            text += item.str || '';
            lastY = y;
          });
          pages.push({ page: pages.length + 1, text: text.trim(), charCount: text.trim().length });
          return text;
        });
      }
    });
  } catch (e) {
    out = await pdfParse(buf);
  }
  const text = pages.length ? pages.map((p) => `【第${p.page}页】\n${p.text}`).join('\n\n') : String(out.text || '');
  const charCount = text.replace(/\s/g, '').length;
  const pageCount = out.numpages || pages.length;
  const avg = pageCount ? charCount / pageCount : charCount;
  let ocrUsed = false;
  let ocrNote = '';
  let error = '';
  let ok = charCount >= 80;
  if (avg < 40 || charCount < 80) {
    ocrNote = '该文件疑似扫描件或图片页较多，可复制文字过少。';
    ok = charCount >= 80;
    if (!ok) error = '该文件为扫描件或图片型PDF，直接提取的有效文字过少。请上传可复制文字版，或把页面另存为JPG后重试。';
  }
  return {
    ok,
    text,
    charCount,
    pageCount,
    pages,
    titles: titlesFrom(pages.slice(0, 5).map((p) => p.text).join('\n') || text),
    ocrUsed,
    ocrNote,
    error,
    facts: factsFrom(text, path.basename(filePath))
  };
}

async function extractDocx(filePath) {
  const mammoth = safeRequire('mammoth');
  if (!mammoth) return { ok: false, error: '未安装 Word 解析库', text: '', charCount: 0, pageCount: 1, pages: [], titles: [] };
  const out = await mammoth.extractRawText({ path: filePath });
  const text = String(out.value || '').trim();
  const charCount = text.replace(/\s/g, '').length;
  return {
    ok: charCount >= 40,
    text,
    charCount,
    pageCount: 1,
    pages: [{ page: 1, text, charCount }],
    titles: titlesFrom(text),
    ocrUsed: false,
    ocrNote: '',
    error: charCount < 40 ? 'Word 正文过少，识别失败。' : '',
    facts: factsFrom(text, path.basename(filePath), 1)
  };
}

async function extractXls(filePath) {
  const xlsx = safeRequire('xlsx');
  if (!xlsx) return { ok: false, error: '未安装 Excel 解析库', text: '', charCount: 0, pages: [], pageCount: 0 };
  const wb = xlsx.readFile(filePath);
  const sheets = wb.SheetNames.map((name) => {
    const rows = xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
    const lines = rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c == null ? '' : c).trim()).filter(Boolean).join(' | ') : '')).filter(Boolean);
    return { name, text: lines.join('\n'), charCount: lines.join('').length };
  });
  const text = sheets.map((s) => `【工作表 ${s.name}】\n${s.text}`).join('\n\n');
  const charCount = text.replace(/\s/g, '').length;
  return {
    ok: charCount >= 20,
    text,
    charCount,
    pageCount: sheets.length,
    pages: sheets.map((s, i) => ({ page: i + 1, text: s.text, charCount: s.charCount, sheet: s.name })),
    titles: sheets.map((s) => s.name),
    ocrUsed: false,
    ocrNote: '',
    error: charCount < 20 ? 'Excel 没有可读单元格。' : '',
    facts: factsFrom(text, path.basename(filePath)),
    sheets
  };
}

async function extractImage(filePath) {
  const Tesseract = safeRequire('tesseract.js');
  if (!Tesseract) {
    return {
      ok: false,
      text: '',
      charCount: 0,
      pageCount: 1,
      pages: [],
      titles: [],
      ocrUsed: false,
      ocrNote: '图片需要OCR。当前服务未启用OCR引擎。',
      error: '图片文字识别未启用。请同时粘贴对应Caption，或上传可复制文字。',
      facts: []
    };
  }
  const worker = await Tesseract.createWorker('chi_sim+eng');
  try {
    const out = await worker.recognize(filePath);
    const text = String((out.data && out.data.text) || '').trim();
    const charCount = text.replace(/\s/g, '').length;
    return {
      ok: charCount >= 8,
      text,
      charCount,
      pageCount: 1,
      pages: [{ page: 1, text, charCount }],
      titles: titlesFrom(text),
      ocrUsed: true,
      ocrNote: '已对图片进行OCR。',
      error: charCount < 8 ? 'OCR未识别到有效文字。' : '',
      facts: factsFrom(text, path.basename(filePath), 1)
    };
  } finally {
    try { await worker.terminate(); } catch (e) {}
  }
}

async function extractDocument(filePath, mime, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase();
  const kind = mime || '';
  try {
    if (ext === '.txt' || kind.includes('text/plain')) {
      const text = fs.readFileSync(filePath, 'utf8');
      const charCount = text.replace(/\s/g, '').length;
      return {
        ok: charCount >= 8,
        text,
        charCount,
        pageCount: 1,
        pages: [{ page: 1, text, charCount }],
        titles: titlesFrom(text),
        ocrUsed: false,
        ocrNote: '',
        error: charCount < 8 ? '文本为空。' : '',
        facts: factsFrom(text, originalName || filePath, 1)
      };
    }
    if (ext === '.pdf' || kind.includes('pdf')) return extractPdf(filePath);
    if (ext === '.docx' || kind.includes('wordprocessingml') || ext === '.doc') return extractDocx(filePath);
    if (ext === '.xlsx' || ext === '.xls' || kind.includes('spreadsheet')) return extractXls(filePath);
    if (/^\.(png|jpe?g|webp|gif)$/.test(ext) || kind.startsWith('image/')) return extractImage(filePath);
    return { ok: false, error: '不支持的文件类型：' + ext, text: '', charCount: 0, pageCount: 0, pages: [], titles: [], facts: [] };
  } catch (e) {
    return { ok: false, error: '解析失败：' + (e.message || '未知错误'), text: '', charCount: 0, pageCount: 0, pages: [], titles: [], facts: [] };
  }
}

async function extractText(filePath, mime, originalName) {
  const doc = await extractDocument(filePath, mime, originalName);
  return doc.text || '';
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

module.exports = { extractText, extractDocument, pickKnowledge, factsFrom, titlesFrom };
