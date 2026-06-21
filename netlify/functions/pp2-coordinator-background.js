// netlify/functions/pp2-coordinator-background.js
//
// PHASE 2 coordinator — vision-based pixel-perfect translation.
// Splits PDF per-page, fans out workers (each renders + does vision + composites),
// stitches the result PDFs together, marks job complete.

import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAX_PARALLEL_WORKERS = 1;   // PP2 is heavier (vision call per page) — keep parallelism low
const STAGGER_MS = 30000;          // 30s between batches
const POLL_INTERVAL_MS = 4000;
const MAX_WAIT_MS = 14 * 60 * 1000;
const PP2_PAGE_LIMIT = 20;         // Phase 2 disabled for very large docs (cost control)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function updateJob(supabase, jobId, patch) {
  const { error } = await supabase.from('translation_jobs').update(patch).eq('id', jobId);
  if (error) console.error('updateJob error:', error);
}

async function failJob(supabase, jobId, message) {
  console.error('PP2 Job failed:', jobId, message);
  await updateJob(supabase, jobId, {
    status: 'failed',
    error_message: String(message).slice(0, 2000),
    completed_at: new Date().toISOString(),
  });
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

    await updateJob(supabase, jobId, {
      status: 'processing',
      started_at: new Date().toISOString(),
      pp_mode: 'phase2',
    });

    // Download source PDF
    const { data: blob, error: dlErr } = await supabase.storage
      .from('translation-jobs').download(job.source_path);
    if (dlErr || !blob) throw new Error('Could not download source PDF');
    const sourceBytes = new Uint8Array(await blob.arrayBuffer());

    // Quick check: how many pages?
    const sourceDoc = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
    const pageCount = sourceDoc.getPageCount();
    console.log(`PP2: jobId=${jobId} pages=${pageCount}`);

    // Cost guardrail — fall back to legacy if too many pages
    if (pageCount > PP2_PAGE_LIMIT) {
      console.log(`PP2: ${pageCount} pages exceeds limit ${PP2_PAGE_LIMIT}, falling back to legacy`);
      await updateJob(supabase, jobId, {
        meta: { ...(job.meta || {}), pp_fallback_reason: `too_many_pages_${pageCount}` },
        pp_mode: 'fallback_legacy',
      });
      const baseUrl = (process.env.URL || process.env.SITE_URL || 'http://localhost:8888').replace(/\/+$/, '');
      await fetch(`${baseUrl}/.netlify/functions/coordinator-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, fallback: 'large' }) };
    }

    await updateJob(supabase, jobId, { pages_total: pageCount, chunks_total: pageCount });

    // Split source into per-page PDFs and upload
    const pageChunks = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const newDoc = await PDFDocument.create();
      const sd = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      const [copiedPage] = await newDoc.copyPages(sd, [pageIndex]);
      newDoc.addPage(copiedPage);
      const pageBytes = await newDoc.save();
      const chunkPath = `pp2-chunks/${jobId}/page-${pageIndex}.pdf`;
      const { error: upErr } = await supabase.storage
        .from('translation-jobs').upload(chunkPath, pageBytes, {
          contentType: 'application/pdf', upsert: true,
        });
      if (upErr) throw new Error('Failed to upload page chunk: ' + upErr.message);
      pageChunks.push({ pageIndex, chunkPath });
    }

    // Insert chunk rows
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

    // Fan out per-page workers (low parallelism due to Sonnet vision cost)
    const baseUrl = (process.env.URL || process.env.SITE_URL || 'http://localhost:8888').replace(/\/+$/, '');
    const workerUrl = `${baseUrl}/.netlify/functions/pp2-page-worker-background`;
    for (let i = 0; i < pageChunks.length; i += MAX_PARALLEL_WORKERS) {
      const batch = pageChunks.slice(i, i + MAX_PARALLEL_WORKERS);
      await Promise.all(batch.map((c) => fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId, chunkIndex: c.pageIndex, chunkPath: c.chunkPath,
          targetLang: job.target_lang,
        }),
      }).catch((e) => console.warn('PP2 worker fire failed:', e?.message))));
      if (i + MAX_PARALLEL_WORKERS < pageChunks.length) {
        console.log(`PP2: fired batch ${Math.floor(i / MAX_PARALLEL_WORKERS) + 1}, waiting ${STAGGER_MS}ms`);
        await sleep(STAGGER_MS);
      }
    }

    // Poll & retry failed chunks
    const startWait = Date.now();
    let allDone = false;
    const MAX_RETRIES = 3;
    const retried = new Set(); // track which chunks we've already retried this round

    while (!allDone && Date.now() - startWait < MAX_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS);
      const { data: chunks } = await supabase
        .from('translation_chunks')
        .select('chunk_index, status, attempts')
        .eq('job_id', jobId);
      if (!chunks) continue;

      const done = chunks.filter((c) => c.status === 'completed').length;
      const permaFailed = chunks.filter((c) => c.status === 'failed' && c.attempts >= MAX_RETRIES);
      const retryable = chunks.filter((c) => c.status === 'failed' && c.attempts < MAX_RETRIES);

      await updateJob(supabase, jobId, { chunks_done: done, pages_done: done });

      // Re-fire any chunks that failed but haven't hit max attempts
      for (const ch of retryable) {
        const key = ch.chunk_index + ':' + ch.attempts;
        if (retried.has(key)) continue;
        retried.add(key);
        console.log(`PP2: retrying chunk ${ch.chunk_index} (attempt ${ch.attempts + 1}/${MAX_RETRIES})`);
        // Reset to processing before re-firing so the worker will pick it up
        await supabase.from('translation_chunks')
          .update({ status: 'processing' })
          .eq('job_id', jobId).eq('chunk_index', ch.chunk_index);
        // Re-invoke the page worker
        try {
          await fetch(`${process.env.URL || 'http://localhost:8888'}/.netlify/functions/pp2-page-worker-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, chunkIndex: ch.chunk_index }),
          });
        } catch (e) {
          console.error('PP2: retry invoke failed:', e);
        }
      }

      if (done + permaFailed.length === chunks.length) allDone = true;
    }

    // After polling loop: if any chunk is still failed at max retries, fail the whole job
    const { data: finalChunks } = await supabase
      .from('translation_chunks')
      .select('chunk_index, status, attempts, error_message')
      .eq('job_id', jobId);
    const stillFailed = (finalChunks || []).filter((c) => c.status === 'failed' && c.attempts >= MAX_RETRIES);
    if (stillFailed.length > 0) {
      const firstErr = stillFailed[0].error_message || 'Unknown error';
      const msg = `Page ${stillFailed[0].chunk_index} failed after ${MAX_RETRIES} attempts: ${firstErr}`;
      await failJob(supabase, jobId, msg);
      return { statusCode: 500, body: 'Job failed' };
    }
    if (!allDone) {
      await failJob(supabase, jobId, `Job timed out after ${Math.round(MAX_WAIT_MS/1000)}s`);
      return { statusCode: 500, body: 'Job timed out' };
    }

    // Stitch all completed page PDFs
    const finalDoc = await PDFDocument.create();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const outputPagePath = `pp-output/${jobId}/page-${pageIndex}.pdf`;
      const { data: pageBlob, error: pageErr } = await supabase.storage
        .from('translation-jobs').download(outputPagePath);
      if (pageErr || !pageBlob) {
        console.warn(`PP2 page ${pageIndex} missing, copying original`);
        const sd = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
        const [origPage] = await finalDoc.copyPages(sd, [pageIndex]);
        finalDoc.addPage(origPage);
      } else {
        const pageBytes = new Uint8Array(await pageBlob.arrayBuffer());
        const pageDoc = await PDFDocument.load(pageBytes, { ignoreEncryption: true });
        const [translatedPage] = await finalDoc.copyPages(pageDoc, [0]);
        finalDoc.addPage(translatedPage);
      }
    }
    const finalBytes = await finalDoc.save();

    // Upload final PDF
    const finalPath = `pp-final/${jobId}/translated.pdf`;
    const { error: finalUpErr } = await supabase.storage
      .from('translation-jobs').upload(finalPath, finalBytes, {
        contentType: 'application/pdf', upsert: true,
      });
    if (finalUpErr) throw new Error('Failed to upload final PDF: ' + finalUpErr.message);

    // Build legacy text result
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
      vision_pages_processed: pageCount,
      completed_at: new Date().toISOString(),
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('pp2-coordinator error:', err);
    await failJob(supabase, jobId, err.message || String(err));
    return { statusCode: 500, body: 'Coordinator failed' };
  }
}
