// netlify/functions/translate.js
//
// Single backend endpoint for AI features. Routes by `mode` field.
// Used for short text translations (incl. guest mode) and legacy callers.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// Guest mode caps — guests can't abuse the endpoint
const GUEST_MAX_CHARS = 500;
const GUEST_MAX_TOKENS = 600;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    body: JSON.stringify(body),
  };
}

async function callClaude({ messages, system, model, maxTokens }) {
  // Use CLAUDE_API_KEY (current convention) with ANTHROPIC_API_KEY fallback
  const apiKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Server is not configured: CLAUDE_API_KEY missing.');
  }
  const payload = {
    model: model || DEFAULT_MODEL,
    max_tokens: maxTokens || 4096,
    messages,
  };
  if (system) payload.system = system;

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  if (!resp.ok) {
    const msg = (data && data.error && data.error.message) || `Anthropic API error: ${resp.status}`;
    const err = new Error(msg);
    err.statusCode = resp.status;
    err.upstream = data;
    throw err;
  }
  return data;
}

function extractText(claudeResponse) {
  if (!claudeResponse || !Array.isArray(claudeResponse.content)) return '';
  return claudeResponse.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

// ---------- handlers per mode ----------

async function handleTranslateText({ text, targetLang, isGuest }) {
  if (!text || !targetLang) {
    return jsonResponse(400, { error: 'Both `text` and `targetLang` are required.' });
  }
  // Hard cap for guest mode — never trust client-side limits
  if (isGuest && text.length > GUEST_MAX_CHARS) {
    return jsonResponse(413, {
      error: `Guest demo limited to ${GUEST_MAX_CHARS} characters. Sign up free for longer translations.`,
    });
  }
  const data = await callClaude({
    system:
      'You are a professional translator. Return ONLY the translated text. Preserve formatting, line breaks, lists, and structure. Keep proper nouns, numbers, URLs, and code unchanged.',
    messages: [
      {
        role: 'user',
        content: `Translate the following text to ${targetLang}.\n\n${text}`,
      },
    ],
    maxTokens: isGuest ? GUEST_MAX_TOKENS : 4096,
  });
  return jsonResponse(200, { content: data.content, text: extractText(data), usage: data.usage });
}

async function handleExtractPDF({ pdfBase64 }) {
  if (!pdfBase64) return jsonResponse(400, { error: '`pdfBase64` is required.' });
  const data = await callClaude({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: 'Extract ALL text from this PDF. Preserve paragraph breaks and structure. Return ONLY the extracted text — no commentary.' },
        ],
      },
    ],
  });
  return jsonResponse(200, { content: data.content, text: extractText(data), usage: data.usage });
}

async function handleTranslatePDF({ pdfBase64, targetLang }) {
  if (!pdfBase64 || !targetLang) {
    return jsonResponse(400, { error: 'Both `pdfBase64` and `targetLang` are required.' });
  }
  const extractData = await callClaude({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: 'Extract ALL text from this PDF. Preserve structure and line breaks. Return ONLY the extracted text.' },
        ],
      },
    ],
  });
  const extractedText = extractText(extractData);
  if (!extractedText.trim()) {
    return jsonResponse(422, { error: 'Could not extract any text from the PDF.' });
  }
  const translateData = await callClaude({
    system:
      'You are a professional translator. Return ONLY the translated text. Preserve formatting, line breaks, lists, and structure. Keep proper nouns, numbers, URLs, and code unchanged.',
    messages: [
      { role: 'user', content: `Translate the following text to ${targetLang}.\n\n${extractedText}` },
    ],
  });
  return jsonResponse(200, {
    extractedText,
    translatedText: extractText(translateData),
    content: translateData.content,
    usage: translateData.usage,
  });
}

async function handleOCR({ imageBase64, mediaType }) {
  if (!imageBase64) return jsonResponse(400, { error: '`imageBase64` is required.' });
  const data = await callClaude({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Extract all text visible in this image. Preserve structure. Return ONLY the extracted text.' },
        ],
      },
    ],
  });
  return jsonResponse(200, { content: data.content, text: extractText(data), usage: data.usage });
}

async function handleTranscribe() {
  return jsonResponse(501, {
    error: 'Audio transcription is not yet wired up in this endpoint.',
  });
}

async function handleSummarize({ text }) {
  if (!text) return jsonResponse(400, { error: '`text` is required.' });
  const data = await callClaude({
    system: 'You are a helpful summarizer. Return a concise summary that preserves the key points and structure of the input.',
    messages: [{ role: 'user', content: `Summarize:\n\n${text}` }],
  });
  return jsonResponse(200, { content: data.content, text: extractText(data), usage: data.usage });
}

async function handleGeneric({ prompt, system, model, maxTokens }) {
  if (!prompt) return jsonResponse(400, { error: '`prompt` is required.' });
  const data = await callClaude({
    system,
    model,
    maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return jsonResponse(200, { content: data.content, text: extractText(data), usage: data.usage });
}

// ---------- entrypoint ----------

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed. Use POST.' });
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body.' });
  }

  // Backward-compat: requests with just { text, targetLang } default to translate-text
  if (!body.mode && body.text && body.targetLang) {
    body.mode = 'translate-text';
  }

  try {
    switch (body.mode) {
      case 'translate-text': return await handleTranslateText(body);
      case 'translate-pdf':  return await handleTranslatePDF(body);
      case 'extract-pdf':    return await handleExtractPDF(body);
      case 'ocr':            return await handleOCR(body);
      case 'transcribe':     return await handleTranscribe(body);
      case 'summarize':      return await handleSummarize(body);
      case 'generic':        return await handleGeneric(body);
      default:
        return jsonResponse(400, {
          error: `Unknown mode: ${body.mode || '(none)'}. Supported: translate-text, translate-pdf, extract-pdf, ocr, transcribe, summarize, generic.`,
        });
    }
  } catch (err) {
    console.error('translate.js error:', err);
    return jsonResponse(err.statusCode || 500, {
      error: err.message || 'Server error',
      upstream: err.upstream || null,
    });
  }
}
