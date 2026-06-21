// pp3-extract-html-background.js
// Reads a PDF from Supabase storage, extracts structured semantic HTML
// (sender block, recipient, subject, salutation, body, closing, signature),
// and stores the extracted HTML for the translation step.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// pdfjs-dist uses CommonJS internals; the legacy build is the safest in Node
async function loadPdfJs() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Group text items into visual lines (same Y, ~within 2pt tolerance)
function groupItemsIntoLines(items) {
  const sorted = items
    .filter((it) => it.str && it.str.trim())
    .sort((a, b) => b.transform[5] - a.transform[5]); // top to bottom (PDF y goes up)

  const lines = [];
  let current = [];
  let currentY = null;

  for (const it of sorted) {
    const y = it.transform[5];
    if (currentY === null || Math.abs(currentY - y) <= 2) {
      current.push(it);
      currentY = y;
    } else {
      // sort current line by x
      current.sort((a, b) => a.transform[4] - b.transform[4]);
      lines.push({ y: currentY, items: current });
      current = [it];
      currentY = y;
    }
  }
  if (current.length) {
    current.sort((a, b) => a.transform[4] - b.transform[4]);
    lines.push({ y: currentY, items: current });
  }
  return lines;
}

// Determine if a font name indicates bold/italic
function fontFlags(fontName) {
  const f = (fontName || '').toLowerCase();
  return {
    bold:   /bold|black|heavy|semibold|demi/.test(f),
    italic: /italic|oblique/.test(f),
  };
}

// Build a line's text with inline <strong>/<em> runs
function lineToHtml(items) {
  let html = '';
  let prevBold = false, prevItalic = false;
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    let text = escapeHtml(buffer);
    if (prevBold && prevItalic)      html += `<strong><em>${text}</em></strong>`;
    else if (prevBold)               html += `<strong>${text}</strong>`;
    else if (prevItalic)             html += `<em>${text}</em>`;
    else                             html += text;
    buffer = '';
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const { bold, italic } = fontFlags(it.fontName);
    if (i === 0) {
      prevBold = bold; prevItalic = italic;
      buffer = it.str;
    } else {
      // add space if there's a horizontal gap to the previous item
      const prev = items[i - 1];
      const prevRight = prev.transform[4] + (prev.width || 0);
      const gap = it.transform[4] - prevRight;
      const spacer = gap > 1 ? ' ' : '';

      if (bold === prevBold && italic === prevItalic) {
        buffer += spacer + it.str;
      } else {
        flush();
        prevBold = bold; prevItalic = italic;
        buffer = it.str;
      }
    }
  }
  flush();
  return html;
}

// Classify a line into a letter section
function classifyLine(lineText, idx, totalLines, pageWidth, lineX) {
  const t = lineText.toLowerCase().trim();
  const subjectStarts = ['objet', 'subject', 're:', 'ref:'];
  const salutationStarts = ['madame, monsieur', 'dear sir', 'dear madam', 'monsieur,', 'madame,',
    'à qui de droit', 'to whom it may concern', 'cher ', 'dear '];
  const closingPhrases = ['cordialement', 'sincerely', 'regards', 'yours sincerely',
    'best regards', 'kind regards', 'yours faithfully', 'respectueusement', 'sincères salutations',
    'salutations distinguées', 'with respect', 'warm regards', 'faithfully yours'];
  const titlePrefixes = ['directeur', 'chief', 'ceo', 'president', 'managing', 'director',
    'président', 'gérant', 'head of', 'vice'];

  if (subjectStarts.some((p) => t.startsWith(p))) return 'subject';
  if (salutationStarts.some((p) => t.startsWith(p))) return 'salutation';
  if (closingPhrases.some((p) => t.replace(/,$/, '').trim() === p)) return 'closing';
  if (titlePrefixes.some((p) => t.startsWith(p))) return 'jobtitle';
  return null; // caller will assign sender/recipient/body based on position
}

