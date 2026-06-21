// netlify/functions/pp-coordinator-background.js
//
// PIXEL-PERFECT translation coordinator (Phase 1 — native PDFs only).
//
// Responsibilities (parallel to coordinator-background.js but with pixel-perfect output):
//   1. Mark job 'processing'
//   2. Download source PDF
//   3. Detect: is this a native PDF (extractable text) or scanned (images only)?
//        If scanned → mark job 'pp_unsupported' with reason, fall back to legacy pipeline
//        If native  → proceed
//   4. Split into per-page chunks (1 page each, since reconstruction is per-page)
//   5. Fan out to pp-page-worker-background workers
//   6. Wait for all page-PDFs to complete
//   7. Stitch page PDFs into a single output PDF
//   8. Upload to Storage, save path on job
//   9. Mark job 'completed'

import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// CRITICAL: import the worker module as a side effect so Netlify's bundler ships it
// alongside the function. Without this, pdfjs tries to dynamically locate
// `pdf.worker.mjs` at runtime and fails with "Cannot find module" in serverless envs.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAX_PARALLEL_WORKERS = 2;
const STAGGER_MS = 25000;
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 14 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function updateJob(supabase, jobId, patch) {
  const { error } = await supabase.from('translation_jobs').update(patch).eq('id', jobId);
  if (error) console.error('updateJob error:', error);
}

async function failJob(supabase, jobId, message) {
  console.error('PP Job failed:', jobId, message);
  await updateJob(supabase, jobId, {
    status: 'failed',
    error_message: String(message).slice(0, 2000),
    completed_at: new Date().toISOString(),
  });
}

