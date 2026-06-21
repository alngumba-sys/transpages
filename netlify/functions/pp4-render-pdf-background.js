// pp4-render-pdf-background.js
// Reads translated markdown from storage, renders to clean HTML with letter CSS,
// converts to PDF via Puppeteer + Chromium, uploads to Supabase storage.

import { createClient } from '@supabase/supabase-js';
// Auto-detect: use full puppeteer locally (has bundled Chromium),
// use puppeteer-core + @sparticuz/chromium in Lambda/Netlify production.
const IS_LAMBDA = !!(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY_LOCAL === 'false' || process.env.LAMBDA_TASK_ROOT);

let puppeteer, chromium;
if (IS_LAMBDA) {
  puppeteer = (await import('puppeteer-core')).default;
  chromium = (await import('@sparticuz/chromium')).default;
} else {
  puppeteer = (await import('puppeteer')).default;
  chromium = null;
}

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Minimal markdown → HTML converter focused on what Azure produces
// Allowed inline HTML tags that the extractor emits (or markdown converts to).
// These are passed through unchanged; everything else is escaped.
const INLINE_TAGS = ['strong','em','u','b','i','s','code','sub','sup','br','span','a'];

function processInlineHtml(s) {
  // 1. Convert markdown links [text](url) to <a>
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    const safeUrl = url.replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return `<a href="${safeUrl}">${text}</a>`;
  });
  // 2. Markdown bold **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 3. Strip backslash escapes from common markdown chars
  s = s.replace(/\\([.\-_*#])/g, '$1');
  return s;
}

function markdownToHtml(md) {
  let html = md;

  // Page breaks
  html = html.replace(/<!--\s*PageBreak\s*-->/g, '<div class="page-break"></div>');

  // Split on blank lines
  const blocks = html.split(/\n\s*\n/);
  const out = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    // Block-level HTML (table, figure, div, headings, lists, blockquotes) — pass through
    if (/^<(table|figure|div|h[1-6]|ul|ol|blockquote)/i.test(block)) {
      out.push(block);
      continue;
    }

    // Markdown headings
    const h = block.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${processInlineHtml(h[2])}</h${level}>`);
      continue;
    }

    // Paragraph — preserve inline HTML tags from extractor (<strong>/<em>/<u>),
    // process markdown inline syntax, keep line breaks.
    const lines = block.split('\n').map((l) => processInlineHtml(l.trim())).filter(Boolean);
    if (lines.length) {
      out.push('<p>' + lines.join('<br>') + '</p>');
    }
  }

  return out.join('\n');
}

const PDF_CSS = `
  @page { size: A4; margin: 25mm 20mm; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #111;
    margin: 0;
    padding: 0;
  }
  .doc { padding: 0; }
  p { margin: 0 0 1em 0; text-align: justify; }
  h1 { font-size: 18pt; font-weight: 700; margin: 0 0 0.6em 0; }
  h2 { font-size: 14pt; font-weight: 700; margin: 1em 0 0.5em 0; }
  h3 { font-size: 12pt; font-weight: 700; margin: 0.8em 0 0.4em 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    table-layout: auto;
    font-size: 9pt;
    page-break-inside: avoid;
  }
  th, td {
    border: 1px solid #999;
    padding: 6px 5px;
    text-align: center;
    vertical-align: middle;
    line-height: 1.3;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  th {
    background: #f1f3f5;
    font-weight: 600;
    font-size: 8.5pt;
    line-height: 1.25;
    padding: 8px 4px;
  }
  /* First column (row labels) gets left alignment and wider treatment */
  td:first-child, th:first-child {
    text-align: left;
    font-weight: 600;
    background: #fafbfc;
    width: 14%;
  }
  /* Data cells stay narrow and uniform */
  td:not(:first-child) {
    font-size: 10pt;
    font-weight: 600;
    color: #111;
  }
  /* Reduce table size slightly for wide-column-count tables (auto-detected by CSS) */
  table { font-size: 8.5pt; }
  figure { margin: 1em 0; text-align: center; font-style: italic; color: #555; }
  a { color: #0a58ca; text-decoration: none; }
  ul, ol { margin: 0 0 1em 1.5em; padding: 0; }
  li { margin-bottom: 0.3em; }
  .page-break { page-break-after: always; height: 0; }
  blockquote { border-left: 3px solid #ccc; padding-left: 1em; margin: 0 0 1em 0; color: #555; }
  img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0.5em 0;
    page-break-inside: avoid;
  }
  /* Smaller images for inline figures (logos, signatures) */
  img[alt*="Figure"] {
    max-width: 60%;
    margin: 0.8em auto;
  }
`;

export function buildPdfHtml(markdown, title) {
  const body = markdownToHtml(markdown);
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>${escapeAttr(title || 'Translated Document')}</title>
<style>${PDF_CSS}</style>
</head><body><div class="doc">
${body}
</div></body></html>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function renderHtmlToPdf(html) {
  const launchOpts = chromium
    ? {
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: true,
      }
    : {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      };
  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }, // CSS @page handles margins
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
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
      .from('translation_jobs')
      .select('source_filename, target_lang, metadata')
      .eq('id', jobId).single();
    if (jobErr) throw new Error('Job lookup failed: ' + jobErr.message);

    const tmdPath = job.metadata?.translated_md_path;
    if (!tmdPath) throw new Error('No translated_md_path in job metadata');

    const { data: mdBlob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(tmdPath);
    if (dlErr || !mdBlob) throw new Error('Translated markdown download failed: ' + (dlErr?.message || 'no data'));
    const markdown = await mdBlob.text();

    console.log(`PP4 render: job=${jobId} md_size=${markdown.length}`);
    const html = buildPdfHtml(markdown, (job.source_filename || 'Translated').replace(/\.[^.]+$/, '') + ' — ' + job.target_lang);

    const startTime = Date.now();
    const pdfBytes = await renderHtmlToPdf(html);
    const elapsed = Date.now() - startTime;
    console.log(`PP4 render: complete in ${elapsed}ms — pdf=${pdfBytes.length} bytes`);

    const pdfPath = `pp4-final/${jobId}/translated.pdf`;
    const { error: upErr } = await supabase.storage.from('translation-jobs')
      .upload(pdfPath, pdfBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error('PDF upload failed: ' + upErr.message);

    await supabase.from('translation_jobs').update({
      status: 'completed',
      result_pdf_path: pdfPath,
      completed_at: new Date().toISOString(),
      metadata: { ...(job.metadata || {}), render_ms: elapsed, render_pdf_bytes: pdfBytes.length },
    }).eq('id', jobId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, pdfPath, pdfBytes: pdfBytes.length }) };
  } catch (err) {
    console.error('pp4-render failed:', err);
    await supabase.from('translation_jobs').update({
      status: 'failed',
      error_message: 'Render: ' + (err.message || String(err)).slice(0, 500),
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    return { statusCode: 500, body: 'Render failed' };
  }
}