export async function extractHtml(pdfBytes, sourceFilename) {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: pdfBytes, useSystemFonts: false });
  const doc = await loadingTask.promise;

  const allLines = [];
  let pageWidth = 612;

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    if (p === 1) pageWidth = viewport.width;
    const textContent = await page.getTextContent();
    const lines = groupItemsIntoLines(textContent.items);
    allLines.push(...lines.map((l) => ({ ...l, page: p })));
  }

  // Find structural anchors
  let salutationIdx = -1, closingIdx = -1, subjectIdx = -1;
  const lineTexts = allLines.map((l) => l.items.map((it) => it.str).join(' ').trim());
  for (let i = 0; i < lineTexts.length; i++) {
    const cls = classifyLine(lineTexts[i], i, lineTexts.length);
    if (cls === 'subject'    && subjectIdx === -1)    subjectIdx = i;
    if (cls === 'salutation' && salutationIdx === -1) salutationIdx = i;
    if (cls === 'closing'    && closingIdx === -1)    closingIdx = i;
  }

  // Build HTML
  const sections = { sender: [], recipient: [], subject: [], salutation: [], body: [], closing: [], name: '', title: '' };

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    const text = lineTexts[i];
    if (!text) continue;
    const x = line.items[0].transform[4];
    const lineWidth = (line.items[line.items.length - 1].transform[4] + (line.items[line.items.length - 1].width || 0)) - x;
    const isRightAligned = (x + lineWidth) > (pageWidth * 0.55) && x > (pageWidth * 0.4);

    let section;
    if (subjectIdx >= 0 && i === subjectIdx)               section = 'subject';
    else if (salutationIdx >= 0 && i === salutationIdx)    section = 'salutation';
    else if (closingIdx >= 0 && i === closingIdx)          section = 'closing';
    else if (closingIdx >= 0 && i === closingIdx + 1)      section = 'name';
    else if (closingIdx >= 0 && i > closingIdx + 1)        section = 'title';
    else if (i < (subjectIdx >= 0 ? subjectIdx : (salutationIdx >= 0 ? salutationIdx : 4))) {
      // Pre-subject area: detect sender vs recipient block
      // Strategy: find the LARGEST vertical gap in pre-subject lines.
      // Lines before the gap = sender, lines after = recipient.
      // If no clear gap, also fall back to right-alignment.
      if (isRightAligned) {
        section = 'sender';
      } else {
        section = 'pre_subject'; // placeholder, resolved after we have all gaps
      }
    } else if (salutationIdx >= 0 && i > salutationIdx) {
      section = 'body';
    } else {
      section = 'body';
    }

    const lineHtml = lineToHtml(line.items);
    if (section === 'name')  sections.name  = lineHtml;
    else if (section === 'title') sections.title = (sections.title ? sections.title + ' ' : '') + lineHtml;
    else if (section === 'subject' || section === 'salutation' || section === 'closing') {
      sections[section] = lineHtml;
    } else if (section === 'pre_subject') {
      // Will be split into sender/recipient after the loop
      if (!sections.preSubject) sections.preSubject = [];
      sections.preSubject.push({ html: lineHtml, y: line.y });
    } else {
      sections[section].push({ html: lineHtml, y: line.y });
    }
  }

  // Split pre_subject lines into sender + recipient by largest vertical gap
  if (sections.preSubject && sections.preSubject.length > 0) {
    const lines = sections.preSubject;
    if (lines.length <= 4) {
      // Likely all sender — too few lines for two blocks
      lines.forEach((l) => sections.sender.push(l));
    } else {
      // Find the largest gap
      let maxGap = 0, splitIdx = -1;
      for (let i = 1; i < lines.length; i++) {
        const gap = lines[i - 1].y - lines[i].y;
        if (gap > maxGap) { maxGap = gap; splitIdx = i; }
      }
      // Only split if gap is substantial (>16pt indicates blank line)
      if (maxGap > 16 && splitIdx > 0) {
        for (let i = 0; i < splitIdx; i++) sections.sender.push(lines[i]);
        for (let i = splitIdx; i < lines.length; i++) sections.recipient.push(lines[i]);
      } else {
        // No clear gap — assume first half is sender, rest is recipient
        const mid = Math.ceil(lines.length / 2);
        for (let i = 0; i < mid; i++) sections.sender.push(lines[i]);
        for (let i = mid; i < lines.length; i++) sections.recipient.push(lines[i]);
      }
    }
  }

  // Group consecutive body lines into paragraphs.
  // Strategy: lines within a paragraph have CONSISTENT line spacing.
  // A paragraph break = gap noticeably larger than the modal line spacing.
  const bodyParas = [];
  if (sections.body.length > 0) {
    // Compute gaps between consecutive lines
    const gaps = [];
    for (let i = 1; i < sections.body.length; i++) {
      gaps.push(sections.body[i - 1].y - sections.body[i].y);
    }
    // Find the modal (most common) gap → that's the line height within paragraphs
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || 14;
    // A paragraph break = gap > 1.4× the median
    const paraThreshold = medianGap * 1.4;

    let currentPara = [];
    let prevY = null;
    for (const b of sections.body) {
      if (prevY !== null && (prevY - b.y) > paraThreshold) {
        if (currentPara.length) bodyParas.push(currentPara.join(' '));
        currentPara = [];
      }
      currentPara.push(b.html);
      prevY = b.y;
    }
    if (currentPara.length) bodyParas.push(currentPara.join(' '));
  }

  // Compose final HTML
  let html = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><title>' + escapeHtml(sourceFilename || 'Document') + '</title>';
  html += '<style>\n' +
    '@page { size: A4; margin: 25mm 20mm; }\n' +
    'body { font-family: "Helvetica", "Arial", sans-serif; font-size: 11pt; line-height: 1.6; color: #000; max-width: 170mm; margin: 0 auto; }\n' +
    '.letter { padding: 0; }\n' +
    '.sender   { text-align: right;  margin-bottom: 1.5em; }\n' +
    '.sender p { margin: 0; line-height: 1.5; }\n' +
    '.recipient   { margin-bottom: 1.5em; }\n' +
    '.recipient p { margin: 0; line-height: 1.5; }\n' +
    '.subject    { font-weight: 700; margin: 0 0 1.5em 0; }\n' +
    '.salutation { margin: 0 0 1em 0; }\n' +
    '.body       { text-align: justify; margin: 0 0 1em 0; line-height: 1.6; }\n' +
    '.closing       { margin: 1.5em 0 0 0; }\n' +
    '.signature-name  { font-weight: 700; margin: 1.5em 0 0 0; }\n' +
    '.signature-title { margin: 0; }\n' +
    '</style></head><body><div class="letter">\n';

  if (sections.sender.length) {
    html += '<header class="sender">\n';
    sections.sender.forEach((s) => { html += '  <p>' + s.html + '</p>\n'; });
    html += '</header>\n';
  }
  if (sections.recipient.length) {
    html += '<address class="recipient">\n';
    sections.recipient.forEach((s) => { html += '  <p>' + s.html + '</p>\n'; });
    html += '</address>\n';
  }
  if (sections.subject)    html += '<p class="subject">' + sections.subject + '</p>\n';
  if (sections.salutation) html += '<p class="salutation">' + sections.salutation + '</p>\n';
  bodyParas.forEach((para) => { html += '<p class="body">' + para + '</p>\n'; });
  if (sections.closing) html += '<p class="closing">' + sections.closing + '</p>\n';
  if (sections.name)    html += '<p class="signature-name">' + sections.name + '</p>\n';
  if (sections.title)   html += '<p class="signature-title">' + sections.title + '</p>\n';

  html += '</div></body></html>';
  return html;
}

