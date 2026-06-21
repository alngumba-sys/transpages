// netlify/functions/jobs-create.js
//
// Synchronous endpoint that:
//   1. Verifies the user is authenticated (Supabase JWT)
//   2. Inserts the job row in `translation_jobs`
//   3. Looks up user's glossary for this target language and stores on job
//   4. Triggers the coordinator (unless deferred)
//   5. Returns immediately with { jobId }
//
// Body: { sourcePath, sourceFilename, sourceSizeBytes, targetLang, service, deferUpload?, modelPreference? }

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...corsHeaders },
  body: JSON.stringify(body),
});

// Map a target language string from the frontend to an ISO 2-letter code for glossary lookup.
function resolveLangCode(target) {
  if (!target) return null;
  const t = target.toLowerCase().trim();
  if (t.length === 2) return t;
  const NAMES_TO_CODES = {
    french: 'fr', spanish: 'es', german: 'de', italian: 'it', portuguese: 'pt',
    japanese: 'ja', chinese: 'zh', arabic: 'ar', swahili: 'sw', korean: 'ko',
    russian: 'ru', hindi: 'hi', amharic: 'am', turkish: 'tr', dutch: 'nl',
    polish: 'pl', vietnamese: 'vi', thai: 'th', indonesian: 'id', malay: 'ms',
    hebrew: 'he', persian: 'fa', ukrainian: 'uk', czech: 'cs', swedish: 'sv',
    danish: 'da', finnish: 'fi', norwegian: 'no', greek: 'el', hungarian: 'hu',
    romanian: 'ro', bulgarian: 'bg', tigrinya: 'ti', oromo: 'om', kinyarwanda: 'rw',
    yoruba: 'yo', igbo: 'ig', hausa: 'ha', zulu: 'zu', xhosa: 'xh',
  };
  return NAMES_TO_CODES[t] || null;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return json(500, { error: 'Server is missing Supabase credentials.' });
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Missing Authorization header.' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  if (authError || !userData?.user) {
    return json(401, { error: 'Invalid or expired token.' });
  }
  const userId = userData.user.id;

  let body;
  try { body = event.body ? JSON.parse(event.body) : {}; }
  catch { return json(400, { error: 'Invalid JSON body.' }); }

  const sourcePath = (body.sourcePath || '').toString();
  const sourceFilename = (body.sourceFilename || 'document.pdf').toString();
  const sourceSizeBytes = Number(body.sourceSizeBytes) || 0;
  const targetLang = (body.targetLang || '').toString().trim();
  const service = (body.service || 'translate-pdf').toString();
  const deferUpload = body.deferUpload === true;
  const modelPreference = (body.modelPreference || 'haiku').toString();

  if (!sourcePath) return json(400, { error: '`sourcePath` is required.' });
  if (service !== 'extract-pdf' && service !== 'ocr' && !targetLang) {
    return json(400, { error: '`targetLang` is required for translation.' });
  }
  if (!sourcePath.startsWith(`${userId}/`)) {
    return json(403, { error: 'Source path must be inside your own folder.' });
  }
  if (sourceSizeBytes > 50 * 1024 * 1024) {
    return json(413, { error: 'File too large. Max 50 MB.' });
  }

  // ---- Fetch user's glossary for this language ----
  // Look up server-side rather than trusting client. Stored on job for worker to use.
  let glossaryEntries = [];
  if (targetLang && service !== 'extract-pdf' && service !== 'ocr') {
    const langCode = resolveLangCode(targetLang);
    if (langCode) {
      const { data: glossary, error: glossErr } = await supabase
        .from('glossary_entries')
        .select('source_text, target_text')
        .eq('user_id', userId)
        .eq('target_lang', langCode)
        .limit(200);
      if (!glossErr && glossary) {
        glossaryEntries = glossary;
      }
    }
  }

  const initialStatus = deferUpload ? 'awaiting_upload' : 'queued';
  // ppMode: 'phase2' (vision-based, default) | 'phase1' (native pdfjs) | 'fast' (legacy text)
  const ppMode = (body.ppMode || 'phase2').toString();
  const usePixelPerfect = ppMode !== 'fast';  // backward-compat boolean

  const insertPayload = {
    user_id: userId,
    status: initialStatus,
    source_filename: sourceFilename,
    source_path: sourcePath,
    source_size_bytes: sourceSizeBytes,
    target_lang: targetLang || null,
    service,
    model_preference: modelPreference,
    pixel_perfect: usePixelPerfect,
    meta: { glossary: glossaryEntries },
  };

  let { data: job, error: insertError } = await supabase
    .from('translation_jobs')
    .insert(insertPayload)
    .select('id')
    .single();

  // Fall back if `meta` column doesn't exist yet
  if (insertError && /meta/i.test(insertError.message)) {
    delete insertPayload.meta;
    const retry = await supabase
      .from('translation_jobs')
      .insert(insertPayload)
      .select('id')
      .single();
    job = retry.data;
    insertError = retry.error;
  }
  // Fall back if `model_preference` column doesn't exist yet
  if (insertError && /model_preference/i.test(insertError.message)) {
    delete insertPayload.model_preference;
    const retry = await supabase
      .from('translation_jobs')
      .insert(insertPayload)
      .select('id')
      .single();
    job = retry.data;
    insertError = retry.error;
  }
  // Fall back if `pixel_perfect` column doesn't exist yet
  if (insertError && /pixel_perfect/i.test(insertError.message)) {
    delete insertPayload.pixel_perfect;
    const retry = await supabase
      .from('translation_jobs')
      .insert(insertPayload)
      .select('id')
      .single();
    job = retry.data;
    insertError = retry.error;
  }

  if (insertError) {
    console.error('jobs-create insert error:', insertError);
    return json(500, { error: insertError.message });
  }

  if (!deferUpload) {
    const baseUrl =
      (process.env.URL || process.env.SITE_URL || 'http://localhost:8888').replace(/\/+$/, '');
    // Route based on user's pixel-perfect mode
    let coordinatorPath;
    if (ppMode === 'pp6') coordinatorPath = '/.netlify/functions/pp6-coordinator-background';
    else coordinatorPath = '/.netlify/functions/pp5-coordinator-background';  // pp5: default overlay pipeline
    const coordinatorUrl = `${baseUrl}${coordinatorPath}`;
    console.log('jobs-create: routing job', job.id, 'to', coordinatorPath);
    fetch(coordinatorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    }).catch((e) => console.warn('coordinator trigger failed:', e?.message));
  }

  return json(200, { jobId: job.id, status: initialStatus });
}
