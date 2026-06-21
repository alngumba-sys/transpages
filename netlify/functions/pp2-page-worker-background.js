// netlify/functions/pp2-page-worker-background.js
//
// PHASE 2C per-page worker — vision via direct PDF, pdf-lib overlay.
// No rasterization. No native deps. Just Sonnet + pdf-lib.

import { createClient } from '@supabase/supabase-js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_VISION = 'claude-sonnet-4-6';
const MODEL_TRANSLATE = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function callClaude(payload, attempt = 1, label = 'claude') {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeoutMs = 90000;  // 90 second hard timeout per call
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let resp, data;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    data = await resp.json();
  } catch (e) {
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;
    if (e.name === 'AbortError') {
      console.error(`${label} call timed out after ${elapsed}ms (attempt ${attempt})`);
      if (attempt < MAX_RETRIES) {
        await sleep(2000);
        return callClaude(payload, attempt + 1, label);
      }
      throw new Error(`${label} call timed out after ${MAX_RETRIES} attempts`);
    }
    console.error(`${label} call network error after ${elapsed}ms:`, e.message);
    throw e;
  }
  clearTimeout(timeoutId);

  const elapsed = Date.now() - startTime;
  console.log(`${label} call completed in ${elapsed}ms (attempt ${attempt})`);

  if (!resp.ok) {
    const errMsg = (data?.error?.message || '').toLowerCase();
    const isRateLimit = resp.status === 429 || errMsg.includes('rate') || errMsg.includes('would exceed');
    if ((isRateLimit || resp.status >= 500) && attempt < MAX_RETRIES) {
      // Cap rate-limit backoff at 30s to avoid runtime timeouts
      const delay = Math.min(30000, (isRateLimit ? 15000 : RETRY_BASE_MS) * Math.pow(1.5, attempt - 1));
      console.log(`${label} ${resp.status}, retry in ${delay}ms`);
      await sleep(delay);
      return callClaude(payload, attempt + 1, label);
    }
    throw new Error(data?.error?.message || `Anthropic error ${resp.status}`);
  }
  return data;
}

