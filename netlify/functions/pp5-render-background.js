// pp5-render-background.js
// For each page: renders source PDF as background image, whites out original
// text regions, overlays translated text at exact bbox positions, outputs PDF.

import { createClient } from '@supabase/supabase-js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const IS_LAMBDA = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

const RENDER_DPI = 150;
const PT_PER_INCH = 72;

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

// Render all pages of a PDF to PNG buffers using pdfjs in Puppeteer
async function renderPdfPagesToImages(pdfBytes, pageCount, pageDims) {
  await initPuppeteer();
  const launchOpts = chromium
    ? { args: chromium.args, defaultViewport: chromium.defaultViewport, executablePath: await chromium.executablePath(), headless: true }
    : { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };

  const browser = await puppeteer.launch(launchOpts);
  const pageImages = {}; // pageNum → Buffer (PNG)

  try {
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      const dims = pageDims[pageNum] || { width: 8.5, height: 11 };
      const pxW = Math.round(dims.width  * RENDER_DPI);
      const pxH = Math.round(dims.height * RENDER_DPI);

      const html = `<!DOCTYPE html><html><head><style>*{margin:0;padding:0;} canvas{display:block;}</style></head>
<body><canvas id="c" width="${pxW}" height="${pxH}"></canvas>
<script type="module">
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
const data = Uint8Array.from(atob('${pdfBase64}'), c => c.charCodeAt(0));
const doc  = await pdfjsLib.getDocument({ data }).promise;
const page = await doc.getPage(${pageNum});
const vp   = page.getViewport({ scale: ${RENDER_DPI} / 72 });
const c    = document.getElementById('c');
c.width = vp.width; c.height = vp.height;
await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
window.__done = true;
</script></body></html>`;

      const tab = await browser.newPage();
      await tab.setViewport({ width: pxW, height: pxH });
      try {
        await tab.setContent(html, { waitUntil: 'networkidle0' });
        await tab.waitForFunction('window.__done === true', { timeout: 30000 });
        const pngBuf = await tab.screenshot({ type: 'png', clip: { x: 0, y: 0, width: pxW, height: pxH }, fullPage: false });
        pageImages[pageNum] = pngBuf;
        console.log(`  Rendered page ${pageNum}: ${pxW}×${pxH}px`);
      } finally {
        await tab.close();
      }
    }
  } finally {
    await browser.close();
  }
  return pageImages;
}

// Convert paragraph's inch-based x,y,w,h to normalized 0–1 bbox [x1, y1, x2, y2]
function toBbox(p) {
  const pw = p.pageW || 8.5;
  const ph = p.pageH || 11;
  return [p.x / pw, p.y / ph, (p.x + p.w) / pw, (p.y + p.h) / ph];
}

// Parse hex color string to rgb(r, g, b) values for pdf-lib
function hexToRgb(hex) {
  if (!hex || hex.length < 7) return { r: 0.118, g: 0.118, b: 0.118 }; // default #1e1e1e
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { r, g, b };
}

// Character-count-based word wrap (no maxWidth needed in drawText)
function wrapText(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxCharsPerLine) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const BODY_FONT_SIZE = 10.5;

