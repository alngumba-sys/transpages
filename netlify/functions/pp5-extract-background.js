// pp5-extract-background.js
// Calls Azure Document Intelligence and returns structured paragraph data
// with bounding boxes, styles, and page dimensions for the overlay renderer.

import { createClient } from '@supabase/supabase-js';
import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from '@azure-rest/ai-document-intelligence';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const AZURE_ENDPOINT       = process.env.AZURE_DOC_INTEL_ENDPOINT;
const AZURE_KEY            = process.env.AZURE_DOC_INTEL_KEY;

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

  // Build per-character bold/italic flags and per-character color/bgColor from styles
  const boldMap   = new Uint8Array(content.length);
  const italicMap = new Uint8Array(content.length);
  const colorMap  = new Array(content.length).fill(null);   // hex color per char
  const bgColorMap = new Array(content.length).fill(null);
  for (const s of r.styles || []) {
    for (const span of s.spans || []) {
      const start = span.offset || 0;
      const end   = Math.min(content.length, start + (span.length || 0));
      if (s.fontWeight === 'bold')   for (let i = start; i < end; i++) boldMap[i]   = 1;
      if (s.fontStyle  === 'italic') for (let i = start; i < end; i++) italicMap[i] = 1;
      if (s.color)           for (let i = start; i < end; i++) colorMap[i] = s.color;
      if (s.backgroundColor) for (let i = start; i < end; i++) bgColorMap[i] = s.backgroundColor;
    }
  }

  // Build page dimension map: pageNumber → { width, height } in inches
  const pageDims = {};
  for (const p of r.pages || []) {
    pageDims[p.pageNumber] = { width: p.width, height: p.height, unit: p.unit };
  }

  // Build table cell span ranges so we can skip paragraphs inside tables
  const tableCellRanges = [];
  for (const t of r.tables || []) {
    for (const cell of t.cells || []) {
      for (const sp of cell.spans || []) {
        tableCellRanges.push({ start: sp.offset, end: sp.offset + sp.length });
      }
    }
  }
  const isInTable = (p) => {
    if (!p.spans?.length) return false;
    const off = p.spans[0].offset;
    return tableCellRanges.some(r => off >= r.start && off < r.end);
  };

  // Extract paragraphs with full metadata
  const paragraphs = [];
  for (const p of r.paragraphs || []) {
    if (DROP_ROLES.has(p.role)) continue;
    if (isInTable(p)) continue;
    if (!p.content?.trim()) continue;
    if (!p.boundingRegions?.length) continue;

    const region = p.boundingRegions[0];
    const pageNum = region.pageNumber;
    const polygon = region.polygon || [];
    const dims = pageDims[pageNum] || { width: 8.5, height: 11 };

    // Bounding box from polygon (8 values: x0,y0,x1,y1,x2,y2,x3,y3 in inches)
    const xs = [polygon[0], polygon[2], polygon[4], polygon[6]].filter(v => v != null);
    const ys = [polygon[1], polygon[3], polygon[5], polygon[7]].filter(v => v != null);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;

    // Detect dominant style for this paragraph
    let boldCount = 0, totalCount = 0;
    for (const span of p.spans || []) {
      for (let i = span.offset; i < span.offset + span.length; i++) {
        if (i < content.length) {
          if (boldMap[i]) boldCount++;
          totalCount++;
        }
      }
    }
    const bold   = totalCount > 0 && boldCount / totalCount > 0.5;
    const italic = false; // simplified for now

    // Estimate font size from bbox height and line count
    const lineCount = Math.max(1, (p.content.match(/\n/g) || []).length + 1);
    const estimatedFontSizePt = Math.round((h / lineCount) * 72 * 0.65); // rough estimate

    // Find dominant text color and background color for this paragraph
    let textColor = null;
    let bgColor = null;
    for (const span of p.spans || []) {
      for (let i = span.offset; i < span.offset + span.length && i < content.length; i++) {
        if (!textColor && colorMap[i]) textColor = colorMap[i];
        if (!bgColor && bgColorMap[i]) bgColor = bgColorMap[i];
        if (textColor && bgColor) break;
      }
      if (textColor && bgColor) break;
    }

    paragraphs.push({
      index:    paragraphs.length,
      pageNum,
      x, y, w, h,           // in inches
      pageW:    dims.width,
      pageH:    dims.height,
      text:     p.content.replace(/\n/g, ' ').trim(),
      bold,
      italic,
      role:     p.role || 'body',
      fontSize: Math.max(7, Math.min(36, estimatedFontSizePt)),
      textColor: textColor || null,
      bgColor:   bgColor || null,
    });
  }

  return {
    paragraphs,
    pageCount: r.pages?.length || 0,
    pageDims,
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { jobId } = body;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const { data: job, error: jobErr } = await supabase
      .from('translation_jobs').select('source_path, source_filename')
      .eq('id', jobId).single();
    if (jobErr) throw new Error('Job lookup: ' + jobErr.message);

    const { data: blob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(job.source_path);
    if (dlErr || !blob) throw new Error('PDF download: ' + (dlErr?.message || 'no data'));

    const pdfBytes = new Uint8Array(await blob.arrayBuffer());
    const { paragraphs, pageCount, pageDims } = await extractParagraphs(pdfBytes);

    const dataPath = `pp5-extracted/${jobId}/paragraphs.json`;
    await supabase.storage.from('translation-jobs')
      .upload(dataPath, JSON.stringify({ paragraphs, pageCount, pageDims }), { upsert: true });

    await supabase.from('translation_jobs').update({
      pages_total: pageCount,
      metadata: { pp5_paragraphs_path: dataPath, pp5_paragraph_count: paragraphs.length },
    }).eq('id', jobId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, paragraphs: paragraphs.length, pageCount }) };
  } catch (err) {
    console.error('pp5-extract failed:', err);
    await supabase.from('translation_jobs').update({
      status: 'failed', error_message: err.message.slice(0, 500), completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    return { statusCode: 500, body: err.message };
  }
}