function extractTextFromClaude(resp) {
  if (!resp?.content) return '';
  return resp.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

async function detectRegionsViaPdfVision(pdfBytes) {
  const base64 = Buffer.from(pdfBytes).toString('base64');

  const systemPrompt =
    `You are analyzing a PDF document. For PAGE 1 ONLY, identify every text region.\n\n` +
    `For each text region return:\n` +
    `- bbox: [x, y, w, h] — bounding box on the PDF page\n` +
    `- text: exact text content\n` +
    `- font_size_pt: approximate font size in points\n` +
    `- bold: true if bold weight\n` +
    `- italic: true if italic\n` +
    `- underline: true if underlined\n` +
    `- align: "left" | "center" | "right" — text alignment within the region\n` +
    `- is_logo: true if part of a logo, watermark, letterhead graphic, or institutional badge\n` +
    `- is_signature: true if this is a handwritten signature\n\n` +
    `CRITICAL — COORDINATE SYSTEM:\n` +
    `- Use PDF POINT coordinates (1 pt = 1/72 inch)\n` +
    `- Origin at TOP-LEFT of page, x increases right, y increases DOWN\n` +
    `- US Letter is 612 x 792 points; A4 is 595 x 842 points\n\n` +
    `CRITICAL — ONE REGION PER VISUAL LINE:\n` +
    `Return EACH visual line as a SEPARATE region — never merge multiple lines into one region.\n` +
    `- "Kifiya Financial Technologies" on line 1 = its own region\n` +
    `- "Addis Ababa" on line 2 = its own region\n` +
    `- "Ethiopia" on line 3 = its own region\n` +
    `- "Nov-28-2024" on line 4 = its own region\n\n` +
    `EXCEPTION: A wrapped justified paragraph (multi-line body text where lines flow naturally) MAY be one region with \\n separators — but address blocks, headings, signature lines, dates must be one-region-per-line.\n\n` +
    `Each bbox must tightly enclose JUST that one line of text (including descenders).\n\n` +
    `Preserve formatting flags PER LINE: each line carries its own bold/italic/underline/align values.\n\n` +
    `Return ONLY this JSON (no markdown fences, no commentary):\n` +
    `{"page_width_pt":N,"page_height_pt":N,"regions":[{"bbox":[x,y,w,h],"text":"...","font_size_pt":N,"bold":bool,"italic":bool,"underline":bool,"align":"left","is_logo":bool,"is_signature":bool}]}`;

  const resp = await callClaude({
    model: MODEL_VISION,
    max_tokens: 16384,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: 'Analyze page 1 and return all text regions as JSON. Be concise — keep field names short, no extra whitespace.' },
      ],
    }],
  }, 1, 'vision');

  // If Sonnet hit the token limit, output is truncated and unparseable.
  if (resp?.stop_reason === 'max_tokens') {
    console.error('Vision response was truncated (hit max_tokens). Output sample:', extractTextFromClaude(resp).slice(0, 300));
    throw new Error('Vision response truncated (page too text-heavy for one call)');
  }

  const raw = extractTextFromClaude(resp).trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    // Last-ditch recovery: try to find a complete object by trimming after the last `}`
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace > 0) {
      const truncated = cleaned.slice(0, lastBrace + 1);
      const openRegionsIdx = truncated.indexOf('"regions":[');
      if (openRegionsIdx >= 0) {
        let depth = 0;
        let lastGoodEnd = -1;
        for (let i = openRegionsIdx; i < truncated.length; i++) {
          if (truncated[i] === '{') depth++;
          else if (truncated[i] === '}') {
            depth--;
            if (depth === 0) lastGoodEnd = i;
          }
        }
        if (lastGoodEnd > 0) {
          const repaired = truncated.slice(0, lastGoodEnd + 1) + ']}';
          try {
            parsed = JSON.parse(repaired);
            console.warn('Vision JSON was truncated; recovered partial result with', parsed.regions?.length || 0, 'regions');
          } catch (e2) {
            console.error('Vision returned invalid JSON. Sample:', cleaned.slice(0, 500));
            throw new Error('Vision returned invalid JSON');
          }
        }
      }
    }
    if (!parsed) {
      console.error('Vision returned invalid JSON. Sample:', cleaned.slice(0, 500));
      throw new Error('Vision returned invalid JSON');
    }
  }

  const regions = Array.isArray(parsed.regions) ? parsed.regions : [];
  const pageW = parsed.page_width_pt || 612;
  const pageH = parsed.page_height_pt || 792;
  const filtered = regions.filter((r) => {
    if (!Array.isArray(r.bbox) || r.bbox.length !== 4) return false;
    const [x, y, w, h] = r.bbox;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return false;
    if (w <= 0 || h <= 0) return false;
    if (x < -5 || y < -5 || x + w > pageW + 10 || y + h > pageH + 10) return false;
    if (typeof r.text !== 'string' || !r.text.trim()) return false;
    return true;
  });

  // POST-PROCESS: Merge regions that Sonnet split incorrectly.
  const merged = mergeAdjacentRegions(filtered);

  return { pageWidth: pageW, pageHeight: pageH, regions: merged };
}

