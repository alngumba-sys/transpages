// pp4-extract-md-background.js
// Calls Azure Document Intelligence (prebuilt-layout) to extract structured content.
// Builds markdown from paragraphs + styles + tables, preserving bold/italic/underline,
// dropping page headers/footers, and replacing handwritten signatures with [signed].

import { createClient } from '@supabase/supabase-js';
import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from '@azure-rest/ai-document-intelligence';
import { extractFigureImages } from './pp4-figure-extractor.js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AZURE_ENDPOINT       = process.env.AZURE_DOC_INTEL_ENDPOINT;
const AZURE_KEY            = process.env.AZURE_DOC_INTEL_KEY;

// Roles we drop entirely (page furniture, not content)
const DROP_ROLES = new Set(['pageHeader', 'pageFooter', 'pageNumber']);
// Roles that become markdown headings
const HEADING_ROLES = {
  title: 1,
  sectionHeading: 2,
};

// Build a span-index map: char offset -> { bold, italic, underline, handwritten }
// Each style has spans[] = [{ offset, length }] referring to global content.
function buildStyleMap(styles, contentLength) {
  // Per-character flags. Using flat arrays keeps lookup O(1).
  const bold       = new Uint8Array(contentLength);
  const italic     = new Uint8Array(contentLength);
  const underline  = new Uint8Array(contentLength);
  const handwritten = new Uint8Array(contentLength);

  if (!styles) return { bold, italic, underline, handwritten };

  for (const s of styles) {
    if (!s.spans) continue;
    const isBold      = s.fontWeight === 'bold';
    const isItalic    = s.fontStyle === 'italic';
    const isUnderline = s.textDecoration === 'underline';
    const isHand      = s.isHandwritten === true;
    if (!isBold && !isItalic && !isUnderline && !isHand) continue;

    for (const span of s.spans) {
      const start = Math.max(0, span.offset || 0);
      const end   = Math.min(contentLength, start + (span.length || 0));
      for (let i = start; i < end; i++) {
        if (isBold)       bold[i]       = 1;
        if (isItalic)     italic[i]     = 1;
        if (isUnderline)  underline[i]  = 1;
        if (isHand)       handwritten[i] = 1;
      }
    }
  }
  return { bold, italic, underline, handwritten };
}

// Render a paragraph's text with inline formatting based on per-character flags.
// Walks the paragraph's spans (offsets into global content) and emits HTML.
function renderParagraphHtml(paragraph, content, styleMap) {
  // Most paragraphs have a single span; sometimes multiple if text is split across pages.
  const spans = paragraph.spans || [];
  if (spans.length === 0) return paragraph.content || '';

  let out = '';
  let openBold = false, openItalic = false, openUnderline = false;
  let segHandwritten = false;
  const totalChars = [];

  for (const span of spans) {
    const start = span.offset;
    const end   = start + span.length;
    for (let i = start; i < end; i++) totalChars.push(i);
  }

  // Detect: is the entire paragraph handwritten? Then we replace with [signed].
  let allHand = totalChars.length > 0;
  for (const i of totalChars) {
    if (!styleMap.handwritten[i]) { allHand = false; break; }
  }
  if (allHand) return '[signed]';

  // Walk char by char, opening/closing tags as flags change.
  for (const i of totalChars) {
    const ch = content[i];
    if (ch == null) continue;

    const wantBold       = !!styleMap.bold[i] && !styleMap.handwritten[i];
    const wantItalic     = !!styleMap.italic[i] && !styleMap.handwritten[i];
    const wantUnderline  = !!styleMap.underline[i] && !styleMap.handwritten[i];

    // Mid-paragraph handwritten runs: emit [signed] once and skip the run.
    if (styleMap.handwritten[i]) {
      if (!segHandwritten) { out += ' [signed] '; segHandwritten = true; }
      continue;
    } else if (segHandwritten) {
      segHandwritten = false;
    }

    // Close tags in reverse order if needed
    if (openUnderline && !wantUnderline) { out += '</u>'; openUnderline = false; }
    if (openItalic && !wantItalic) { out += '</em>'; openItalic = false; }
    if (openBold && !wantBold) { out += '</strong>'; openBold = false; }
    // Open tags
    if (!openBold && wantBold) { out += '<strong>'; openBold = true; }
    if (!openItalic && wantItalic) { out += '<em>'; openItalic = true; }
    if (!openUnderline && wantUnderline) { out += '<u>'; openUnderline = true; }

    // Escape HTML special chars
    if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '&') out += '&amp;';
    else out += ch;
  }
  if (openUnderline) out += '</u>';
  if (openItalic) out += '</em>';
  if (openBold) out += '</strong>';

  // Merge adjacent same-style tags separated by whitespace/punctuation only.
  // This collapses '<strong>foo</strong> <strong>bar</strong>' into '<strong>foo bar</strong>'.
  out = out.replace(/<\/strong>(\s+)<strong>/g, '$1');
  out = out.replace(/<\/em>(\s+)<em>/g, '$1');
  out = out.replace(/<\/u>(\s+)<u>/g, '$1');

  return out.trim();
}

