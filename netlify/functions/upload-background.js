// netlify/functions/upload-background.js
//
// Background function (15-min budget, 256MB body limit).
// Receives base64-encoded PDF + jobId from browser, uploads to Supabase Storage
// using the service role key (server-side = much more reliable than browser-direct).
// Then triggers the coordinator.
//
// Body: { jobId, sourcePath, base64Data, sourceFilename, sourceSizeBytes, targetLang, service }

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function makeServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function failJob(supabase, jobId, message) {
  console.error('upload-background failJob:', jobId, message);
  try {
    await supabase.from('translation_jobs').update({
      status: 'failed',
      error_message: String(message).slice(0, 2000),
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
  } catch (e) { console.error('failJob update error:', e); }
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { jobId, sourcePath, base64Data } = body;

  if (!jobId || !sourcePath || !base64Data) {
    return { statusCode: 400, body: 'Missing required fields' };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: 'Server missing Supabase credentials' };
  }

  const supabase = makeServiceClient();

  try {
    // Mark job as uploading
    await supabase.from('translation_jobs').update({
      status: 'uploading',
      started_at: new Date().toISOString(),
    }).eq('id', jobId);

    // Decode base64 → Buffer
    const buffer = Buffer.from(base64Data, 'base64');
    console.log(`Uploading ${buffer.length} bytes to ${sourcePath}`);

    // Upload to Supabase Storage using service role
    const { error: upErr } = await supabase.storage
      .from('translation-jobs')
      .upload(sourcePath, buffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (upErr) {
      await failJob(supabase, jobId, `Storage upload failed: ${upErr.message}`);
      return { statusCode: 500, body: 'Upload failed' };
    }

    console.log(`Upload complete for job ${jobId}, triggering coordinator`);

    // Mark queued and trigger coordinator
    await supabase.from('translation_jobs').update({ status: 'queued' }).eq('id', jobId);

    const baseUrl = (process.env.URL || process.env.SITE_URL || 'http://localhost:8888').replace(/\/+$/, '');
    const coordinatorUrl = `${baseUrl}/.netlify/functions/coordinator-background`;

    fetch(coordinatorUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }).catch((e) => console.warn('coordinator trigger failed:', e?.message));

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('upload-background error:', err);
    await failJob(supabase, jobId, err.message || 'Unknown error');
    return { statusCode: 500, body: 'Error' };
  }
}
