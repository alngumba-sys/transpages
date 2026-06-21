// pp4-coordinator-background.js
// Orchestrates the pp4 pipeline: extract → translate → render
// Updates job status at each step so the frontend can poll progress.

import { createClient } from '@supabase/supabase-js';
import { extractMarkdownFromPdf } from './pp4-extract-md-background.js';
import { translateMarkdown } from './pp4-translate-md-background.js';
import { buildPdfHtml, renderHtmlToPdf } from './pp4-render-pdf-background.js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE_URL             = process.env.SITE_URL || 'http://localhost:8888';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { jobId } = body;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  const updateJob = async (fields) => {
    const { error } = await supabase.from('translation_jobs').update(fields).eq('id', jobId);
    if (error) console.error('pp4-coordinator updateJob error:', error.message);
  };

  try {
    // ── Load job ──────────────────────────────────────────────────────────────
    const { data: job, error: jobErr } = await supabase
      .from('translation_jobs')
      .select('source_path, source_filename, target_lang, model_preference, metadata, status')
      .eq('id', jobId).single();
    if (jobErr) throw new Error('Job lookup failed: ' + jobErr.message);
    if (job.status === 'cancelled') {
      console.log('pp4-coordinator: job', jobId, 'is cancelled, skipping');
      return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'cancelled' }) };
    }

    // ── Step 1: Extract ───────────────────────────────────────────────────────
    await updateJob({ status: 'processing', pages_done: 0, error_message: null });
    console.log(`pp4-coordinator [${jobId}]: step 1 — extract`);

    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(job.source_path);
    if (dlErr || !pdfBlob) throw new Error('PDF download failed: ' + (dlErr?.message || 'no data'));
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());

    const { markdown, figures, pageCount, paragraphs, tables } = await extractMarkdownFromPdf(pdfBytes);
    console.log(`pp4-coordinator [${jobId}]: extracted ${pageCount}p ${paragraphs}para ${tables}tbl ${figures.length}fig ${markdown.length}ch`);

    // Upload extracted markdown
    const mdPath = `pp4-extracted/${jobId}/source.md`;
    await supabase.storage.from('translation-jobs')
      .upload(mdPath, new Blob([markdown], { type: 'text/markdown' }), { upsert: true });

    // Upload figure PNGs and build URL map
    const figureDataUrls = {};
    for (const fig of figures) {
      const figPath = `pp4-extracted/${jobId}/figure-${fig.index}.png`;
      await supabase.storage.from('translation-jobs')
        .upload(figPath, fig.pngBytes, { contentType: 'image/png', upsert: true });
      figureDataUrls[fig.index] = `data:image/png;base64,${Buffer.from(fig.pngBytes).toString('base64')}`;
    }

    await updateJob({
      pages_total: pageCount,
      pages_done: 1,
      metadata: {
        ...(job.metadata || {}),
        extracted_md_path: mdPath,
        azure_pages: pageCount,
        azure_paragraphs: paragraphs,
        azure_tables: tables,
        azure_figures: figures.length,
      },
    });

    // ── Step 2: Translate ─────────────────────────────────────────────────────
    console.log(`pp4-coordinator [${jobId}]: step 2 — translate to ${job.target_lang}`);
    await updateJob({ pages_done: 2 });

    const { translated, model, inputTokens, outputTokens } = await translateMarkdown(
      markdown, job.target_lang,
      { langCode: job.target_lang, modelPref: job.model_preference || 'auto' }
    );
    console.log(`pp4-coordinator [${jobId}]: translated model=${model} in=${inputTokens} out=${outputTokens}`);

    // Upload translated markdown
    const translatedMdPath = `pp4-translated/${jobId}/translated.md`;
    await supabase.storage.from('translation-jobs')
      .upload(translatedMdPath, new Blob([translated], { type: 'text/markdown' }), { upsert: true });

    await updateJob({
      pages_done: 3,
      result_text: translated,
      model_used: model,
      metadata: {
        ...(job.metadata || {}),
        extracted_md_path: mdPath,
        translated_md_path: translatedMdPath,
        translate_input_tokens: inputTokens,
        translate_output_tokens: outputTokens,
      },
    });

    // ── Step 3: Render PDF ────────────────────────────────────────────────────
    console.log(`pp4-coordinator [${jobId}]: step 3 — render PDF`);
    await updateJob({ pages_done: 4 });

    // Inject figure data URLs post-translation
    let finalMd = translated;
    for (const [idx, dataUrl] of Object.entries(figureDataUrls)) {
      finalMd = finalMd.replaceAll(`__FIGURE_${idx}__`, dataUrl);
    }

    const title = (job.source_filename || 'Document').replace(/\.[^.]+$/, '') + ' — ' + job.target_lang;
    const html = buildPdfHtml(finalMd, title);
    const pdfOut = await renderHtmlToPdf(html);
    console.log(`pp4-coordinator [${jobId}]: rendered PDF ${pdfOut.length} bytes`);

    // Upload final PDF
    const pdfPath = `pp4-final/${jobId}/translated.pdf`;
    const { error: upErr } = await supabase.storage.from('translation-jobs')
      .upload(pdfPath, pdfOut, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error('PDF upload failed: ' + upErr.message);

    // ── Complete ──────────────────────────────────────────────────────────────
    await updateJob({
      status: 'completed',
      pages_done: pageCount,
      result_pdf_path: pdfPath,
      completed_at: new Date().toISOString(),
      metadata: {
        ...(job.metadata || {}),
        extracted_md_path: mdPath,
        translated_md_path: translatedMdPath,
        pipeline: 'pp4',
      },
    });

    console.log(`pp4-coordinator [${jobId}]: completed`);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, jobId, pdfPath }) };

  } catch (err) {
    console.error(`pp4-coordinator [${jobId}]: FAILED`, err.message);
    await updateJob({
      status: 'failed',
      error_message: (err.message || String(err)).slice(0, 500),
      completed_at: new Date().toISOString(),
    });
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
}
