// netlify/functions/pp2-fetch-output.js
// Tiny helper: return signed URL for a storage path under translation-jobs bucket
// (must be inside the user's own folder hierarchy or pp-output for their jobs).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (s, b) => ({ statusCode: s, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(b) });

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Missing Authorization' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data: userData } = await supabase.auth.getUser(token);
  if (!userData?.user) return json(401, { error: 'Invalid token' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const path = body.path;
  if (!path) return json(400, { error: 'Missing path' });

  // Only allow paths that reference the user's jobs (loose check)
  const userId = userData.user.id;

  // Verify the job (if jobId is in path) belongs to this user
  const jobIdMatch = path.match(/[0-9a-f-]{36}/);
  if (jobIdMatch) {
    const { data: job } = await supabase.from('translation_jobs')
      .select('user_id').eq('id', jobIdMatch[0]).single();
    if (!job || job.user_id !== userId) {
      return json(403, { error: 'Forbidden — not your job' });
    }
  } else if (!path.startsWith(userId + '/')) {
    return json(403, { error: 'Forbidden' });
  }

  const { data, error } = await supabase.storage
    .from('translation-jobs').createSignedUrl(path, 3600);
  if (error) return json(500, { error: 'sign failed', details: error.message });

  return json(200, { signedUrl: data.signedUrl, path });
}