// Render a table to HTML. Azure gives us cells with rowIndex, columnIndex,
// rowSpan, columnSpan, kind (columnHeader/rowHeader), and content.
function renderTableHtml(table, content, styleMap) {
  if (!table || !table.cells) return '';
  const rowCount = table.rowCount || 0;
  const colCount = table.columnCount || 0;

  // Build a 2D grid that respects rowSpan/columnSpan
  // Skip cells covered by another cell's span
  const grid = [];
  for (let r = 0; r < rowCount; r++) grid.push(new Array(colCount).fill(null));

  for (const cell of table.cells) {
    const r = cell.rowIndex || 0;
    const c = cell.columnIndex || 0;
    if (r >= rowCount || c >= colCount) continue;
    if (grid[r][c] === 'spanned') continue;

    // Render cell content with inline formatting via spans (preserves bold/italic)
    let cellHtml = '';
    if (cell.spans && cell.spans.length) {
      const fakePara = { spans: cell.spans, content: cell.content };
      cellHtml = renderParagraphHtml(fakePara, content, styleMap);
    } else {
      cellHtml = (cell.content || '').replace(/[&<>]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
    }
    // Strip whitespace, collapse spaces
    cellHtml = cellHtml.replace(/\s+/g, ' ').trim();
    // Filter out classic footer/page-marker garbage that Azure sometimes drags into cells
    if (/qolManual|^\d{2}\/\d{2}\/\d{4}|^\d{2}:\d{2}:\d{2}/.test(cellHtml)) {
      cellHtml = '';
    }
    // Normalize Azure's raw selection markers in cell content (we haven't done global substitution yet)
    // Patterns Azure produces:
    //   "X :selected:"    → mark + selected glyph: keep just X
    //   ":selected: X"    → same: keep just X
    //   ":selected:"      → just selected glyph: emit X (the X is the visual mark)
    //   ":unselected:"    → empty checkbox: render as nothing
    //   "X" (no marker)   → keep X
    //   "" (empty)        → empty
    if (/^[X✓✔]\s*:selected:$/i.test(cellHtml) || /^:selected:\s*[X✓✔]$/i.test(cellHtml)) {
      cellHtml = 'X';
    } else if (cellHtml === ':selected:') {
      cellHtml = 'X';
    } else if (cellHtml === ':unselected:') {
      cellHtml = '';
    }

    grid[r][c] = {
      html: cellHtml,
      rowSpan: cell.rowSpan || 1,
      colSpan: cell.columnSpan || 1,
      isHeader: cell.kind === 'columnHeader' || cell.kind === 'rowHeader',
    };

    // Mark spanned positions so we don't render duplicates
    for (let dr = 0; dr < (cell.rowSpan || 1); dr++) {
      for (let dc = 0; dc < (cell.columnSpan || 1); dc++) {
        if (dr === 0 && dc === 0) continue;
        if (r + dr < rowCount && c + dc < colCount) grid[r + dr][c + dc] = 'spanned';
      }
    }
  }

  let html = '<table>\n';
  for (let r = 0; r < rowCount; r++) {
    html += '<tr>';
    for (let c = 0; c < colCount; c++) {
      const cell = grid[r][c];
      if (!cell || cell === 'spanned') continue;
      const tag = cell.isHeader ? 'th' : 'td';
      const cs = cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '';
      const rs = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';
      html += `<${tag}${cs}${rs}>${cell.html}</${tag}>`;
    }
    html += '</tr>\n';
  }
  html += '</table>';
  return html;
}

export async function extractMarkdownFromPdf(pdfBytes) {
  if (!AZURE_ENDPOINT || !AZURE_KEY) {
    throw new Error('Missing AZURE_DOC_INTEL_ENDPOINT / AZURE_DOC_INTEL_KEY');
  }

  // Local dev caching: hash the PDF bytes, look up cached Azure response
  let cachedResult = null;
  let cachePath = null;
  if (process.env.PP4_CACHE_DIR) {
    const { createHash } = await import('crypto');
    const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('fs');
    const { join } = await import('path');
    const hash = createHash('sha256').update(pdfBytes).digest('hex').slice(0, 16);
    mkdirSync(process.env.PP4_CACHE_DIR, { recursive: true });
    cachePath = join(process.env.PP4_CACHE_DIR, `azure-${hash}.json`);
    if (existsSync(cachePath)) {
      console.log('  [cache hit] using', cachePath);
      cachedResult = JSON.parse(readFileSync(cachePath, 'utf-8'));
    }
  }

  let result;
  if (cachedResult) {
    result = cachedResult;
  } else {
    const client = DocumentIntelligence(AZURE_ENDPOINT, { key: AZURE_KEY });

  const initialResponse = await client
    .path('/documentModels/{modelId}:analyze', 'prebuilt-layout')
    .post({
      contentType: 'application/octet-stream',
      body: pdfBytes,
      queryParameters: {
        // We don't request markdown content — we'll build our own from paragraphs+styles
        features: ['styleFont'],
      },
    });

  if (isUnexpected(initialResponse)) {
    const errMsg = initialResponse.body?.error?.message || JSON.stringify(initialResponse.body).slice(0, 500);
    throw new Error('Azure layout error: ' + errMsg);
  }

    const poller = getLongRunningPoller(client, initialResponse);
    result = (await poller.pollUntilDone()).body;
    if (cachePath) {
      const { writeFileSync } = await import('fs');
      writeFileSync(cachePath, JSON.stringify(result, null, 2));
      console.log('  [cache write] saved to', cachePath);
    }
  }
  const r = result.analyzeResult;
  if (!r) throw new Error('Azure returned no analyzeResult');

  // Keep raw content with ORIGINAL character offsets intact for span extraction.
  // We convert :selected:/:unselected: → ☒/☐ at the very end on the final markdown.
  const content = r.content || '';
  const styleMap = buildStyleMap(r.styles || [], content.length);

  // Determine which paragraph offsets are inside table cells (so we don't double-render them)
  const cellSpanRanges = [];
  for (const t of r.tables || []) {
    for (const cell of t.cells || []) {
      for (const sp of cell.spans || []) {
        cellSpanRanges.push({ start: sp.offset, end: sp.offset + sp.length });
      }
    }
  }
  const isInTable = (paragraph) => {
    if (!paragraph.spans || !paragraph.spans.length) return false;
    const pStart = paragraph.spans[0].offset;
    return cellSpanRanges.some((r) => pStart >= r.start && pStart < r.end);
  };

  // Build flat sequence of blocks in document order (paragraphs, tables, figures interleaved)
  // Azure paragraphs/tables/figures all have spans; sort everything by first span offset.
  const blocks = [];
  for (const p of r.paragraphs || []) {
    if (DROP_ROLES.has(p.role)) continue;
    if (isInTable(p)) continue;
    // Skip paragraphs whose offset falls inside a figure (those will render via the figure image)
    blocks.push({ kind: 'paragraph', offset: p.spans?.[0]?.offset ?? 0, data: p });
  }
  for (const t of r.tables || []) {
    const tOff = t.spans?.[0]?.offset ?? (t.cells?.[0]?.spans?.[0]?.offset ?? 0);
    blocks.push({ kind: 'table', offset: tOff, data: t });
  }
  for (let fi = 0; fi < (r.figures || []).length; fi++) {
    const f = r.figures[fi];
    const fOff = f.spans?.[0]?.offset ?? 0;
    blocks.push({ kind: 'figure', offset: fOff, index: fi });
  }
  blocks.sort((a, b) => a.offset - b.offset);

  // Render to HTML-flavored markdown
  const out = [];
  for (const block of blocks) {
    if (block.kind === 'table') {
      out.push(renderTableHtml(block.data, content, styleMap));
    } else if (block.kind === 'figure') {
      // Placeholder; will be rewritten with the actual image URL later (post-upload)
      out.push(`<img src="__FIGURE_${block.index}__" alt="Figure ${block.index + 1}" />`);
    } else {
      const p = block.data;
      const html = renderParagraphHtml(p, content, styleMap);
      if (!html) continue;
      const headingLevel = HEADING_ROLES[p.role];
      if (headingLevel) {
        out.push('#'.repeat(headingLevel) + ' ' + html);
      } else {
        out.push(html);
      }
    }
  }

  // Insert page break markers between pages (best-effort using page span offsets)
  if (r.pages && r.pages.length > 1) {
    // Find content offset where each page starts and inject markers in document order.
    // For now, append markers where we detect a paragraph that starts at a new page span boundary.
    // (Simpler: skip for now; pp4 renderer can use CSS page-break logic instead.)
  }

  let markdown = out.join('\n\n');
  // Now safely convert Azure's selection markers to checkbox glyphs
  markdown = markdown.replace(/:selected:/g, '☒').replace(/:unselected:/g, '☐');
  // If we extracted any figures, the signature is likely captured visually — drop [signed] placeholder
  // to avoid showing both the placeholder text AND the signature image.
  if ((r.figures || []).length > 0) {
    markdown = markdown.replace(/\[signed\]/g, '').replace(/\s+\n/g, '\n');
  }

  // Extract figure images (logos, diagrams, signature blocks) from source PDF
  let figures = [];
  if (r.figures && r.figures.length > 0) {
    try {
      figures = await extractFigureImages(pdfBytes, r.figures, r.pages || []);
      console.log(`Extracted ${figures.length} figure images`);
    } catch (err) {
      console.error('Figure extraction failed (non-fatal):', err.message);
    }
  }

  return {
    markdown,
    figures,
    pageCount:  r.pages?.length || 0,
    paragraphs: r.paragraphs?.length || 0,
    tables:     r.tables?.length || 0,
    styles:     r.styles?.length || 0,
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { jobId } = body;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const { data: job, error: jobErr } = await supabase
      .from('translation_jobs').select('source_path, source_filename')
      .eq('id', jobId).single();
    if (jobErr) throw new Error('Job lookup failed: ' + jobErr.message);

    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(job.source_path);
    if (dlErr || !pdfBlob) throw new Error('PDF download failed: ' + (dlErr?.message || 'no data'));

    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
    console.log(`PP4 extract: job=${jobId} pdf_size=${pdfBytes.length}`);

    const startTime = Date.now();
    const { markdown, pageCount, paragraphs, tables, styles } = await extractMarkdownFromPdf(pdfBytes);
    const elapsed = Date.now() - startTime;
    console.log(`PP4 extract: complete in ${elapsed}ms — ${pageCount}p ${paragraphs}para ${tables}tbl ${styles}st ${markdown.length}ch`);

    const mdPath = `pp4-extracted/${jobId}/source.md`;
    const { error: upErr } = await supabase.storage.from('translation-jobs')
      .upload(mdPath, new Blob([markdown], { type: 'text/markdown' }), { upsert: true });
    if (upErr) throw new Error('Markdown upload failed: ' + upErr.message);

    await supabase.from('translation_jobs').update({
      pages_total: pageCount,
      metadata: {
        extracted_md_path: mdPath,
        azure_pages: pageCount,
        azure_paragraphs: paragraphs,
        azure_tables: tables,
        azure_styles: styles,
        azure_extract_ms: elapsed,
      },
    }).eq('id', jobId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, mdPath, pageCount, mdBytes: markdown.length }) };
  } catch (err) {
    console.error('pp4-extract failed:', err);
    await supabase.from('translation_jobs').update({
      status: 'failed',
      error_message: 'Extract: ' + (err.message || String(err)).slice(0, 500),
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    return { statusCode: 500, body: 'Extract failed' };
  }
}
