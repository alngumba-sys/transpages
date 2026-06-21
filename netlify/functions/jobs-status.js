// netlify/functions/jobs-status.js
//
// Returns current status + progress + result for a job.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...corsHeaders },
  body: JSON.stringify(body),
});

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST')
    return json(405, { error: 'Method Not Allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Server missing Supabase credentials.' });
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Missing Authorization header.' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) return json(401, { error: 'Invalid token.' });

  let jobId = event.queryStringParameters?.jobId;
  if (!jobId && event.body) {
    try { jobId = JSON.parse(event.body).jobId; } catch {}
  }
  if (!jobId) return json(400, { error: 'Missing jobId.' });

  // Try with new columns; fall back if migration not yet applied
  let job, error;
  let useModelColumns = true;
  let usePpColumns = true;
  let resp = await supabase
    .from('translation_jobs')
    .select('id, user_id, status, source_filename, target_lang, service, pages_total, pages_done, chunks_total, chunks_done, result_text, extracted_text, error_message, created_at, started_at, completed_at, model_preference, model_used, pixel_perfect, result_pdf_path')
    .eq('id', jobId)
    .single();

  if (resp.error && /pixel_perfect|result_pdf_path/i.test(resp.error.message || '')) {
    usePpColumns = false;
    resp = await supabase
      .from('translation_jobs')
      .select('id, user_id, status, source_filename, target_lang, service, pages_total, pages_done, chunks_total, chunks_done, result_text, extracted_text, error_message, created_at, started_at, completed_at, model_preference, model_used')
      .eq('id', jobId)
      .single();
  }
  if (resp.error && /model_/i.test(resp.error.message || '')) {
    useModelColumns = false;
    usePpColumns = false;
    resp = await supabase
      .from('translation_jobs')
      .select('id, user_id, status, source_filename, target_lang, service, pages_total, pages_done, chunks_total, chunks_done, result_text, extracted_text, error_message, created_at, started_at, completed_at')
      .eq('id', jobId)
      .single();
  }
  job = resp.data;
  error = resp.error;

  if (error || !job) return json(404, { error: 'Job not found.' });
  if (job.user_id !== userData.user.id) return json(403, { error: 'Forbidden.' });

  // Generate signed URL for the PP result PDF if available
  let resultPdfUrl = null;
  if (usePpColumns && job.result_pdf_path) {
    const { data: signedData } = await supabase.storage
      .from('translation-jobs')
      .createSignedUrl(job.result_pdf_path, 3600);  // 1-hour signed URL
    if (signedData?.signedUrl) resultPdfUrl = signedData.signedUrl;
  }

  const totalChunks = Math.max(job.chunks_total || 0, 1);
  const percent = job.status === 'completed' ? 100 :
                  job.status === 'failed' || job.status === 'cancelled' ? 0 :
                  Math.min(99, Math.round(((job.chunks_done || 0) / totalChunks) * 100));

  return json(200, {
    id: job.id,
    status: job.status,
    source_filename: job.source_filename,
    target_lang: job.target_lang,
    service: job.service,
    progress: {
      pages_done: job.pages_done || 0,
      pages_total: job.pages_total || 0,
      chunks_done: job.chunks_done || 0,
      chunks_total: job.chunks_total || 0,
      percent,
    },
    result_text: job.result_text || null,
    extracted_text: job.extracted_text || null,
    error_message: job.error_message || null,
    model_preference: useModelColumns ? (job.model_preference || null) : null,
    model_used: useModelColumns ? (job.model_used || null) : null,
    pixel_perfect: usePpColumns ? !!job.pixel_perfect : false,
    result_pdf_url: resultPdfUrl,
    timestamps: {
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    },
  });
}
