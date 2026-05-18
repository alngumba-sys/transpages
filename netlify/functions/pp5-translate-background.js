// pp5-translate-background.js
// Translates paragraphs in batches of 20, maintaining index mapping
// so each translated paragraph can be placed at its source bbox.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

const MODEL       = 'claude-haiku-4-5-20251001';
const BATCH_SIZE  = 20;
const MAX_TOKENS  = 4096;

export async function translateParagraphs(paragraphs, targetLang) {
  if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
  if (!paragraphs.length) return [];

  const results = new Array(paragraphs.length);

  // Pre-fill locked translations (not sent to Claude)
  const LOCKED_SIGNOFF = /^(sincerely|best regards|yours faithfully|regards),?$/i;
  const LOCKED_SALUTATION = /^dear\s+sir\/?madam,?$/i;
  const lockedIndices = new Set();
  for (let i = 0; i < paragraphs.length; i++) {
    const src = (paragraphs[i].text || '').trim();
    if (LOCKED_SIGNOFF.test(src)) {
      results[i] = 'Cordialement,';
      lockedIndices.add(i);
      console.log(`  Locked [${i}]: "${src}" → "Cordialement,"`);
    } else if (LOCKED_SALUTATION.test(src)) {
      results[i] = 'Madame, Monsieur,';
      lockedIndices.add(i);
      console.log(`  Locked [${i}]: "${src}" → "Madame, Monsieur,"`);
    }
  }

  // Process in batches (excluding locked paragraphs)
  for (let batchStart = 0; batchStart < paragraphs.length; batchStart += BATCH_SIZE) {
    const batch = paragraphs.slice(batchStart, batchStart + BATCH_SIZE);
    const batchItems = batch.map((p, i) => ({ p, globalIdx: batchStart + i }))
      .filter(item => !lockedIndices.has(item.globalIdx));

    if (batchItems.length === 0) {
      console.log(`Translated batch ${batchStart}–${batchStart + batch.length - 1} of ${paragraphs.length} (all locked)`);
      continue;
    }

    const numbered = batchItems.map(item => `[${item.globalIdx}] ${item.p.text}`).join('\n');

    const systemPrompt = `You translate document paragraphs into ${targetLang}.
Return ONLY a JSON array of translated strings, one per input paragraph, in the same order.
Preserve: numbers, dates, proper nouns, email addresses, URLs, phone numbers, codes, IDs.
Keep translations concise — they must fit in the same visual space as the original.
Do NOT add commentary, explanations, or extra text.
Return ONLY valid JSON: ["translation 0", "translation 1", ...]`;

    const userPrompt = `Translate each numbered paragraph into ${targetLang}.\nReturn a JSON array with ${batchItems.length} strings.\n\n${numbered}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text().then(t => t.slice(0, 200))}`);
    const data = await resp.json();
    const raw = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();

    // Parse JSON response
    let translations;
    try {
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      translations = JSON.parse(clean);
    } catch {
      console.error('Failed to parse batch translation JSON:', raw.slice(0, 200));
      // Fallback: use original text for failed batch
      translations = batchItems.map(item => item.p.text);
    }

    // Log batch size vs response size
    console.log(`Translated batch ${batchStart}–${batchStart + batch.length - 1} of ${paragraphs.length}: sent=${batchItems.length}, received=${translations.length}${translations.length < batchItems.length ? ' ⚠️ MISMATCH' : ''}`);

    // Map back to global indices (only non-locked items)
    for (let i = 0; i < batchItems.length; i++) {
      if (i >= translations.length) {
        console.warn(`  ⚠️ Missing translation for [${batchItems[i].globalIdx}]: "${batchItems[i].p.text.slice(0, 50)}"`);
      }
      results[batchItems[i].globalIdx] = translations[i] || batchItems[i].p.text;
    }
  }

  // Post-process: merge consecutive "Madame," + "Monsieur," fragments
  const SALUT = /^(madame|monsieur),?$/i;
  for (let i = 0; i < results.length - 1; i++) {
    const cur = (results[i] || '').trim();
    const next = (results[i + 1] || '').trim();
    if (SALUT.test(cur) && SALUT.test(next)) {
      results[i] = cur.replace(/,?\s*$/, ', ') + next;
      results[i + 1] = ''; // blank out the merged duplicate
      console.log(`  Merged salutation: "${cur}" + "${next}" → "${results[i]}"`);
    }
  }

  return results;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { jobId } = body;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const { data: job } = await supabase.from('translation_jobs')
      .select('target_lang, metadata').eq('id', jobId).single();

    const dataPath = job.metadata?.pp5_paragraphs_path;
    if (!dataPath) throw new Error('No pp5_paragraphs_path in metadata');

    const { data: blob } = await supabase.storage.from('translation-jobs').download(dataPath);
    const { paragraphs, pageCount, pageDims } = JSON.parse(await blob.text());

    const translations = await translateParagraphs(paragraphs, job.target_lang);

    // Merge translations back into paragraph objects
    const translated = paragraphs.map((p, i) => ({ ...p, translatedText: translations[i] }));

    const translatedPath = `pp5-translated/${jobId}/translated.json`;
    await supabase.storage.from('translation-jobs')
      .upload(translatedPath, JSON.stringify({ translated, pageCount, pageDims }), { upsert: true });

    await supabase.from('translation_jobs').update({
      metadata: { ...job.metadata, pp5_translated_path: translatedPath },
    }).eq('id', jobId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, translated: translated.length }) };
  } catch (err) {
    console.error('pp5-translate failed:', err);
    await supabase.from('translation_jobs').update({
      status: 'failed', error_message: err.message.slice(0, 500), completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    return { statusCode: 500, body: err.message };
  }
}
