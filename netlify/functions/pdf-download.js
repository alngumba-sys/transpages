const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  try {
    const { jobId } = JSON.parse(event.body || '{}');
    if (!jobId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'jobId required' }) };

    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'unauthenticated' }) };

    const sbAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const { data: userData, error: userErr } = await sbAuth.auth.getUser(token);
    if (userErr || !userData?.user) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'invalid token' }) };

    const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: job, error: jobErr } = await sbAdmin
      .from('translation_jobs')
      .select('user_id, result_pdf_path')
      .eq('id', jobId)
      .maybeSingle();

    if (jobErr || !job) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'job not found' }) };
    if (job.user_id !== userData.user.id) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'forbidden' }) };
    if (!job.result_pdf_path) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'pdf not ready' }) };

    let path = job.result_pdf_path;
    if (path.startsWith('translation-jobs/')) path = path.substring('translation-jobs/'.length);

    const { data: signed, error: signErr } = await sbAdmin.storage
      .from('translation-jobs')
      .createSignedUrl(path, 3600);

    if (signErr) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: signErr.message }) };

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: signed.signedUrl, filename: path.split('/').pop() })
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
