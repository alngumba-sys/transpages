// pp6-render.js
// Reconstructs translated document as HTML, renders to PDF via Puppeteer.
// Per-page scaling: each source page is rendered independently and scaled
// to fit exactly one output page. Pages are merged with pdf-lib.

import { PDFDocument } from 'pdf-lib';

const IS_LAMBDA = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

let puppeteer, chromium;
async function initPuppeteer() {
  if (puppeteer) return;
  if (IS_LAMBDA) {
    puppeteer = (await import('puppeteer-core')).default;
    chromium  = (await import('@sparticuz/chromium')).default;
  } else {
    puppeteer = (await import('puppeteer')).default;
    chromium  = null;
  }
}

// ── Color constants (Azure-detected) ────────────────────────────────────────

const COLORS = {
  headerBg:         '#1a2a4a',
  headerName:       '#ffffff',
  headerSubtitle:   '#cdbd8d',
  headerContact:    '#9599a1',
  sectionLabel:     '#9a8060',
  sectionUnderline: '#cdbd8d',
  jobTitle:         '#253551',
  jobMeta:          '#616161',
  bodyText:         '#454545',
  profileText:      '#656565',
  sidebarText:      '#656565',
  sidebarHeading:   '#9a8060',
  competencyText:   '#253551',
  sidebarBg:        '#f5f5f5',
  gridBorder:       '#b0b0b0',
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Paragraph classification ────────────────────────────────────────────────

const SECTION_LABEL_LIST = [
  'PROFIL PROFESSIONNEL', 'PROFESSIONAL PROFILE',
  'COMPÉTENCES CLÉS', 'KEY COMPETENCIES',
  'EXPÉRIENCE PROFESSIONNELLE', 'PROFESSIONAL EXPERIENCE',
  'EXPÉRIENCE PROFESSIONNELLE (SUITE)', 'PROFESSIONAL EXPERIENCE (CONTINUED)',
  'PROFESSIONAL EXPERIENCE (SUITE)',
  'ÉDUCATION ET FORMATION', 'EDUCATION & TRAINING', 'EDUCATION AND TRAINING',
  'FORMATION ET QUALIFICATIONS',
  'LANGUES', 'LANGUAGES',
  'POINTS FORTS PERSONNELS', 'PERSONAL STRENGTHS', 'FORCES PERSONNELLES',
  'INTÉRÊTS', 'INTERESTS', 'CENTRES D\'INTÉRÊT',
  'POURQUOI JE SUIS', 'WHY I AM',
  'COMPÉTENCES PRÊTES POUR', 'HOSPITALITY-READY', 'COMPÉTENCES EN HÔTELLERIE',
  'COMPÉTENCES TECHNIQUES', 'TECHNICAL SKILLS',
  'RÉFÉRENCES', 'REFERENCES',
];

const DATE_PATTERN = /\b(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

function classifyParagraph(para) {
  const text = (para.translatedText || '').trim();
  const isSectionLabel = SECTION_LABEL_LIST.some(s =>
    text.toUpperCase().startsWith(s.toUpperCase())
  );
  if (para.role === 'sectionHeading' && isSectionLabel) return 'section-label';
  if (para.role === 'sectionHeading' && !isSectionLabel) return 'job-title';
  if (DATE_PATTERN.test(text) && !text.startsWith('•') && !text.startsWith('·') && text.length < 120) return 'job-meta';
  if (text.startsWith('•') || text.startsWith('·') || text.startsWith('-')) return 'bullet';
  return 'body-text';
}

// ── Header HTML (page 1) ───────────────────────────────────────────────────

function buildHeaderHTML(allParas) {
  const headerParas = allParas.filter(p =>
    p.role === 'title' || (p.pageNum === 1 && (p.y / p.pageH) < 0.12));
  if (!headerParas.length) return '';

  const titlePara = headerParas.find(p => p.role === 'title');
  const contactPara = headerParas.find(p => p.role !== 'title');

  let nameText = '', subtitleText = '';
  if (titlePara) {
    const text = titlePara.translatedText || titlePara.text || '';
    const words = text.split(/\s+/);
    const nameWords = [], subtitleWords = [];
    let pastName = false;
    for (const w of words) {
      if (!pastName && w === w.toUpperCase() && /[A-Z]/.test(w)) nameWords.push(w);
      else { pastName = true; subtitleWords.push(w); }
    }
    nameText = nameWords.join(' ') || text;
    subtitleText = subtitleWords.join(' ');
  }

  const contactText = contactPara
    ? escapeHtml(contactPara.translatedText || contactPara.text || '') : '';

  return `
    <div class="header">
      <div class="header-name">${escapeHtml(nameText)}</div>
      ${subtitleText ? `<div class="header-subtitle">${escapeHtml(subtitleText)}</div>` : ''}
      ${contactText ? `<div class="header-contact">${contactText}</div>` : ''}
    </div>`;
}

// Continuation header for page 2+
function buildContinuationHeader(allParas) {
  const titlePara = allParas.find(p => p.role === 'title');
  let nameText = '';
  if (titlePara) {
    const text = titlePara.translatedText || titlePara.text || '';
    nameText = text.split(/\s+/).filter(w => w === w.toUpperCase() && /[A-Z]/.test(w)).join(' ')
      || text.split(/\s+/).slice(0, 3).join(' ');
  }
  return `
    <div class="header-cont">
      <span class="header-cont-name">${escapeHtml(nameText)}</span>
      <span class="header-cont-sep"> &mdash; </span>
      <span class="header-cont-label">Suite</span>
    </div>`;
}

// ── Main column HTML ────────────────────────────────────────────────────────

function buildMainColHTML(paragraphs, fonts, tables = []) {
  if (!paragraphs.length) return '';
  let html = '';
  let sectionCount = 0;

  const keyCompIdx = paragraphs.findIndex(p => {
    const t = (p.translatedText || '').toUpperCase();
    return t.includes('COMPÉTENCES CLÉS') || t.includes('KEY COMPETENCIES');
  });

  let compGridHtml = '';
  if (tables.length > 0) {
    const table = tables[0];
    const cols = table.columnCount || 3;
    compGridHtml += `<div class="comp-grid" style="grid-template-columns: repeat(${cols}, 1fr)">`;
    for (const cell of table.cells) {
      const text = cell.translatedText || cell.content || '';
      compGridHtml += `<div class="comp-cell">${escapeHtml(text)}</div>`;
    }
    compGridHtml += '</div>';
  }

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    let text = (para.translatedText || '').trim()
      .replace(/^\[\d+\]\s*/, '');
    const cls = classifyParagraph(para);
    para._class = cls;

    if (i === keyCompIdx && compGridHtml) {
      html += `<div class="section-label">${escapeHtml(text)}</div>`;
      html += compGridHtml;
      sectionCount++;
      continue;
    }

    switch (cls) {
      case 'section-label':
        html += `<div class="section-label">${escapeHtml(text)}</div>`;
        sectionCount++;
        break;
      case 'job-title':
        html += `<div class="job-title">${escapeHtml(text)}</div>`;
        break;
      case 'job-meta':
        html += `<div class="job-meta">${escapeHtml(text)}</div>`;
        break;
      case 'bullet': {
        // Ensure bullet character is present
        const bulletText = text.startsWith('•') ? text
          : '• ' + text.replace(/^[·\-\*]\s*/, '');
        html += `<div class="bullet">${escapeHtml(bulletText)}</div>`;
        break;
      }
      default:
        html += `<div class="body-text">${escapeHtml(text)}</div>`;
    }
  }

  console.log(`pp6-render: main col rendered ${paragraphs.length} paras, ${sectionCount} section headings`);
  return html;
}

// ── Sidebar column HTML ─────────────────────────────────────────────────────

function buildSideColHTML(paragraphs, fonts) {
  if (!paragraphs.length) return '';
  let html = '';
  let sectionCount = 0;

  for (const para of paragraphs) {
    let text = (para.translatedText || '').trim()
      .replace(/^\[\d+\]\s*/, '');

    if (para.role === 'sectionHeading') {
      html += `<div class="side-label">${escapeHtml(text)}</div>`;
      sectionCount++;
    } else if (text.startsWith('•') || text.startsWith('·') || text.startsWith('-')) {
      const bulletText = text.startsWith('•') ? text
        : '• ' + text.replace(/^[·\-\*]\s*/, '');
      html += `<div class="side-bullet">${escapeHtml(bulletText)}</div>`;
    } else if (para.bold) {
      html += `<div class="side-entry-bold">${escapeHtml(text)}</div>`;
    } else if (para.italic || DATE_PATTERN.test(text)) {
      html += `<div class="side-entry-italic">${escapeHtml(text)}</div>`;
    } else {
      html += `<div class="side-entry">${escapeHtml(text)}</div>`;
    }
  }

  console.log(`pp6-render: sidebar rendered ${paragraphs.length} paras, ${sectionCount} section headings`);
  return html;
}

// ── Build HTML for a single page ────────────────────────────────────────────

function buildPageHTML(pageParas, fonts, pageNum, pageCount, allParas, tables) {
  const isPage1 = pageNum === 1;
  // Only filter header on page 1; be strict: only title role and y < 0.10
  const headerParas = isPage1
    ? pageParas.filter(p => p.role === 'title' || (p.role !== 'sectionHeading' && (p.y / p.pageH) < 0.10))
    : [];
  const contentParas = pageParas.filter(p => !headerParas.includes(p));

  const leftParas = contentParas.filter(p => p.columnIndex === 0).sort((a, b) => a.y - b.y);
  const rightParas = contentParas.filter(p => p.columnIndex === 1).sort((a, b) => a.y - b.y);
  const pageTables = isPage1 ? tables : [];

  const f = fonts;
  const C = COLORS;

  const headerHtml = isPage1
    ? buildHeaderHTML(allParas)
    : buildContinuationHeader(allParas);

  // Extract name for footer
  const titlePara = allParas.find(p => p.role === 'title');
  const footerName = titlePara
    ? (titlePara.translatedText || titlePara.text || '').split(/\s+/)
        .filter(w => w === w.toUpperCase() && /[A-Z]/.test(w)).join(' ')
    : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: 794px 1122px; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    font-family: Arial, Helvetica, sans-serif;
    width: 794px;
    color: ${C.bodyText};
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Header (page 1) */
  .header {
    background-color: ${C.headerBg} !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    padding: 14px 42px 10px 42px;
  }
  .header-name {
    font-size: ${f.headerName}pt;
    font-weight: 900;
    color: ${C.headerName};
    text-transform: uppercase;
    letter-spacing: 0.5px;
    line-height: 1.0;
  }
  .header-subtitle {
    font-size: ${f.headerSubtitle}pt;
    color: ${C.headerSubtitle};
    margin-top: 2px;
  }
  .header-contact {
    font-size: ${f.headerContact}pt;
    color: ${C.headerContact};
    margin-top: 4px;
  }

  /* Continuation header (page 2+) */
  .header-cont {
    background-color: ${C.headerBg} !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    padding: 8px 42px;
    color: ${C.headerName};
    font-size: ${f.headerContact}pt;
  }
  .header-cont-name { font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; }
  .header-cont-sep { color: ${C.headerSubtitle}; }
  .header-cont-label { color: ${C.headerContact}; font-style: italic; }

  /* Two-column layout */
  .columns {
    display: grid;
    grid-template-columns: 1fr 25%;
    width: 794px;
    padding: 0 42px;
    column-gap: 18px;
  }
  .main-col {
    grid-column: 1;
    padding: 8px 14px 8px 0;
    font-size: ${f.body}pt;
    line-height: 1.15;
    color: ${C.bodyText};
    border-right: 0.5px solid #d0d0d0;
    overflow: hidden;
  }
  .side-col {
    grid-column: 2;
    padding: 8px 0 8px 10px;
    font-size: ${f.sidebar}pt;
    line-height: 1.1;
    color: ${C.sidebarText};
    background-color: ${C.sidebarBg} !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    overflow: hidden;
  }

  /* Section labels */
  .section-label {
    font-size: ${f.sectionLabel}pt;
    font-weight: bold;
    color: ${C.sectionLabel};
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border-bottom: 0.8px solid ${C.sectionUnderline};
    padding-bottom: 1px;
    margin-top: 7px;
    margin-bottom: 3px;
  }
  .section-label:first-child { margin-top: 3px; }

  /* Job entries */
  .job-title {
    font-size: ${f.jobTitle}pt;
    font-weight: bold;
    color: ${C.jobTitle};
    margin-top: 4px;
    margin-bottom: 0px;
  }
  .job-meta {
    font-size: ${f.jobMeta}pt;
    font-style: italic;
    color: ${C.jobMeta};
    margin-bottom: 2px;
  }

  /* Body text and bullets */
  .body-text {
    font-size: ${f.body}pt;
    color: ${C.bodyText};
    margin-bottom: 1.5px;
    line-height: 1.15;
  }
  .bullet {
    font-size: ${f.body}pt;
    color: ${C.bodyText};
    padding-left: 10px;
    text-indent: -10px;
    margin-bottom: 1px;
    line-height: 1.15;
  }

  /* Competencies grid */
  .comp-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border: 0.5px solid ${C.gridBorder};
    margin: 4px 0 8px;
    width: 100%;
  }
  .comp-cell {
    font-size: ${f.competencyCell}pt;
    padding: 2px 4px;
    border: 0.5px solid ${C.gridBorder};
    color: ${C.competencyText};
    line-height: 1.2;
  }

  /* Sidebar */
  .side-label {
    font-size: ${f.sectionLabel}pt;
    font-weight: bold;
    color: ${C.sidebarHeading};
    text-transform: uppercase;
    letter-spacing: 0.8px;
    border-bottom: 0.8px solid ${C.sectionUnderline};
    padding-bottom: 1px;
    margin-top: 7px;
    margin-bottom: 3px;
  }
  .side-label:first-child { margin-top: 3px; }
  .side-entry-bold {
    font-size: ${f.sidebar}pt;
    font-weight: bold;
    color: ${C.jobTitle};
    margin-top: 3px;
    margin-bottom: 0px;
  }
  .side-entry-italic {
    font-size: ${f.sidebar}pt;
    font-style: italic;
    color: #888;
    margin-bottom: 1px;
  }
  .side-entry {
    font-size: ${f.sidebar}pt;
    color: ${C.sidebarText};
    margin-bottom: 1px;
    line-height: 1.1;
  }
  .side-bullet {
    font-size: ${f.sidebar}pt;
    color: ${C.sidebarText};
    padding-left: 8px;
    text-indent: -8px;
    margin-bottom: 1px;
    line-height: 1.1;
  }

  /* Footer — fixed at page bottom */
  .footer {
    position: fixed;
    bottom: 8px;
    left: 0;
    right: 0;
    text-align: center;
    font-size: ${f.footer}pt;
    color: #aaaaaa;
    border-top: 0.5px solid #e0e0e0;
    padding-top: 4px;
  }
</style>
</head>
<body>
  ${headerHtml}
  <div class="columns">
    <div class="main-col">${buildMainColHTML(leftParas, fonts, pageTables)}</div>
    <div class="side-col">${buildSideColHTML(rightParas, fonts)}</div>
  </div>
  <div class="footer">${escapeHtml(footerName)} &middot; Curriculum Vitae &middot; Page ${pageNum} of ${pageCount}</div>
</body>
</html>`;
}

// ── Font scaling ────────────────────────────────────────────────────────────

const BASE_FONTS = {
  body: 7.5,
  sidebar: 6.8,
  sectionLabel: 6.0,
  jobTitle: 7.8,
  jobMeta: 7.0,
  competencyCell: 6.5,
  headerName: 19,
  headerSubtitle: 8.0,
  headerContact: 7.0,
  footer: 6.0,
};

function scaleFonts(base, scale) {
  return Object.fromEntries(
    Object.entries(base).map(([k, v]) => [k, +(v * scale).toFixed(2)])
  );
}

// ── Per-page auto-scaling render ────────────────────────────────────────────

const PAGE_HEIGHT_PX = 1122;

export async function renderHtmlPdf(translatedParagraphs, pageCount, tables = []) {
  await initPuppeteer();

  const launchOpts = chromium
    ? { args: chromium.args, defaultViewport: chromium.defaultViewport, executablePath: await chromium.executablePath(), headless: true }
    : { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };

  const browser = await puppeteer.launch(launchOpts);

  const pageGroups = [];
  for (let p = 1; p <= pageCount; p++) {
    pageGroups.push(translatedParagraphs.filter(para => para.pageNum === p));
  }

  const pageBuffers = [];

  try {
    for (let pageIdx = 0; pageIdx < pageGroups.length; pageIdx++) {
      const pageParas = pageGroups[pageIdx];
      const pageNum = pageIdx + 1;

      let scale = 1.0;
      const MIN_SCALE = 0.60;
      const SCALE_STEP = 0.02;
      let pageBuffer = null;

      while (scale >= MIN_SCALE) {
        const fonts = scaleFonts(BASE_FONTS, scale);
        const html = buildPageHTML(pageParas, fonts, pageNum, pageCount, translatedParagraphs, tables);

        const tab = await browser.newPage();
        await tab.setContent(html, { waitUntil: 'networkidle0' });

        const contentHeight = await tab.evaluate(() =>
          Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
        );

        if (contentHeight <= PAGE_HEIGHT_PX) {
          pageBuffer = await tab.pdf({
            width: '794px',
            height: '1122px',
            printBackground: true,
            pageRanges: '1',
            margin: { top: '0', right: '0', bottom: '0', left: '0' },
          });
          await tab.close();
          console.log(`pp6: page ${pageNum}/${pageCount} fits at scale=${scale.toFixed(2)}, height=${contentHeight}px`);
          break;
        }

        await tab.close();
        scale -= SCALE_STEP;
      }

      if (!pageBuffer) {
        const fonts = scaleFonts(BASE_FONTS, MIN_SCALE);
        const html = buildPageHTML(pageParas, fonts, pageNum, pageCount, translatedParagraphs, tables);
        const tab = await browser.newPage();
        await tab.setContent(html, { waitUntil: 'networkidle0' });
        pageBuffer = await tab.pdf({
          width: '794px',
          height: '1122px',
          printBackground: true,
          pageRanges: '1',
          margin: { top: '0', right: '0', bottom: '0', left: '0' },
        });
        await tab.close();
        console.warn(`pp6: page ${pageNum} at MIN_SCALE ${MIN_SCALE}`);
      }

      pageBuffers.push(pageBuffer);
    }
  } finally {
    await browser.close();
  }

  const finalDoc = await PDFDocument.create();
  for (const buf of pageBuffers) {
    const srcDoc = await PDFDocument.load(buf);
    const [firstPage] = await finalDoc.copyPages(srcDoc, [0]);
    finalDoc.addPage(firstPage);
  }

  return Buffer.from(await finalDoc.save());
}

function buildHTML(paragraphs, fonts, tables = []) {
  return buildPageHTML(paragraphs, fonts, 1, 1, paragraphs, tables);
}

export { buildHTML, buildPageHTML, scaleFonts, BASE_FONTS };