// Merge regions that look like fragments of the same block.
// Heuristic: same x-start (within 8pt), similar font_size (within 2pt),
// same bold/logo/signature flags, vertical gap less than 1.5× line-height.
function mergeAdjacentRegions(regions) {
  if (regions.length <= 1) return regions;

  // Sort by y first, then x — top-to-bottom, left-to-right
  const sorted = [...regions].sort((a, b) => {
    const ay = a.bbox[1], by = b.bbox[1];
    if (Math.abs(ay - by) > 4) return ay - by;
    return a.bbox[0] - b.bbox[0];
  });

  const groups = [];
  for (const r of sorted) {
    let placed = false;
    for (const g of groups) {
      const last = g[g.length - 1];

      const sameX = Math.abs(r.bbox[0] - last.bbox[0]) <= 8;
      // For right-aligned text, x-start varies but right edge stays constant
      const sameRight = Math.abs((r.bbox[0] + r.bbox[2]) - (last.bbox[0] + last.bbox[2])) <= 8;
      const sameAlignment = sameX || sameRight;
      const sameFontSize = Math.abs((r.font_size_pt || 11) - (last.font_size_pt || 11)) <= 2;
      const sameBold = !!r.bold === !!last.bold;
      const sameLogo = !!r.is_logo === !!last.is_logo;
      const sameSig = !!r.is_signature === !!last.is_signature;

      // Vertical: r should start within 1.5× line-height of last's bottom
      const lastBottom = last.bbox[1] + last.bbox[3];
      const vGap = r.bbox[1] - lastBottom;
      const lineHeight = (last.font_size_pt || 11) * 1.4;
      const vAdjacent = vGap >= -2 && vGap < lineHeight * 1.5;

      if (sameAlignment && sameFontSize && sameBold && sameLogo && sameSig && vAdjacent) {
        g.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([r]);
  }

  // Convert each group to a single merged region
  return groups.map((g) => {
    if (g.length === 1) return g[0];
    const minX = Math.min(...g.map((r) => r.bbox[0]));
    const minY = Math.min(...g.map((r) => r.bbox[1]));
    const maxX = Math.max(...g.map((r) => r.bbox[0] + r.bbox[2]));
    const maxY = Math.max(...g.map((r) => r.bbox[1] + r.bbox[3]));
    return {
      bbox: [minX, minY, maxX - minX, maxY - minY],
      text: g.map((r) => r.text).join('\n'),
      font_size_pt: g[0].font_size_pt,
      bold: g[0].bold,
      is_logo: g[0].is_logo,
      is_signature: g[0].is_signature,
    };
  });
}

async function translateRegions(regions, targetLang, glossary) {
  const translatable = regions.map((r, i) => ({ idx: i, region: r, skip: r.is_logo || r.is_signature }));
  const toTranslate = translatable.filter((t) => !t.skip);

  if (toTranslate.length === 0) return regions.map((r) => r.text);

  const inputs = toTranslate.map((t) => ({ i: t.idx, text: t.region.text }));

  let glossaryHint = '';
  if (glossary && glossary.length > 0) {
    glossaryHint = '\n\nGLOSSARY (use these mappings whenever the source term appears):\n' +
      glossary.slice(0, 50).map((g) => `- "${g.source_text}" → "${g.target_text}"`).join('\n');
  }

  const systemPrompt =
    `You are a professional translator. You will receive a JSON array of text snippets from a PDF page.\n` +
    `Translate each "text" field to ${targetLang}.\n\n` +
    `RULES:\n` +
    `1. Preserve numbers, dates, codes, URLs, emails, proper nouns unchanged.\n` +
    `2. Keep translations roughly the same length as source — abbreviate if the translation would be much longer.\n` +
    `3. PRESERVE newlines: if the input contains "\\n" between lines, keep equivalent line breaks in output.\n` +
    `4. Return EVERY input "i" — same order. Do not skip any.\n` +
    `5. Return strict JSON only: {"translations":[{"i":N,"text":"..."}]}\n` +
    glossaryHint;

  const resp = await callClaude({
    model: MODEL_TRANSLATE,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: JSON.stringify({ snippets: inputs }) }],
  }, 1, 'translate');

  const raw = extractTextFromClaude(resp).trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    console.error('Translation returned invalid JSON:', cleaned.slice(0, 500));
    throw new Error('Translation returned invalid JSON');
  }

  const translations = parsed.translations || [];
  const result = new Array(regions.length);
  for (let i = 0; i < regions.length; i++) result[i] = regions[i].text;
  for (const t of translations) {
    if (typeof t.i === 'number' && t.i >= 0 && t.i < regions.length && typeof t.text === 'string') {
      if (!regions[t.i].is_logo && !regions[t.i].is_signature) {
        result[t.i] = t.text;
      }
    }
  }
  return result;
}