export async function renderOverlayPdf(pdfBytes, translatedParagraphs, pageCount, pageDims) {
  // Step 1: Render all source pages to images
  console.log(`pp5-render: rendering ${pageCount} pages to images...`);
  const pageImages = await renderPdfPagesToImages(pdfBytes, pageCount, pageDims);

  // Step 2: Build output PDF with Unicode-capable fonts
  const outDoc = await PDFDocument.create();
  outDoc.registerFontkit(fontkit);

  // Embed LiberationSans (metric-compatible with Helvetica, supports full Unicode)
  const fontsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/pdfjs-dist/standard_fonts');
  const regularFontBytes = readFileSync(resolve(fontsDir, 'LiberationSans-Regular.ttf'));
  const boldFontBytes    = readFileSync(resolve(fontsDir, 'LiberationSans-Bold.ttf'));
  const regularFont = await outDoc.embedFont(regularFontBytes, { subset: true });
  const boldFont    = await outDoc.embedFont(boldFontBytes, { subset: true });

  // Create all pages: embed raster background image (source PDF rendered via Puppeteer).
  // Per-paragraph white rectangles are drawn later to cover only source text regions.
  const pages = [];
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const dims = pageDims[pageNum] || { width: 8.5, height: 11 };
    const pageWidth  = dims.width  * PT_PER_INCH;
    const pageHeight = dims.height * PT_PER_INCH;
    const page = outDoc.addPage([pageWidth, pageHeight]);
    const imgBuf = pageImages[pageNum];
    if (imgBuf) {
      const pngImage = await outDoc.embedPng(imgBuf);
      page.drawImage(pngImage, { x: 0, y: 0, width: pageWidth, height: pageHeight });
    }
    pages.push(page);
  }

  // Normalize each paragraph into { pageNum, bbox, translatedText, bold, role }
  const sorted = translatedParagraphs
    .filter(p => p.translatedText?.trim())
    .map(p => ({
      pageNum: p.pageNum,
      bbox: toBbox(p),
      translatedText: p.translatedText.trim(),
      bold: !!p.bold,
      role: p.role || 'body',
      fontSize: p.fontSize || null,
      textColor: p.textColor || null,
      bgColor: p.bgColor || null,
    }))
    .sort((a, b) => {
      if (a.pageNum !== b.pageNum) return a.pageNum - b.pageNum;
      return a.bbox[1] - b.bbox[1]; // top-to-bottom
    });

  // Log first 3 for debugging
  for (let i = 0; i < Math.min(3, sorted.length); i++) {
    const s = sorted[i];
    console.log(`  para[${i}]: bbox=[${s.bbox.map(v => v.toFixed(4)).join(', ')}] text="${s.translatedText.slice(0, 55)}"`);
  }

  // Merge consecutive salutation lines ("Madame," + "Monsieur," etc.)
  const SALUTATIONS = ['madame', 'monsieur', 'madame,', 'monsieur,'];
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i].translatedText.trim();
    const b = sorted[i + 1].translatedText.trim();
    if (SALUTATIONS.includes(a.toLowerCase()) && SALUTATIONS.includes(b.toLowerCase())) {
      sorted[i].translatedText = a.replace(/,?$/, ',') + ' ' + b;
      sorted.splice(i + 1, 1);
      console.log(`  Merged salutation → "${sorted[i].translatedText}"`);
    }
  }

  // Track which pages have content
  const pagesWithContent = new Set();

  // ── Column detection ──────────────────────────────────────────────────────
  // Group paragraphs by page, detect if multi-column, find adaptive split point
  function detectColumns(pageParagraphs) {
    // Find the LARGEST gap between X position clusters (not just the first gap > 0.15)
    const xPositions = pageParagraphs.map(p => p.bbox[0]);
    const sortedX = [...new Set(xPositions.map(v => Math.round(v * 100) / 100))].sort((a, b) => a - b);
    let maxGap = 0;
    let splitPoint = 0.6; // default fallback
    for (let i = 1; i < sortedX.length; i++) {
      const gap = sortedX[i] - sortedX[i - 1];
      if (gap > maxGap) {
        maxGap = gap;
        // Place split just before the right cluster starts (not at midpoint)
        splitPoint = sortedX[i] - 0.02;
      }
    }
    // Only use detected split if the gap is significant (> 0.1)
    if (maxGap < 0.1) splitPoint = 1.0; // treat as single column
    const leftCol  = pageParagraphs.filter(p => p.bbox[0] < splitPoint);
    const rightCol = pageParagraphs.filter(p => p.bbox[0] >= splitPoint);
    const isMultiCol = leftCol.length > 2 && rightCol.length > 2;
    return { isMultiCol, leftCol, rightCol, splitPoint };
  }

  const byPage = {};
  for (const p of sorted) {
    if (!byPage[p.pageNum]) byPage[p.pageNum] = [];
    byPage[p.pageNum].push(p);
  }

  // ── Render a list of paragraphs within a single column ────────────────────
  // splitPoint: normalized X threshold between left/right columns (0–1)
  // colSide: 'left', 'right', or 'full' (single-column page)
  function renderColumn(columnParas, page, pageWidth, pageHeight, splitPoint, colSide, mainColWrapWidth) {
    let lastBottomY = -Infinity;

    for (const para of columnParas) {
      const bbox    = para.bbox;
      const x       = bbox[0] * pageWidth;
      const bboxW   = (bbox[2] - bbox[0]) * pageWidth;
      const bboxTopY = pageHeight - (bbox[1] * pageHeight);

      // Strip index tags and fix bullet characters
      let content = (para.translatedText || '').trim();
      content = content.replace(/^\[\d+\]\s*/g, '');
      content = content.replace(/^·\s*/g, '• ');

      // Font sizes matched to original CV
      const isHeading = para.role === 'sectionHeading';
      const isWide = bboxW > pageWidth * 0.5;
      const isRightSidebar = colSide === 'right';
      let fontSize = isHeading ? 8.5
                   : isWide    ? 8.5
                   :             7.5;
      let lineH = fontSize * 1.15;
      const renderFont = (isHeading || para.bold) ? boldFont : regularFont;

      // Text color: navy for body/headings, lighter gray for sidebar body
      const navyColor = rgb(0.102, 0.165, 0.29); // #1a2a4a
      const sidebarBodyColor = rgb(0.333, 0.333, 0.333); // #555555
      let textColor;
      if (isRightSidebar && !isHeading && !para.bold) {
        textColor = sidebarBodyColor;
      } else {
        textColor = navyColor;
      }

      // Classify
      const isSender  = bbox[0] > 0.5 && bbox[1] < 0.25;
      const isSubject = /^(objet\s*:|re\s*:|subject\s*:)/i.test(content);
      const isSalut   = /^madame|^monsieur/i.test(content);

      // Wrap: main column uses full column width, sidebar uses bbox width
      const wrapWidth = isRightSidebar ? bboxW : mainColWrapWidth;
      let maxChars = (isSubject || isSalut) ? 999
                   : isSender               ? 30
                   : Math.floor(wrapWidth / (fontSize * 0.52));
      let lines = wrapText(content, maxChars);

      // Source bbox height and rendered text height
      const bboxBotY = pageHeight - (bbox[3] * pageHeight);
      const bboxH    = bboxTopY - bboxBotY;
      const textH    = lines.length * lineH + 4;

      // Anchor: start at source bbox top, but never overlap previous block
      const naturalTop = bboxTopY;
      const minTop     = lastBottomY === -Infinity ? naturalTop : lastBottomY - 4;
      const anchorTop  = Math.min(naturalTop, minTop);

      // Skip header paragraphs — preserve original background header
      const isHeader = para.role === 'title' ||
        (bbox[1] < 0.12 && para.pageNum === 1);
      if (isHeader) continue;

      // Page margins
      const bottomMargin = 40;
      const minY = bottomMargin;

      // Skip orphaned headings in the bottom 15% of the page
      if (isHeading && anchorTop < pageHeight * 0.15 + minY) {
        continue;
      }

      // Page overflow detection: shrink font if text would exceed bottom margin
      const textBottom = anchorTop - fontSize - (lines.length * lineH);
      if (textBottom < minY) {
        const availableHeight = anchorTop - fontSize - minY;
        const neededHeight = lines.length * lineH;
        if (availableHeight > 0 && neededHeight > 0) {
          const scaleFactor = Math.max(availableHeight / neededHeight, 0.7);
          fontSize = fontSize * scaleFactor;
          lineH = fontSize * 1.15;
          maxChars = Math.floor(wrapWidth / (fontSize * 0.52));
          lines = wrapText(content, maxChars);
        }
      }

      // White-out rectangle: tight fit with minimal padding
      const sidebarPadding = isRightSidebar ? lineH * 0.5 : lineH * 0.5;
      const rectH = Math.max(bboxH * 1.1, textH) + sidebarPadding;
      let rectX, rectWidth;
      if (colSide === 'right') {
        rectX = splitPoint * pageWidth - 2;
        rectWidth = pageWidth - rectX + 2;
      } else if (colSide === 'left') {
        rectX = Math.max(0, x - 4);
        rectWidth = mainColWrapWidth + 10;
      } else {
        rectX = x - 2;
        rectWidth = bboxW + 4;
      }
      if (isHeading) {
        const extraTop = lineH * 1.5;
        page.drawRectangle({
          x:      rectX - 2,
          y:      anchorTop - rectH - extraTop,
          width:  rectWidth + 4,
          height: rectH + extraTop,
          color:  rgb(1, 1, 1),
        });
      } else {
        page.drawRectangle({
          x:      rectX,
          y:      anchorTop - rectH,
          width:  rectWidth,
          height: rectH,
          color:  rgb(1, 1, 1),
        });
      }

      // Draw text top-to-bottom from anchorTop
      let drawY = anchorTop - fontSize;

      // Sign-off name+title split
      const titleRx = /\b(Directeur|Director|CEO|PDG|Manager|Général|General|Chief|Officer|President|Président)\b/;
      const titleMatch = content.search(titleRx);
      const isSignerName = titleMatch > 0 &&
        bboxTopY < pageHeight * 0.5 &&
        bboxW <= pageWidth * 0.5;

      if (isSignerName) {
        const namePart  = content.slice(0, titleMatch).trim();
        const titlePart = content.slice(titleMatch).trim();
        page.drawText(namePart,  { x, y: drawY, size: fontSize, font: boldFont,    color: textColor });
        drawY -= lineH;
        page.drawText(titlePart, { x, y: drawY, size: fontSize, font: regularFont, color: textColor });
        drawY -= lineH;
      } else {
        for (const line of lines) {
          page.drawText(line, { x, y: drawY, size: fontSize, font: renderFont, color: textColor });
          drawY -= lineH;
        }
      }

      // Track bottom of this block
      lastBottomY = drawY + lineH - (fontSize * 0.8);
    }
  }

  // ── Per-page render ───────────────────────────────────────────────────────
  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const pageIndex = pageNum - 1;
    const page = pages[pageIndex];
    if (!page) continue;
    const { width: pageWidth, height: pageHeight } = page.getSize();
    const pageParagraphs = byPage[pageNum] || [];
    if (pageParagraphs.length === 0) continue;

    // Detect columns
    const { isMultiCol, leftCol, rightCol, splitPoint } = detectColumns(pageParagraphs);

    // Compute main column wrap width: from leftmost paragraph X to split boundary
    const mainParas = pageParagraphs.filter(p => p.bbox[0] < splitPoint);
    const leftMargin = mainParas.length > 0
      ? Math.min(...mainParas.map(p => p.bbox[0])) * pageWidth
      : 0;
    const mainColWrapWidth = splitPoint * pageWidth - leftMargin - 10; // 10pt right padding

    if (isMultiCol) {
      console.log(`  page ${pageNum}: multi-column (left=${leftCol.length}, right=${rightCol.length}, split=${splitPoint.toFixed(2)}, mainWrap=${mainColWrapWidth.toFixed(0)}pt)`);
      // Sort each column independently by Y position (top-to-bottom)
      leftCol.sort((a, b) => a.bbox[1] - b.bbox[1]);
      rightCol.sort((a, b) => a.bbox[1] - b.bbox[1]);
      // Render left column, then right column — each with independent lastBottomY
      renderColumn(leftCol, page, pageWidth, pageHeight, splitPoint, 'left', mainColWrapWidth);
      renderColumn(rightCol, page, pageWidth, pageHeight, splitPoint, 'right', mainColWrapWidth);
    } else {
      // Single column: render all paragraphs in Y order
      pageParagraphs.sort((a, b) => a.bbox[1] - b.bbox[1]);
      renderColumn(pageParagraphs, page, pageWidth, pageHeight, 0.58, 'full', mainColWrapWidth);
    }

    pagesWithContent.add(pageNum);
  }

  // Remove trailing blank page if it has no drawn text content
  const totalPages = outDoc.getPageCount();
  if (totalPages > 1 && !pagesWithContent.has(totalPages)) {
    console.log(`pp5-render: removing blank trailing page ${totalPages}`);
    outDoc.removePage(totalPages - 1);
  }

  return await outDoc.save();
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { jobId } = body;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const { data: job } = await supabase.from('translation_jobs')
      .select('source_path, source_filename, target_lang, metadata').eq('id', jobId).single();

    // Download source PDF
    const { data: pdfBlob } = await supabase.storage.from('translation-jobs').download(job.source_path);
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

    // Download translated paragraphs
    const { data: tBlob } = await supabase.storage
      .from('translation-jobs').download(job.metadata.pp5_translated_path);
    const { translated, pageCount, pageDims } = JSON.parse(await tBlob.text());

    console.log(`pp5-render [${jobId}]: ${translated.length} paragraphs, ${pageCount} pages`);
    const pdfOut = await renderOverlayPdf(pdfBytes, translated, pageCount, pageDims);

    const pdfPath = `pp5-final/${jobId}/translated.pdf`;
    await supabase.storage.from('translation-jobs')
      .upload(pdfPath, pdfOut, { contentType: 'application/pdf', upsert: true });

    await supabase.from('translation_jobs').update({
      status: 'completed',
      result_pdf_path: pdfPath,
      completed_at: new Date().toISOString(),
      metadata: { ...job.metadata, pipeline: 'pp5' },
    }).eq('id', jobId);

    console.log(`pp5-render [${jobId}]: done, ${pdfOut.length} bytes`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, pdfPath, pdfBytes: pdfOut.length }) };
  } catch (err) {
    console.error('pp5-render failed:', err);
    await supabase.from('translation_jobs').update({
      status: 'failed', error_message: err.message.slice(0, 500), completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    return { statusCode: 500, body: err.message };
  }
}
