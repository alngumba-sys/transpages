// netlify/functions/pp2-diagnostic.js
//
// One-off diagnostic. Sends a PDF (by sourcePath) to Sonnet with a structured prompt
// and returns the raw JSON response so we can inspect what coordinates Sonnet returns.
//
// Call from browser console:
//   const session = (await sb.auth.getSession()).data.session;
//   fetch('/.netlify/functions/pp2-diagnostic', {
//     method: 'POST',
//     headers: {'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
//     body: JSON.stringify({sourcePath: 'YOUR_USER_ID/somefile.pdf'})
//   }).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...corsHeaders },
  body: JSON.stringify(body, null, 2),
});

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Missing Authorization' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data: userData } = await supabase.auth.getUser(token);
  if (!userData?.user) return json(401, { error: 'Invalid token' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const sourcePath = body.sourcePath;
  if (!sourcePath) return json(400, { error: 'Missing sourcePath' });
  if (!sourcePath.startsWith(userData.user.id + '/')) {
    return json(403, { error: 'Path must be inside your folder' });
  }

  // Download the PDF
  const { data: blob, error: dlErr } = await supabase.storage
    .from('translation-jobs').download(sourcePath);
  if (dlErr || !blob) return json(404, { error: 'PDF not found in storage', details: dlErr?.message });

  const pdfBuffer = Buffer.from(await blob.arrayBuffer());
  const base64 = pdfBuffer.toString('base64');

  // Send to Sonnet with a clear bbox-asking prompt
  const systemPrompt =
    `You are analyzing a PDF document. For PAGE 1 ONLY, identify every text region.\n\n` +
    `For each text region return:\n` +
    `- bbox: [x, y, w, h] — the bounding box on the PDF page\n` +
    `- text: exact text content\n` +
    `- font_size_pt: approximate font size in points\n` +
    `- bold: true if bold\n` +
    `- is_logo: true if this text is part of a logo, watermark, or letterhead graphic\n\n` +
    `CRITICAL — COORDINATE SYSTEM:\n` +
    `- Use PDF POINT coordinates (1 pt = 1/72 inch)\n` +
    `- Origin at TOP-LEFT of page, x increases right, y increases DOWN\n` +
    `- Standard US Letter is 612 x 792 points; A4 is 595 x 842 points\n\n` +
    `Group fragments of the same line/sentence into ONE region.\n\n` +
    `Return ONLY this JSON (no markdown fences, no commentary):\n` +
    `{"page_width_pt": N, "page_height_pt": N, "regions":[{"bbox":[x,y,w,h],"text":"...","font_size_pt":N,"bold":bool,"is_logo":bool}]}`;

  const startTime = Date.now();
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Analyze page 1 and return all text regions as JSON.' },
        ],
      }],
    }),
  });
  const elapsedMs = Date.now() - startTime;
  const data = await resp.json();

  if (!resp.ok) {
    return json(resp.status, { error: 'Anthropic API error', details: data, elapsedMs });
  }

  const rawText = data.content
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  let parseError = null;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { parseError = e.message; }

  return json(200, {
    elapsedMs,
    tokensUsed: data.usage,
    parseError,
    rawSample: rawText.slice(0, 500),
    parsed: parsed || null,
    regionCount: parsed?.regions?.length || 0,
    pdfSizeKb: Math.round(pdfBuffer.length / 1024),
  });
}
