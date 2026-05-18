// pp6-extract.js
// Enhanced Azure extraction: captures color, fontSize, column, section grouping.
// Designed for HTML reconstruction pipeline (pp6).

import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from '@azure-rest/ai-document-intelligence';

const AZURE_ENDPOINT = process.env.AZURE_DOC_INTEL_ENDPOINT;
const AZURE_KEY      = process.env.AZURE_DOC_INTEL_KEY;

const DROP_ROLES = new Set(['pageHeader', 'pageFooter', 'pageNumber']);

export async function extractParagraphs(pdfBytes) {
  if (!AZURE_ENDPOINT || !AZURE_KEY) throw new Error('Missing Azure credentials');

  const client = DocumentIntelligence(AZURE_ENDPOINT, { key: AZURE_KEY });
  const initial = await client
    .path('/documentModels/{modelId}:analyze', 'prebuilt-layout')
    .post({
      contentType: 'application/octet-stream',
      body: pdfBytes,
      queryParameters: { features: ['styleFont'] },
    });

  if (isUnexpected(initial)) {
    throw new Error('Azure error: ' + (initial.body?.error?.message || JSON.stringify(initial.body).slice(0, 300)));
  }

  const result = (await getLongRunningPoller(client, initial).pollUntilDone()).body;
  const r = result.analyzeResult;
  if (!r) throw new Error('Azure returned no analyzeResult');

  const content = r.content || '';

  // Build per-character style maps from r.styles
  const boldMap    = new Uint8Array(content.length);
  const italicMap  = new Uint8Array(content.length);
  const colorMap   = new Array(content.length).fill(null);
  const bgColorMap = new Array(content.length).fill(null);
  for (const s of r.styles || []) {
    for (const span of s.spans || []) {
      const start = span.offset || 0;
      const end   = Math.min(content.length, start + (span.length || 0));
      if (s.fontWeight === 'bold')   for (let i = start; i < end; i++) boldMap[i]   = 1;
      if (s.fontStyle  === 'italic') for (let i = start; i < end; i++) italicMap[i] = 1;
      if (s.color)           for (let i = start; i < end; i++) colorMap[i]   = s.color;
      if (s.backgroundColor) for (let i = start; i < end; i++) bgColorMap[i] = s.backgroundColor;
    }
  }

  // Page dimensions
  const pageDims = {};
  for (const p of r.pages || []) {
    pageDims[p.pageNumber] = { width: p.width, height: p.height, unit: p.unit };
  }

  // Table cell span ranges (to skip paragraphs that are in tables)
  const tableCellRanges = [];
  const tables = [];
  for (const t of r.tables || []) {
    const tableData = {
      rowCount: t.rowCount,
      columnCount: t.columnCount,
      pageNum: t.boundingRegions?.[0]?.pageNumber || 1,
      cells: [],
    };
    for (const cell of t.cells || []) {
      for (const sp of cell.spans || []) {
        tableCellRanges.push({ start: sp.offset, end: sp.offset + sp.length });
      }
      tableData.cells.push({
        rowIndex: cell.rowIndex,
        columnIndex: cell.columnIndex,
        content: cell.content || '',
      });
    }
    // Sort cells by row then column
    tableData.cells.sort((a, b) => a.rowIndex !== b.rowIndex ? a.rowIndex - b.rowIndex : a.columnIndex - b.columnIndex);
    tables.push(tableData);
    console.log(`pp6-extract: found table ${tableData.rowCount}x${tableData.columnCount} on page ${tableData.pageNum} (${tableData.cells.length} cells)`);
  }
  const isInTable = (p) => {
    if (!p.spans?.length) return false;
    const off = p.spans[0].offset;
    return tableCellRanges.some(r => off >= r.start && off < r.end);
  };

  // Detect column split: find largest X-position gap
  const allXStarts = [];
  for (const p of r.paragraphs || []) {
    if (!p.boundingRegions?.length) continue;
    const polygon = p.boundingRegions[0].polygon || [];
    const xs = [polygon[0], polygon[2], polygon[4], polygon[6]].filter(v => v != null);
    if (xs.length) {
      const pageW = (pageDims[p.boundingRegions[0].pageNumber] || { width: 8.5 }).width;
      allXStarts.push(Math.min(...xs) / pageW);
    }
  }
  const sortedX = [...new Set(allXStarts.map(v => Math.round(v * 100) / 100))].sort((a, b) => a - b);
  let maxGap = 0, splitPoint = 0.63;
  for (let i = 1; i < sortedX.length; i++) {
    const gap = sortedX[i] - sortedX[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
      splitPoint = sortedX[i] - 0.02;
    }
  }
  if (maxGap < 0.1) splitPoint = 1.0;
  console.log(`pp6-extract: column split at ${splitPoint.toFixed(3)} (gap=${maxGap.toFixed(3)})`);

  // Extract paragraphs with full metadata
  const paragraphs = [];
  for (const p of r.paragraphs || []) {
    if (DROP_ROLES.has(p.role)) continue;
    if (isInTable(p)) continue;
    if (!p.content?.trim()) continue;
    if (!p.boundingRegions?.length) continue;

    const region  = p.boundingRegions[0];
    const pageNum = region.pageNumber;
    const polygon = region.polygon || [];
    const dims    = pageDims[pageNum] || { width: 8.5, height: 11 };

    const xs = [polygon[0], polygon[2], polygon[4], polygon[6]].filter(v => v != null);
    const ys = [polygon[1], polygon[3], polygon[5], polygon[7]].filter(v => v != null);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;

    // Detect dominant bold/italic
    let boldCount = 0, italicCount = 0, totalCount = 0;
    for (const span of p.spans || []) {
      for (let i = span.offset; i < span.offset + span.length && i < content.length; i++) {
        if (boldMap[i])   boldCount++;
        if (italicMap[i]) italicCount++;
        totalCount++;
      }
    }
    const bold   = totalCount > 0 && boldCount / totalCount > 0.5;
    const italic = totalCount > 0 && italicCount / totalCount > 0.5;

    // Detect text color and background color
    let textColor = null, bgColor = null;
    for (const span of p.spans || []) {
      for (let i = span.offset; i < span.offset + span.length && i < content.length; i++) {
        if (!textColor && colorMap[i]) textColor = colorMap[i];
        if (!bgColor && bgColorMap[i]) bgColor = bgColorMap[i];
        if (textColor && bgColor) break;
      }
      if (textColor && bgColor) break;
    }

    // Estimate font size from bbox
    const lineCount = Math.max(1, (p.content.match(/\n/g) || []).length + 1);
    const estimatedFontSizePt = Math.round((h / lineCount) * 72 * 0.65);

    // Column assignment
    const normX = x / dims.width;
    const columnIndex = normX >= splitPoint ? 1 : 0;

    paragraphs.push({
      index:       paragraphs.length,
      pageNum,
      x, y, w, h,
      pageW:       dims.width,
      pageH:       dims.height,
      text:        p.content.replace(/\n/g, ' ').trim(),
      bold,
      italic,
      role:        p.role || 'body',
      fontSize:    Math.max(7, Math.min(36, estimatedFontSizePt)),
      textColor:   textColor || null,
      bgColor:     bgColor || null,
      columnIndex,
    });
  }

  // Assign section groups: consecutive paragraphs in the same column that belong together
  let currentGroup = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (p.role === 'sectionHeading' || p.role === 'title') {
      currentGroup++;
    }
    p.sectionGroup = currentGroup;
    // Start a new group if column changes between consecutive paragraphs
    if (i + 1 < paragraphs.length && paragraphs[i + 1].columnIndex !== p.columnIndex) {
      currentGroup++;
    }
  }

  return {
    paragraphs,
    tables,
    pageCount: r.pages?.length || 0,
    pageDims,
    splitPoint,
  };
}
