// pp6-coordinator.js
// Orchestrates pp6: extract → translate → HTML reconstruct → PDF render

import { createClient } from '@supabase/supabase-js';
import { extractParagraphs } from './pp6-extract.js';
import { translateParagraphs } from './pp6-translate.js';
import { renderHtmlPdf } from './pp6-render.js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { jobId } = body;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const update = async (fields) => supabase.from('translation_jobs').update(fields).eq('id', jobId);

  try {
    const { data: job } = await supabase.from('translation_jobs')
      .select('source_path, source_filename, target_lang, model_preference, status')
      .eq('id', jobId).single();

    if (job.status === 'cancelled') return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'cancelled' }) };

    await update({ status: 'processing', pages_done: 0 });

    // Step 1: Extract
    console.log(`pp6 [${jobId}]: extracting...`);
    const { data: pdfBlob } = await supabase.storage.from('translation-jobs').download(job.source_path);
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const { paragraphs, pageCount, pageDims, splitPoint } = await extractParagraphs(pdfBytes);
    console.log(`pp6 [${jobId}]: ${paragraphs.length} paragraphs, ${pageCount} pages, split=${splitPoint.toFixed(2)}`);
    await update({ pages_total: pageCount, pages_done: 1 });

    // Step 2: Translate
    console.log(`pp6 [${jobId}]: translating to ${job.target_lang}...`);
    const translations = await translateParagraphs(paragraphs, job.target_lang);
    const translated = paragraphs.map((p, i) => ({ ...p, translatedText: translations[i] }));
    await update({ pages_done: 2, result_text: translations.slice(0, 3).join('\n\n') });

    // Step 3: Render HTML → PDF
    console.log(`pp6 [${jobId}]: rendering HTML → PDF...`);
    const pdfOut = await renderHtmlPdf(translated, pageCount);

    const pdfPath = `pp6-final/${jobId}/translated.pdf`;
    await supabase.storage.from('translation-jobs')
      .upload(pdfPath, pdfOut, { contentType: 'application/pdf', upsert: true });

    await update({
      status: 'completed',
      pages_done: pageCount,
      result_pdf_path: pdfPath,
      completed_at: new Date().toISOString(),
      metadata: { pipeline: 'pp6', paragraph_count: paragraphs.length },
    });

    console.log(`pp6 [${jobId}]: completed, ${pdfOut.length} bytes`);
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ ok: true, pdfPath }) };
  } catch (err) {
    console.error(`pp6 [${jobId}]: FAILED`, err.message);
    await update({ status: 'failed', error_message: err.message.slice(0, 500), completed_at: new Date().toISOString() });
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
}
