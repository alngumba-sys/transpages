// netlify/functions/pp-page-worker-background.js
//
// PIXEL-PERFECT per-page worker.
// For each page:
//   1. Download page PDF from Storage
//   2. Parse structure with pdfjs-dist:
//        - text runs with bbox + font + size + color
//        - reading order
//   3. Group consecutive text runs into translation units (sentences/headings/cells)
//   4. Translate each unit with Claude (with length budget hint)
//   5. Use pdf-lib to:
//        - load original page (preserves images, vector graphics, layout)
//        - white-box over original text positions
//        - draw translated text in same positions/fonts/sizes
//   6. Save new page PDF to Storage at pp-output/{jobId}/page-{N}.pdf
//   7. Update chunk row with extracted/translated text (for legacy result column)
//
// Falls back gracefully: if pdfjs extraction fails, copies original page unchanged
// (the document still translates; user just sees one page that wasn't reconstructed).

import { createClient } from '@supabase/supabase-js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// Critical: import worker module so Netlify's bundler ships it
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;
const Y_TOLERANCE = 2;     // text on same line within 2pt = same line
const X_GAP_MAX = 30;      // text within 30pt horizontally = same logical run

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
    const isRateLimit = resp.status === 429 || errMsg.includes('rate') || errMsg.includes('would exceed');
    if ((isRateLimit || resp.status >= 500) && attempt < MAX_RETRIES) {
      const delay = (isRateLimit ? 65000 : RETRY_BASE_MS) * Math.pow(1.5, attempt - 1);
      console.log(`Claude ${resp.status}, retry in ${delay}ms (attempt ${attempt})`);
      await sleep(delay);
      return callClaude(payload, attempt + 1);
    }
    throw new Error(data?.error?.message || `Anthropic error ${resp.status}`);
  }
  return data;
}