async function composeTranslatedPdf(originalPdfBytes, regions, translations, sonnetPageWidth, sonnetPageHeight) {
  const doc = await PDFDocument.load(originalPdfBytes, { ignoreEncryption: true });
  const page = doc.getPage(0);

  const pageActualW = page.getWidth();
  const pageActualH = page.getHeight();
  const scaleX = pageActualW / sonnetPageWidth;
  const scaleY = pageActualH / sonnetPageHeight;

  const fontRegular    = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold       = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic     = await doc.embedFont(StandardFonts.HelveticaOblique);
  const fontBoldItalic = await doc.embedFont(StandardFonts.HelveticaBoldOblique);

  function makeFontSafe(text, font) {
    const lines = text.split('\n');
    const safeLines = lines.map((line) => {
      try {
        font.widthOfTextAtSize(line, 12);
        return line;
      } catch (e) {
        let result = '';
        for (const ch of line) {
          try {
            font.widthOfTextAtSize(ch, 12);
            result += ch;
          } catch (e2) {
            result += '?';
          }
        }
        return result;
      }
    });
    return safeLines.join('\n');
  }

  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (r.is_logo || r.is_signature) continue;

    let text = String(translations[i] ?? '')
      .replace(/[\r\t\f\v]+/g, ' ')
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2013\u2014\u2015]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u2000-\u200F\u202F]/g, ' ')
      .replace(/[ ]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // FIX: Only skip if text is genuinely empty.
    // Previously we also skipped when text === r.text (unchanged translation),
    // which caused proper nouns and unchanged regions to get no white box drawn,
    // leaving original English text bleeding through underneath.
    if (!text) continue;

    const sx = r.bbox[0] * scaleX;
    const sy = r.bbox[1] * scaleY;
    const sw = r.bbox[2] * scaleX;
    const sh = r.bbox[3] * scaleY;

    // CRITICAL: Sonnet returned top-down Y; pdf-lib uses bottom-up Y
    const pdfBoxX = sx;
    const pdfBoxY = pageActualH - sy - sh;
    const pdfBoxW = sw;
    const pdfBoxH = sh;

    const fontPt = r.font_size_pt || 11;
    const lineHeightEstimate = fontPt * 1.4;
    const padX = Math.max(4, sw * 0.05);
    const numLines = (text || r.text || '').split('\n').length;
    const expectedHeight = numLines * lineHeightEstimate;
    const tightnessGap = Math.max(0, (expectedHeight - sh) / 2);
    const padY = Math.max(4, sh * 0.40, tightnessGap + 4);

    page.drawRectangle({
      x: pdfBoxX - padX,
      y: pdfBoxY - padY,
      width: pdfBoxW + padX * 2,
      height: pdfBoxH + padY * 2,
      color: rgb(1, 1, 1),
    });

    const fontSize = (r.font_size_pt || 11) * scaleY;
    // Pick correct font based on bold + italic flags
    let font;
    if (r.bold && r.italic)      font = fontBoldItalic;
    else if (r.bold)             font = fontBold;
    else if (r.italic)           font = fontItalic;
    else                         font = fontRegular;

    text = makeFontSafe(text, font);
    if (!text) continue;

    const paragraphs = text.split('\n');
    let drawSize = fontSize;

    // Shrink to fit if the longest paragraph is wider than the bbox
    let longestWidth = 0;
    for (const p of paragraphs) {
      const w = font.widthOfTextAtSize(p, drawSize);
      if (w > longestWidth) longestWidth = w;
    }
    if (longestWidth > pdfBoxW && pdfBoxW > 0) {
      const shrink = Math.max(0.75, pdfBoxW / longestWidth);
      drawSize = fontSize * shrink;
    }

    // Word-wrap any line that exceeds the bbox width
    const lines = [];
    for (const p of paragraphs) {
      if (font.widthOfTextAtSize(p, drawSize) <= pdfBoxW || pdfBoxW <= 0) {
        lines.push(p);
      } else {
        const words = p.split(/\s+/);
        let currentLine = '';
        for (const word of words) {
          const testLine = currentLine ? currentLine + ' ' + word : word;
          if (font.widthOfTextAtSize(testLine, drawSize) > pdfBoxW && currentLine) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        }
        if (currentLine) lines.push(currentLine);
      }
    }

    // Line spacing — single-line regions get exact height; multi-line uses 1.4x
    const lineHeight = lines.length === 1 ? pdfBoxH : drawSize * 1.4;
    let lineTopY = pdfBoxY + pdfBoxH;

    const align = r.align || 'left';
    for (const line of lines) {
      const baselineY = lineTopY - drawSize;
      // Compute x based on alignment
      let drawX = pdfBoxX;
      const lineWidth = font.widthOfTextAtSize(line, drawSize);
      if (align === 'center') {
        drawX = pdfBoxX + (pdfBoxW - lineWidth) / 2;
      } else if (align === 'right') {
        drawX = pdfBoxX + pdfBoxW - lineWidth;
      }

      page.drawText(line, {
        x: drawX, y: baselineY, size: drawSize, font, color: rgb(0, 0, 0),
      });

      // Underline support
      if (r.underline) {
        const underlineY = baselineY - drawSize * 0.12;
        page.drawLine({
          start: { x: drawX, y: underlineY },
          end:   { x: drawX + lineWidth, y: underlineY },
          thickness: Math.max(0.5, drawSize * 0.06),
          color: rgb(0, 0, 0),
        });
      }

      lineTopY -= lineHeight;
    }
  }

  return await doc.save();
}