// Determine if this is a native PDF (has extractable text) using pdfjs-dist.
// Counts actual text content items across pages — far more reliable than byte-scanning.
// Returns: { isNative: boolean, totalTextItems: number, pageCount: number }
async function detectPdfType(pdfBytes) {
  try {
    // CRITICAL: pdfjs may detach/consume the underlying ArrayBuffer.
    // Pass a copy so the original bytes remain usable for pdf-lib later.
    const bytesCopy = new Uint8Array(pdfBytes);
    const loadingTask = pdfjsLib.getDocument({
      data: bytesCopy,
      useSystemFonts: false,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;

    let totalTextItems = 0;
    const pagesToCheck = Math.min(pageCount, 3);
    for (let p = 1; p <= pagesToCheck; p++) {
      const page = await pdf.getPage(p);
      const textContent = await page.getTextContent();
      for (const item of textContent.items) {
        if (item.str && item.str.trim().length > 0) totalTextItems++;
      }
      if (totalTextItems >= 20) break;
    }

    // Clean up pdfjs resources before returning
    await pdf.cleanup();
    await pdf.destroy();

    return {
      isNative: totalTextItems >= 20,
      totalTextItems,
      pageCount,
    };
  } catch (e) {
    console.error('PP detect failed (treating as scanned):', e.message);
    return { isNative: false, totalTextItems: 0, pageCount: 0 };
  }
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const { jobId } = body;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: 'Server missing env vars' };
  }

  const supabase = makeServiceClient();

  try {
    // Fetch job
    const { data: job, error: jobErr } = await supabase
      .from('translation_jobs')
      .select('id, source_path, source_filename, target_lang, service, status, meta')
      .eq('id', jobId).single();
    if (jobErr || !job) throw new Error('Job not found');
    if (job.status === 'cancelled') return { statusCode: 200, body: 'Cancelled' };

    await updateJob(supabase, jobId, { status: 'processing', started_at: new Date().toISOString() });

    // Download source PDF
    const { data: blob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(job.source_path);
    if (dlErr || !blob) throw new Error('Could not download source PDF');
    const sourceBytes = new Uint8Array(await blob.arrayBuffer());

    // Detect PDF type
    const { isNative, totalTextItems, pageCount } = await detectPdfType(sourceBytes);
    console.log(`PP: jobId=${jobId} pages=${pageCount} textItems=${totalTextItems} isNative=${isNative}`);

    if (!isNative) {
      // Phase 1 doesn't handle scanned PDFs — fall back to legacy pipeline.
      // Mark with a flag so we know this happened, and trigger legacy coordinator.
      await updateJob(supabase, jobId, {
        meta: { ...(job.meta || {}), pp_fallback_reason: 'scanned_pdf_phase1_unsupported' },
      });
      const baseUrl = (process.env.URL || process.env.SITE_URL || 'http://localhost:8888').replace(/\/+$/, '');
      const fallbackUrl = `${baseUrl}/.netlify/functions/coordinator-background`;
      await fetch(fallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, fallback: 'scanned' }) };
    }

    await updateJob(supabase, jobId, { pages_total: pageCount, chunks_total: pageCount });

    // Split into per-page PDFs and upload each chunk to storage
    const pageChunks = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const sourceDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      const newDoc = await PDFDocument.create();
      const [copiedPage] = await newDoc.copyPages(sourceDoc, [pageIndex]);
      newDoc.addPage(copiedPage);
      const pageBytes = await newDoc.save();
      const chunkPath = `pp-chunks/${jobId}/page-${pageIndex}.pdf`;
      const { error: upErr } = await supabase.storage
        .from('translation-jobs').upload(chunkPath, pageBytes, {
          contentType: 'application/pdf', upsert: true,
        });
      if (upErr) throw new Error('Failed to upload page chunk: ' + upErr.message);
      pageChunks.push({ pageIndex, chunkPath });
    }

    // Insert chunk rows (one per page)
    const chunkRows = pageChunks.map((c) => ({
      job_id: jobId,
      chunk_index: c.pageIndex,
      page_start: c.pageIndex,
      page_end: c.pageIndex,
      chunk_path: c.chunkPath,
      status: 'queued',
      attempts: 0,
    }));
    const { error: insErr } = await supabase.from('translation_chunks').insert(chunkRows);
    if (insErr) throw new Error('Could not insert chunk rows: ' + insErr.message);

    // Fan out to per-page workers (throttled)
    const baseUrl = (process.env.URL || process.env.SITE_URL || 'http://localhost:8888').replace(/\/+$/, '');
    const workerUrl = `${baseUrl}/.netlify/functions/pp-page-worker-background`;
    for (let i = 0; i < pageChunks.length; i += MAX_PARALLEL_WORKERS) {
      const batch = pageChunks.slice(i, i + MAX_PARALLEL_WORKERS);
      await Promise.all(batch.map((c) => fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId, chunkIndex: c.pageIndex, chunkPath: c.chunkPath,
          targetLang: job.target_lang,
        }),
      }).catch((e) => console.warn('worker fire failed:', e?.message))));
      if (i + MAX_PARALLEL_WORKERS < pageChunks.length) {
        console.log(`PP: fired batch ${Math.floor(i / MAX_PARALLEL_WORKERS) + 1}, waiting ${STAGGER_MS}ms`);
        await sleep(STAGGER_MS);
      }
    }

    // Poll for completion
    const startWait = Date.now();
    let allDone = false;
    while (!allDone && Date.now() - startWait < MAX_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const { data: chunks } = await supabase
        .from('translation_chunks')
        .select('chunk_index, status, attempts')
        .eq('job_id', jobId);
      if (!chunks) continue;
      const done = chunks.filter((c) => c.status === 'completed').length;
      const failed = chunks.filter((c) => c.status === 'failed' && c.attempts >= 3).length;
      await updateJob(supabase, jobId, { chunks_done: done, pages_done: done });
      if (done + failed === chunks.length) allDone = true;
    }

    // Stitch all completed page PDFs into a single output
    const finalDoc = await PDFDocument.create();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const outputPagePath = `pp-output/${jobId}/page-${pageIndex}.pdf`;
      const { data: pageBlob, error: pageErr } = await supabase.storage
        .from('translation-jobs').download(outputPagePath);
      if (pageErr || !pageBlob) {
        // Worker may have failed — fall back to copying the original page
        console.warn(`PP page ${pageIndex} missing, copying original`);
        const sourceDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
        const [origPage] = await finalDoc.copyPages(sourceDoc, [pageIndex]);
        finalDoc.addPage(origPage);
      } else {
        const pageBytes = new Uint8Array(await pageBlob.arrayBuffer());
        const pageDoc = await PDFDocument.load(pageBytes, { ignoreEncryption: true });
        const [translatedPage] = await finalDoc.copyPages(pageDoc, [0]);
        finalDoc.addPage(translatedPage);
      }
    }
    const finalBytes = await finalDoc.save();

    // Upload final output PDF
    const finalPath = `pp-final/${jobId}/translated.pdf`;
    const { error: finalUpErr } = await supabase.storage
      .from('translation-jobs').upload(finalPath, finalBytes, {
        contentType: 'application/pdf', upsert: true,
      });
    if (finalUpErr) throw new Error('Failed to upload final PDF: ' + finalUpErr.message);

    // Also build the legacy text result by concatenating chunk translated_text
    const { data: doneChunks } = await supabase.from('translation_chunks')
      .select('chunk_index, translated_text, extracted_text')
      .eq('job_id', jobId).order('chunk_index');
    const fullText = (doneChunks || []).map((c) => c.translated_text || '').join('\n\n');
    const fullExtracted = (doneChunks || []).map((c) => c.extracted_text || '').join('\n\n');

    await updateJob(supabase, jobId, {
      status: 'completed',
      result_text: fullText,
      extracted_text: fullExtracted,
      result_pdf_path: finalPath,
      completed_at: new Date().toISOString(),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('pp-coordinator error:', err);
    await failJob(supabase, jobId, err.message || String(err));
    return { statusCode: 500, body: 'Coordinator failed' };
  }
}
