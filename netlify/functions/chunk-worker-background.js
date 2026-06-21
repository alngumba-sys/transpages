// netlify/functions/chunk-worker-background.js
//
// Processes ONE chunk:
//   1. Fetch parent job — glossary, target language, model preference
//   2. Mark chunk 'processing'
//   3. Download chunk PDF from Storage
//   4. Extract text via Haiku (always — fast)
//   5. Translate with chosen model (Haiku/Sonnet) + injected glossary
//   6. Save results to translation_chunks row

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-6';
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;

// Languages where Haiku is unreliable — auto-upgrade to Sonnet
const LOW_RESOURCE_LANGS = new Set([
  'amharic','tigrinya','oromo','swahili','kinyarwanda','chichewa','shona','xhosa','zulu',
  'yoruba','igbo','hausa','somali','malagasy','luganda','sesotho','tswana','maltese',
  'pashto','sindhi','uyghur','burmese','khmer','lao','sinhala','nepali','tibetan',
  'am','ti','om','sw','rw','ny','sn','xh','zu','yo','ig','ha','so','mg','lg','st','tn','mt','ps','sd','ug','my','km','lo','si','ne','bo'
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function callClaude(payload, attempt = 1) {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    const errMsg = (data?.error?.message || '').toLowerCase();
    const isRateLimit = resp.status === 429
      || errMsg.includes('rate limit')
      || errMsg.includes('rate_limit')
      || errMsg.includes('would exceed')
      || errMsg.includes('tokens per minute');
    const isTransient = resp.status >= 500 || isRateLimit;
    if (isTransient && attempt < MAX_RETRIES) {
      const baseDelay = isRateLimit ? 65000 : RETRY_BASE_MS;
      const delay = baseDelay * Math.pow(1.5, attempt - 1);
      console.log(`Claude ${resp.status} (${isRateLimit ? 'rate-limited' : 'transient'}), retrying after ${delay}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(delay);
      return callClaude(payload, attempt + 1);
    }
    throw new Error(data?.error?.message || `Anthropic error ${resp.status}`);
  }
  return data;
}

function extractText(claudeResp) {
  if (!claudeResp?.content) return '';
  return claudeResp.content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// Build the translation system prompt with glossary entries baked in
function buildTranslationSystemPrompt(targetLang, glossary) {
  let prompt = 'You are a professional translator. Return ONLY the translated text. ' +
    'Preserve formatting, line breaks, lists, structure. ' +
    'Keep proper nouns, numbers, URLs, and code unchanged.';

  if (glossary && glossary.length > 0) {
    const entries = glossary.slice(0, 100); // safety cap
    prompt += '\n\nGLOSSARY (mandatory term translations — use these exact mappings whenever the source term appears, ' +
      'matching case-insensitively):\n';
    for (const e of entries) {
      if (!e || !e.source_text || !e.target_text) continue;
      prompt += `- "${e.source_text}" → "${e.target_text}"\n`;
    }
    prompt += '\nWhen translating, replace each source term above with its mapped translation, ' +
      'even if the model would have translated it differently otherwise.';
  }

  return prompt;
}

function pickModel(targetLang, modelPreference) {
  const langLower = (targetLang || '').toLowerCase();
  if (modelPreference === 'sonnet') return MODEL_SONNET;
  if (modelPreference === 'haiku') return MODEL_HAIKU;
  if (LOW_RESOURCE_LANGS.has(langLower)) return MODEL_SONNET;
  return MODEL_HAIKU;
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { jobId, chunkIndex, chunkPath, targetLang, service } = body;
  if (!jobId || chunkIndex === undefined || !chunkPath) {
    return { statusCode: 400, body: 'Missing required fields' };
  }
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: 'Server missing env vars' };
  }

  const supabase = makeServiceClient();

  try {
    // Fetch parent job: status + glossary + model preference
    let job = null;
    const { data: jobData, error: jobErr } = await supabase
      .from('translation_jobs')
      .select('status, model_preference, meta')
      .eq('id', jobId)
      .single();
    if (jobErr) {
      console.warn('Could not fetch job:', jobErr.message);
    } else {
      job = jobData;
    }
    if (job?.status === 'cancelled') {
      return { statusCode: 200, body: 'Cancelled' };
    }

    const glossary = (job?.meta && Array.isArray(job.meta.glossary)) ? job.meta.glossary : [];
    const modelPreference = job?.model_preference || 'haiku';
    const model = pickModel(targetLang, modelPreference);

    // Mark chunk processing
    let currentAttempts = 0;
    {
      const { data: existing } = await supabase.from('translation_chunks')
        .select('attempts').eq('job_id', jobId).eq('chunk_index', chunkIndex).single();
      currentAttempts = (existing?.attempts || 0) + 1;
    }
    await supabase.from('translation_chunks')
      .update({ status: 'processing', attempts: currentAttempts })
      .eq('job_id', jobId).eq('chunk_index', chunkIndex);

    // Download chunk PDF
    const { data: blob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(chunkPath);
    if (dlErr || !blob) throw new Error(`Download failed: ${dlErr?.message || 'no data'}`);

    const buffer = Buffer.from(await blob.arrayBuffer());
    const base64 = buffer.toString('base64');

    // Step A: Extract text (always Haiku — fast)
    const extractResp = await callClaude({
      model: MODEL_HAIKU,
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: 'Extract ALL text from this PDF section. Preserve structure: paragraphs, headings, bullet points, tables. Return ONLY the extracted text — no commentary.' },
        ],
      }],
    });
    const extracted = extractText(extractResp).trim();
    if (!extracted) throw new Error('No text extracted from chunk.');

    let translated = '';

    if (service === 'translate-pdf' && targetLang) {
      // Step B: Translate using chosen model + glossary-aware system prompt
      const translateResp = await callClaude({
        model: model,
        max_tokens: 8192,
        system: buildTranslationSystemPrompt(targetLang, glossary),
        messages: [{
          role: 'user',
          content: `Translate the following text to ${targetLang}.\n\n${extracted}`,
        }],
      });
      translated = extractText(translateResp).trim();
    } else {
      translated = extracted;
    }

    // Save result
    await supabase.from('translation_chunks').update({
      status: 'completed',
      extracted_text: extracted,
      translated_text: translated,
    }).eq('job_id', jobId).eq('chunk_index', chunkIndex);

    // Best-effort: record which model was used
    if (model !== MODEL_HAIKU) {
      supabase.from('translation_jobs')
        .update({ model_used: model })
        .eq('id', jobId)
        .then(() => {}, () => {});
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error(`Chunk ${chunkIndex} failed:`, err);
    await supabase.from('translation_chunks').update({
      status: 'failed',
      error_message: String(err.message || err).slice(0, 1000),
    }).eq('job_id', jobId).eq('chunk_index', chunkIndex);
    return { statusCode: 500, body: 'Chunk failed' };
  }
}