export async function handler(event) {
  const handlerStartTime = Date.now();
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

  console.log(`PP2 worker started: job=${jobId} page=${chunkIndex}`);
  const supabase = makeServiceClient();

  try {
    const { data: job } = await supabase.from('translation_jobs')
      .select('status, meta').eq('id', jobId).single();
    if (job?.status === 'cancelled') return { statusCode: 200, body: 'Cancelled' };
    const glossary = (job?.meta && Array.isArray(job.meta.glossary)) ? job.meta.glossary : [];

    let currentAttempts = 0;
    {
      const { data: existing } = await supabase.from('translation_chunks')
        .select('attempts').eq('job_id', jobId).eq('chunk_index', chunkIndex).single();
      currentAttempts = (existing?.attempts || 0) + 1;
    }
    await supabase.from('translation_chunks')
      .update({ status: 'processing', attempts: currentAttempts })
      .eq('job_id', jobId).eq('chunk_index', chunkIndex);

    const { data: blob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(chunkPath);
    if (dlErr || !blob) throw new Error(`Download failed: ${dlErr?.message || 'no data'}`);
    const pageBytes = new Uint8Array(await blob.arrayBuffer());

    console.log(`PP2 page ${chunkIndex}: detecting regions via PDF vision…`);
    const { regions, pageWidth, pageHeight } = await detectRegionsViaPdfVision(pageBytes);
    console.log(`PP2 page ${chunkIndex}: ${regions.length} merged regions on ${pageWidth}×${pageHeight}pt page (${regions.filter(r=>r.is_logo).length} logos, ${regions.filter(r=>r.is_signature).length} sigs)`);

    let translations;
    if (regions.length === 0) translations = [];
    else {
      console.log(`PP2 page ${chunkIndex}: translating ${regions.length} regions to ${targetLang}…`);
      translations = await translateRegions(regions, targetLang, glossary);
    }

    console.log(`PP2 page ${chunkIndex}: composing PDF overlay…`);
    const finalPdfBytes = await composeTranslatedPdf(pageBytes, regions, translations, pageWidth, pageHeight);

    const outputPath = `pp-output/${jobId}/page-${chunkIndex}.pdf`;
    const { error: upErr } = await supabase.storage.from('translation-jobs')
      .upload(outputPath, finalPdfBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error('Upload failed: ' + upErr.message);

    const fullExtracted = regions.map((r) => r.text).join('\n');
    const fullTranslated = translations.join('\n');
    await supabase.from('translation_chunks').update({
      status: 'completed',
      extracted_text: fullExtracted,
      translated_text: fullTranslated,
    }).eq('job_id', jobId).eq('chunk_index', chunkIndex);

    const totalMs = Date.now() - handlerStartTime;
    console.log(`PP2 page ${chunkIndex}: complete in ${totalMs}ms (${(totalMs/1000).toFixed(1)}s)`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, regions: regions.length }) };
  } catch (err) {
    console.error(`PP2 page ${chunkIndex} failed:`, err);
    // Read current attempt count, then mark failed (or retryable) accordingly
    const { data: existing } = await supabase
      .from('translation_chunks')
      .select('attempts')
      .eq('job_id', jobId).eq('chunk_index', chunkIndex).maybeSingle();
    const newAttempts = (existing?.attempts || 0) + 1;
    await supabase.from('translation_chunks').update({
      status: 'failed',
      attempts: newAttempts,
      error_message: String(err.message || err).slice(0, 1000),
    }).eq('job_id', jobId).eq('chunk_index', chunkIndex);
    return { statusCode: 500, body: 'Server error' };
  }
}
