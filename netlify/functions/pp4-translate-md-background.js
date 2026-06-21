import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

const TRANSLATE_MODEL = 'claude-haiku-4-5-20251001';
const QUALITY_MODEL   = 'claude-sonnet-4-6';
const MAX_TOKENS_OUT  = 8192;

const LOW_RESOURCE_LANGS = new Set([
  'sw','am','om','ti','so','rw','lg','yo','ig','zu','xh','ha',
  'mg','ny','sn','st','tn','ts','ve','wo','ff'
]);

function pickModel(targetLangCode, modelPref) {
  if (modelPref === 'best') return QUALITY_MODEL;
  if (modelPref === 'fast') return TRANSLATE_MODEL;
  if (LOW_RESOURCE_LANGS.has((targetLangCode || '').toLowerCase())) return QUALITY_MODEL;
  return TRANSLATE_MODEL;
}

export async function translateMarkdown(markdown, targetLang, options = {}) {
  if (!ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
  const model = pickModel(options.langCode, options.modelPref || 'auto');

  const systemPrompt = `You translate markdown documents into ${targetLang}. CRITICAL RULES:
1. PRESERVE ALL markdown syntax exactly: <figure>, <table>, <tr>, <th>, <td>, <img>, <!-- PageBreak -->, lists, headings (#), code blocks, links
2. PRESERVE <img> tags exactly including src attribute and alt text — never modify, translate, or remove them
3. PRESERVE __FIGURE_N__ placeholder tokens (where N is a number) EXACTLY — these are critical references that must not change
2. PRESERVE ALL non-text symbols: ☐, ☒, ✓, $, currency symbols, emojis
3. PRESERVE ALL: numbers, dates, codes, URLs, email addresses, phone numbers, account numbers, IDs, registration numbers
4. PRESERVE proper nouns: company names, person names, place names, brand names, product names
5. ONLY translate visible human-readable text content
6. DO NOT add commentary, explanations, or markdown fences around the output
7. DO NOT change the structure: same number of paragraphs, same line breaks, same tables
8. For checkbox labels, translate the LABEL but keep the ☐/☒ symbol unchanged
9. For closings (Sincerely, Regards, etc.), use the most natural single-word equivalent in ${targetLang}
10. The placeholder [signed] represents a handwritten signature — keep it EXACTLY as [signed], do not translate it
11. Return ONLY the translated markdown — no preamble, no explanations, nothing else`;

  const userPrompt = `Translate the following markdown document into ${targetLang}. Output ONLY the translated markdown — no preamble, no fences, no markers, no commentary.

${markdown}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS_OUT,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  let translated = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  // Strip any stray markers Claude might add
  translated = translated.replace(/^---\s*(SOURCE\s*)?MARKDOWN\s*---\s*/gim, '');
  translated = translated.replace(/\s*---\s*END\s*---\s*$/gi, '');
  translated = translated.replace(/^```(?:markdown|md)?\s*\n/gim, '');
  translated = translated.replace(/\n```\s*$/gi, '');
  translated = translated.trim();

  return {
    translated,
    model,
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { jobId } = body;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  try {
    const { data: job, error: jobErr } = await supabase
      .from('translation_jobs')
      .select('target_lang, model_preference, metadata')
      .eq('id', jobId).single();
    if (jobErr) throw new Error('Job lookup failed: ' + jobErr.message);

    const mdPath = job.metadata?.extracted_md_path;
    if (!mdPath) throw new Error('No extracted_md_path in job metadata');

    const { data: mdBlob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(mdPath);
    if (dlErr || !mdBlob) throw new Error('Markdown download failed: ' + (dlErr?.message || 'no data'));
    const markdown = await mdBlob.text();

    console.log(`PP4 translate: job=${jobId} md_size=${markdown.length} target=${job.target_lang}`);
    const startTime = Date.now();
    const { translated, model, inputTokens, outputTokens } = await translateMarkdown(markdown, job.target_lang, {
      langCode: job.target_lang,
      modelPref: job.model_preference,
    });
    const elapsed = Date.now() - startTime;
    console.log(`PP4 translate: complete in ${elapsed}ms model=${model} in=${inputTokens} out=${outputTokens}`);

    const translatedMdPath = `pp4-translated/${jobId}/translated.md`;
    const { error: upErr } = await supabase.storage.from('translation-jobs')
      .upload(translatedMdPath, new Blob([translated], { type: 'text/markdown' }), { upsert: true });
    if (upErr) throw new Error('Translated markdown upload failed: ' + upErr.message);

    await supabase.from('translation_jobs').update({
      result_text: translated,
      model_used: model,
      metadata: {
        ...(job.metadata || {}),
        translated_md_path: translatedMdPath,
        translate_input_tokens: inputTokens,
        translate_output_tokens: outputTokens,
        translate_ms: elapsed,
      },
    }).eq('id', jobId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, translatedMdPath, mdBytes: translated.length }) };
  } catch (err) {
    console.error('pp4-translate failed:', err);
    await supabase.from('translation_jobs').update({
      status: 'failed',
      error_message: 'Translate: ' + (err.message || String(err)).slice(0, 500),
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    return { statusCode: 500, body: 'Translate failed' };
  }
}
