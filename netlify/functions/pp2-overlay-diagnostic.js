// netlify/functions/pp2-overlay-diagnostic.js
//
// Test ONE thing: does pdf-lib drawRectangle hide text underneath when applied to
// an existing PDF? Draw a big yellow circle at page center as a sanity check that
// drawing happens at all. Draw red transparent rectangles where Sonnet detected
// text. Save and return signed URL.
//
// Call from browser console:
//   const session = (await sb.auth.getSession()).data.session;
//   fetch('/.netlify/functions/pp2-overlay-diagnostic', {
//     method: 'POST',
//     headers: {'Content-Type':'application/json','Authorization':'Bearer '+session.access_token},
//     body: JSON.stringify({sourcePath: 'YOUR_USER_ID/somefile.pdf'})
//   }).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))

import { createClient } from '@supabase/supabase-js';
import { PDFDocument, rgb } from 'pdf-lib';

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

  // === Step 1: download original PDF ===
  const { data: blob, error: dlErr } = await supabase.storage
    .from('translation-jobs').download(sourcePath);
  if (dlErr || !blob) return json(404, { error: 'PDF not found', details: dlErr?.message });
  const pdfBuffer = Buffer.from(await blob.arrayBuffer());

  // === Step 2: get Sonnet bboxes ===
  const base64Pdf = pdfBuffer.toString('base64');
  const visionResp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      system: `Identify text regions on PAGE 1 of the PDF. Return ONLY:\n{"page_width_pt":N,"page_height_pt":N,"regions":[{"bbox":[x,y,w,h],"text":"..."}]}\nUse PDF point coordinates, top-left origin, y-down.`,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
          { type: 'text', text: 'Return all text regions on page 1.' },
        ],
      }],
    }),
  });
  const visionData = await visionResp.json();
  if (!visionResp.ok) return json(500, { error: 'Vision call failed', details: visionData });
  const visionText = visionData.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const visionParsed = JSON.parse(visionText);

  // === Step 3: draw debug overlay using pdf-lib ===
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const page = doc.getPage(0);
  const pageW = page.getWidth();
  const pageH = page.getHeight();

  // Sanity check 1: BIG yellow circle at page center. If we see this, drawing works.
  page.drawCircle({
    x: pageW / 2,
    y: pageH / 2,
    size: 80,
    color: rgb(1, 1, 0),
    opacity: 0.6,
  });

  // Sanity check 2: BIG red rectangle covering the entire top area
  page.drawRectangle({
    x: 0,
    y: pageH - 50,  // top 50pt of page
    width: pageW,
    height: 50,
    color: rgb(1, 0, 0),
    opacity: 0.5,
  });

  // Sanity check 3: red rectangle for each Sonnet region with the bbox we computed
  const scaleX = pageW / (visionParsed.page_width_pt || 612);
  const scaleY = pageH / (visionParsed.page_height_pt || 792);

  const drawnRegions = [];
  for (const r of visionParsed.regions || []) {
    const sx = r.bbox[0] * scaleX;
    const sy = r.bbox[1] * scaleY;
    const sw = r.bbox[2] * scaleX;
    const sh = r.bbox[3] * scaleY;
    const pdfBoxY = pageH - sy - sh;

    page.drawRectangle({
      x: sx,
      y: pdfBoxY,
      width: sw,
      height: sh,
      color: rgb(1, 0.5, 0.5),  // pinkish so we can see through
      opacity: 0.4,
      borderColor: rgb(1, 0, 0),
      borderWidth: 1,
    });

    drawnRegions.push({
      text: r.text.slice(0, 40),
      sonnetBbox: r.bbox,
      pdfLibBox: [sx, pdfBoxY, sw, sh],
    });
  }

  const finalBytes = await doc.save();

  // === Step 4: upload and return signed URL ===
  const outputPath = `pp-debug/${userData.user.id}/${Date.now()}-overlay.pdf`;
  const { error: upErr } = await supabase.storage.from('translation-jobs')
    .upload(outputPath, finalBytes, { contentType: 'application/pdf', upsert: true });
  if (upErr) return json(500, { error: 'Upload failed', details: upErr.message });

  const { data: signedData } = await supabase.storage
    .from('translation-jobs').createSignedUrl(outputPath, 3600);

  return json(200, {
    pdfUrl: signedData?.signedUrl || null,
    pageWidth: pageW,
    pageHeight: pageH,
    sonnetPageWidth: visionParsed.page_width_pt,
    sonnetPageHeight: visionParsed.page_height_pt,
    scaleX,
    scaleY,
    regionCount: drawnRegions.length,
    drawnRegions,
  });
}