// Background function handler
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
      .from('translation_jobs').select('source_path, source_filename').eq('id', jobId).single();
    if (jobErr) throw new Error('Job lookup failed: ' + jobErr.message);

    const { data: pdfBlob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(job.source_path);
    if (dlErr || !pdfBlob) throw new Error('PDF download failed: ' + (dlErr?.message || 'no data'));

    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const html = await extractHtml(pdfBytes, job.source_filename);

    // Store extracted HTML in storage
    const htmlPath = `pp3-extracted/${jobId}/source.html`;
    const { error: upErr } = await supabase.storage.from('translation-jobs')
      .upload(htmlPath, new Blob([html], { type: 'text/html' }), { upsert: true });
    if (upErr) throw new Error('HTML upload failed: ' + upErr.message);

    await supabase.from('translation_jobs').update({
      metadata: { extracted_html_path: htmlPath },
    }).eq('id', jobId);

    console.log(`PP3 extract: job=${jobId} html_size=${html.length} bytes`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, htmlPath, htmlBytes: html.length }) };
  } catch (err) {
    console.error('pp3-extract failed:', err);
    await supabase.from('translation_jobs').update({
      status: 'failed',
      error_message: 'Extract HTML: ' + (err.message || String(err)).slice(0, 500),
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
    return { statusCode: 500, body: 'Extract failed' };
  }
}