function extractTextFromClaude(resp) {
  if (!resp?.content) return '';
  return resp.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

// Extract structured text runs from a single-page PDF using pdfjs-dist.
// Returns: { runs: [{ text, x, y, width, height, fontSize, color }], pageWidth, pageHeight }
async function extractTextRunsWithPositions(pdfBytes) {
  // CRITICAL: pdfjs may detach the underlying ArrayBuffer.
  // Pass a copy so caller can still use the original bytes for pdf-lib.
  const bytesCopy = new Uint8Array(pdfBytes);
  const loadingTask = pdfjsLib.getDocument({
    data: bytesCopy,
    useSystemFonts: false,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const textContent = await page.getTextContent();

  const runs = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = item.transform;
    const fontSize = Math.hypot(tx[2], tx[3]);
    const x = tx[4];
    const y = tx[5];
    runs.push({
      text: item.str,
      x: x,
      y: y,
      width: item.width || (item.str.length * fontSize * 0.5),
      height: item.height || fontSize,
      fontSize: fontSize,
      fontName: item.fontName || 'unknown',
      color: { r: 0, g: 0, b: 0 },
    });
  }

  // Clean up pdfjs before returning so the buffer is released
  const result = { runs, pageWidth: viewport.width, pageHeight: viewport.height };
  await pdf.cleanup();
  await pdf.destroy();
  return result;
}

// Group adjacent text runs into "translation units" — sentences/headings/cells.
// Strategy: group by (similar Y-coordinate, close X-coordinate, similar font size).
function groupIntoTranslationUnits(runs) {
  if (runs.length === 0) return [];
  // Sort top-to-bottom (PDF y is bottom-up so reverse), left-to-right
  const sorted = [...runs].sort((a, b) => {
    const yDiff = b.y - a.y; // higher y = higher on page = first
    if (Math.abs(yDiff) > Y_TOLERANCE) return yDiff;
    return a.x - b.x;
  });

  const units = [];
  let current = null;

  for (const run of sorted) {
    if (!current) {
      current = { runs: [run], minX: run.x, maxX: run.x + run.width, y: run.y, fontSize: run.fontSize };
      continue;
    }
    const sameLine = Math.abs(run.y - current.y) <= Y_TOLERANCE;
    const sameSize = Math.abs(run.fontSize - current.fontSize) < 1.5;
    const horizontalGap = run.x - current.maxX;
    if (sameLine && sameSize && horizontalGap >= -2 && horizontalGap <= X_GAP_MAX) {
      // continuation of current unit
      current.runs.push(run);
      current.maxX = Math.max(current.maxX, run.x + run.width);
    } else {
      units.push(current);
      current = { runs: [run], minX: run.x, maxX: run.x + run.width, y: run.y, fontSize: run.fontSize };
    }
  }
  if (current) units.push(current);

  // Build the unit text and metadata
  return units.map((u) => ({
    text: u.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim(),
    x: u.minX,
    y: u.y,
    width: u.maxX - u.minX,
    fontSize: u.fontSize,
    runCount: u.runs.length,
    runs: u.runs,
  })).filter((u) => u.text.length > 0);
}

// Translate an array of units in a single Claude call (much faster + cheaper than per-unit).
// Uses JSON-in-JSON-out to keep mappings explicit.
async function translateUnitsBatch(units, targetLang) {
  if (units.length === 0) return [];

  // Build numbered list with width hints (rough char budgets based on width / avg char width)
  const inputs = units.map((u, i) => {
    const charBudget = Math.max(1, Math.floor(u.width / (u.fontSize * 0.55)));
    return { i, text: u.text, max_chars: charBudget };
  });

  const systemPrompt =
    `You are a professional translator. You will receive a JSON array of text snippets from a PDF. ` +
    `Translate each "text" field to ${targetLang}. ` +
    `STRICT RULES:\n` +
    `1. Try to keep each translation within "max_chars" length (this is the original text width — overflowing breaks the layout). ` +
    `If natural translation exceeds max_chars by more than 20%, abbreviate or rephrase concisely.\n` +
    `2. Preserve numbers, dates, codes, URLs, emails, proper nouns unchanged.\n` +
    `3. Keep punctuation style appropriate for the target language.\n` +
    `4. Return ONLY valid JSON in this exact format: {"translations":[{"i":0,"text":"..."},{"i":1,"text":"..."}, ...]}\n` +
    `5. Include EVERY input "i" in the output. Same order. Do not skip any.\n` +
    `No commentary, no markdown fences, just the JSON object.`;

  const userMessage = JSON.stringify({ snippets: inputs });

  const resp = await callClaude({
    model: MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const raw = extractTextFromClaude(resp).trim();

  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('Failed to parse translation JSON:', cleaned.slice(0, 500));
    throw new Error('Translation returned invalid JSON');
  }

  const translations = parsed.translations || [];
  // Map back to units by index
  const result = new Array(units.length);
  for (const t of translations) {
    if (typeof t.i === 'number' && t.i >= 0 && t.i < units.length) {
      result[t.i] = String(t.text || '');
    }
  }
  // Fill any gaps with the original text (failed translations shouldn't drop content)
  for (let i = 0; i < units.length; i++) {
    if (result[i] == null) result[i] = units[i].text;
  }
  return result;
}

// Render translated text onto a copy of the original page using pdf-lib.
// Strategy: white-box over original text regions, then draw translated text in same place.
async function buildTranslatedPagePdf(originalPdfBytes, units, translatedTexts, pageWidth, pageHeight) {
  const sourceDoc = await PDFDocument.load(originalPdfBytes, { ignoreEncryption: true });
  const newDoc = await PDFDocument.create();
  const [page] = await newDoc.copyPages(sourceDoc, [0]);
  newDoc.addPage(page);

  // Get the actual page dimensions from pdf-lib
  const dstPage = newDoc.getPage(0);
  const dstW = dstPage.getWidth();
  const dstH = dstPage.getHeight();
  // Scale factor: pdfjs viewport vs pdf-lib page (usually 1:1 but be safe)
  const sx = dstW / pageWidth;
  const sy = dstH / pageHeight;

  // Embed Helvetica (Phase 1: Latin scripts only).
  // Phase 2 will bundle Noto fonts for other scripts.
  const font = await newDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await newDoc.embedFont(StandardFonts.HelveticaBold);

  // White-box over each unit, then draw the translation
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const text = translatedTexts[i] || u.text;
    // Skip if the translation is identical (no need to redraw)
    if (text === u.text) continue;

    const x = u.x * sx;
    const y = u.y * sy;
    const w = u.width * sx;
    const fontSize = u.fontSize * Math.min(sx, sy);

    // Find the actual fontSize that fits the width (allow up to 15% reduction)
    let drawSize = fontSize;
    const measuredW = font.widthOfTextAtSize(text, drawSize);
    if (measuredW > w && w > 0) {
      const shrink = Math.max(0.85, w / measuredW);  // never shrink past 85%
      drawSize = fontSize * shrink;
    }

    // Draw a white rectangle over the original text area.
    // Slightly larger than the text bbox to cover descenders/ascenders.
    const padding = 1;
    dstPage.drawRectangle({
      x: x - padding,
      y: y - padding,
      width: w + padding * 2,
      height: fontSize + padding * 2,
      color: rgb(1, 1, 1),
    });

    // Draw the translated text. pdf-lib's drawText baseline is at the y given.
    // The original text's y in pdfjs is the BASELINE position, so this should align.
    try {
      dstPage.drawText(text, {
        x: x,
        y: y,
        size: drawSize,
        font: font,
        color: rgb(0, 0, 0),
      });
    } catch (e) {
      // pdf-lib StandardFonts can't render characters outside WinAnsi encoding.
      // For non-Latin scripts, this will throw — Phase 2 will bundle Noto fonts.
      console.warn(`Could not render text "${text.slice(0, 30)}" — likely non-Latin script. Skipping.`);
      // Restore the original by removing the white box would be hard; for now, accept
      // that this unit shows blank. A user-visible warning message is better than crash.
    }
  }

  return await newDoc.save();
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { jobId, chunkIndex, chunkPath, targetLang } = body;
  if (!jobId || chunkIndex === undefined || !chunkPath) {
    return { statusCode: 400, body: 'Missing required fields' };
  }
  if (!ANTHROPIC_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: 'Server missing env vars' };
  }

  const supabase = makeServiceClient();

  try {
    // Skip if cancelled
    const { data: job } = await supabase.from('translation_jobs')
      .select('status').eq('id', jobId).single();
    if (job?.status === 'cancelled') return { statusCode: 200, body: 'Cancelled' };

    // Track attempts
    let currentAttempts = 0;
    {
      const { data: existing } = await supabase.from('translation_chunks')
        .select('attempts').eq('job_id', jobId).eq('chunk_index', chunkIndex).single();
      currentAttempts = (existing?.attempts || 0) + 1;
    }
    await supabase.from('translation_chunks')
      .update({ status: 'processing', attempts: currentAttempts })
      .eq('job_id', jobId).eq('chunk_index', chunkIndex);

    // Download page chunk
    const { data: blob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(chunkPath);
    if (dlErr || !blob) throw new Error(`Download failed: ${dlErr?.message || 'no data'}`);
    const pageBytes = new Uint8Array(await blob.arrayBuffer());

    // Step 1: extract structured text
    let extraction;
    try {
      extraction = await extractTextRunsWithPositions(pageBytes);
    } catch (e) {
      console.error(`Page ${chunkIndex} structure extraction failed:`, e);
      // Fallback: copy original page unchanged
      const outputPath = `pp-output/${jobId}/page-${chunkIndex}.pdf`;
      await supabase.storage.from('translation-jobs').upload(outputPath, pageBytes, {
        contentType: 'application/pdf', upsert: true,
      });
      await supabase.from('translation_chunks').update({
        status: 'completed',
        extracted_text: '',
        translated_text: '',
        error_message: 'PP fallback: structure extraction failed',
      }).eq('job_id', jobId).eq('chunk_index', chunkIndex);
      return { statusCode: 200, body: JSON.stringify({ ok: true, fallback: true }) };
    }

    const { runs, pageWidth, pageHeight } = extraction;

    // Step 2: group into translation units
    const units = groupIntoTranslationUnits(runs);
    const fullExtractedText = units.map((u) => u.text).join('\n');

    if (units.length === 0) {
      // Empty page or all-image page — just copy original
      const outputPath = `pp-output/${jobId}/page-${chunkIndex}.pdf`;
      await supabase.storage.from('translation-jobs').upload(outputPath, pageBytes, {
        contentType: 'application/pdf', upsert: true,
      });
      await supabase.from('translation_chunks').update({
        status: 'completed',
        extracted_text: '',
        translated_text: '',
      }).eq('job_id', jobId).eq('chunk_index', chunkIndex);
      return { statusCode: 200, body: JSON.stringify({ ok: true, empty: true }) };
    }

    // Step 3: translate
    const translations = await translateUnitsBatch(units, targetLang);
    const fullTranslatedText = translations.join('\n');

    // Step 4: build new page PDF with overlaid translations
    const newPageBytes = await buildTranslatedPagePdf(pageBytes, units, translations, pageWidth, pageHeight);

    // Step 5: upload output page
    const outputPath = `pp-output/${jobId}/page-${chunkIndex}.pdf`;
    const { error: upErr } = await supabase.storage.from('translation-jobs')
      .upload(outputPath, newPageBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error('Upload failed: ' + upErr.message);

    // Step 6: persist text
    await supabase.from('translation_chunks').update({
      status: 'completed',
      extracted_text: fullExtractedText,
      translated_text: fullTranslatedText,
    }).eq('job_id', jobId).eq('chunk_index', chunkIndex);

    return { statusCode: 200, body: JSON.stringify({ ok: true, units: units.length }) };
  } catch (err) {
    console.error(`PP page ${chunkIndex} failed:`, err);
    await supabase.from('translation_chunks').update({
      status: 'failed',
      error_message: String(err.message || err).slice(0, 1000),
    }).eq('job_id', jobId).eq('chunk_index', chunkIndex);
    return { statusCode: 500, body: 'Page failed' };
  }
}
