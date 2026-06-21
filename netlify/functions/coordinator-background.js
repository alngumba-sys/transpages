// netlify/functions/coordinator-background.js
//
// Background function (15-min budget). Responsibilities:
//   1. Mark job as 'processing'
//   2. Download source PDF from Supabase Storage
//   3. Split into N-page chunks
//   4. Insert chunk rows in translation_chunks
//   5. Spawn parallel chunk-worker invocations (fan-out)
//   6. Wait for all chunks to complete (poll DB)
//   7. Assemble final result and mark job 'completed'
//
// Naming convention: filename ends in `-background.js` so Netlify treats it as
// a Background Function (returns 202 immediately, runs up to 15 minutes).

import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAGES_PER_CHUNK = 5;       // each chunk processes ~5 pages
const MAX_PARALLEL_WORKERS = 2;  // throttle for Anthropic Tier 1 rate limits (Haiku: 50k input, 10k output / min)
const STAGGER_MS = 25000;        // wait ~25s between firing each worker batch
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 14 * 60 * 1000; // give up after 14 minutes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeServiceClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function updateJob(supabase, jobId, patch) {
  const { error } = await supabase.from('translation_jobs').update(patch).eq('id', jobId);
  if (error) console.error('updateJob error:', error);
}

async function failJob(supabase, jobId, message) {
  console.error('Job failed:', jobId, message);
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

  const jobId = body.jobId;
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const supabase = makeServiceClient();

  try {
    // Load job
    const { data: job, error: jobError } = await supabase
      .from('translation_jobs').select('*').eq('id', jobId).single();
    if (jobError || !job) {
      console.error('Job not found:', jobId, jobError);
      return { statusCode: 404, body: 'Job not found' };
    }

    if (job.status === 'cancelled') {
      console.log('Job already cancelled:', jobId);
      return { statusCode: 200, body: 'Cancelled' };
    }

    await updateJob(supabase, jobId, {
      status: 'processing',
      started_at: new Date().toISOString(),
    });

    // 1. Download source PDF
    const { data: fileBlob, error: dlError } = await supabase.storage
      .from('translation-jobs').download(job.source_path);
    if (dlError || !fileBlob) {
      await failJob(supabase, jobId, `Failed to download source: ${dlError?.message || 'unknown'}`);
      return { statusCode: 500, body: 'Download failed' };
    }
    const fileBuffer = Buffer.from(await fileBlob.arrayBuffer());

    // 2. Split into chunks (PDF only — text/ocr handled differently)
    const isPdf = job.service === 'translate-pdf' || job.service === 'extract-pdf';

    if (!isPdf) {
      await failJob(supabase, jobId, 'Only PDF service supported in this version.');
      return { statusCode: 400, body: 'Unsupported service' };
    }

    const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
    const totalPages = pdfDoc.getPageCount();
    if (totalPages === 0) {
      await failJob(supabase, jobId, 'PDF has no pages.');
      return { statusCode: 400, body: 'Empty PDF' };
    }

    // 3. Build chunk ranges
    const chunkRanges = [];
    for (let start = 0; start < totalPages; start += PAGES_PER_CHUNK) {
      const end = Math.min(start + PAGES_PER_CHUNK - 1, totalPages - 1);
      chunkRanges.push({ start, end });
    }

    // 4. Insert chunk rows
    const chunkRows = chunkRanges.map((r, i) => ({
      job_id: jobId,
      chunk_index: i,
      page_start: r.start,
      page_end: r.end,
      status: 'queued',
    }));
    const { error: chunkInsertError } = await supabase
      .from('translation_chunks').insert(chunkRows);
    if (chunkInsertError) {
      await failJob(supabase, jobId, `Failed to create chunks: ${chunkInsertError.message}`);
      return { statusCode: 500, body: 'Chunk insert failed' };
    }

    await updateJob(supabase, jobId, {
      pages_total: totalPages,
      chunks_total: chunkRanges.length,
    });

    // 5. Split PDF into per-chunk PDFs and upload each as its own file in Storage
    //    Each chunk-worker downloads only its slice (keeps memory low + parallel-safe)
    const baseFolder = job.source_path.split('/').slice(0, -1).join('/'); // user folder
    const chunkUploads = [];
    for (let i = 0; i < chunkRanges.length; i++) {
      const { start, end } = chunkRanges[i];
      const sub = await PDFDocument.create();
      const pageIndices = [];
      for (let p = start; p <= end; p++) pageIndices.push(p);
      const copied = await sub.copyPages(pdfDoc, pageIndices);
      copied.forEach((pg) => sub.addPage(pg));
      const subBytes = await sub.save();
      const chunkPath = `${baseFolder}/chunks/${jobId}/chunk-${String(i).padStart(4, '0')}.pdf`;
      chunkUploads.push({ index: i, path: chunkPath, bytes: subBytes });
    }

    // Upload chunks in batches to avoid memory spike
    for (let i = 0; i < chunkUploads.length; i += 4) {
      const batch = chunkUploads.slice(i, i + 4);
      await Promise.all(batch.map(async (c) => {
        const { error } = await supabase.storage
          .from('translation-jobs')
          .upload(c.path, c.bytes, { contentType: 'application/pdf', upsert: true });
        if (error) console.warn('chunk upload failed:', c.path, error.message);
      }));
    }

    // 6. Fan-out: trigger workers in batches to respect Anthropic rate limits
    const baseUrl = (process.env.URL || process.env.SITE_URL || 'http://localhost:8888').replace(/\/+$/, '');
    const workerUrl = `${baseUrl}/.netlify/functions/chunk-worker-background`;

    // Process chunks in batches of MAX_PARALLEL_WORKERS, with STAGGER_MS gap between batches.
    // This keeps within Anthropic Tier 1 limits: 2 workers × ~5k tokens each ≈ 10k input/min
    for (let i = 0; i < chunkUploads.length; i += MAX_PARALLEL_WORKERS) {
      const batch = chunkUploads.slice(i, i + MAX_PARALLEL_WORKERS);
      // Fire this batch
      for (const c of batch) {
        fetch(workerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId,
            chunkIndex: c.index,
            chunkPath: c.path,
            targetLang: job.target_lang,
            service: job.service,
          }),
        }).catch((e) => console.warn('worker trigger failed:', c.index, e?.message));
      }
      // If there are more batches to come, wait before firing next
      if (i + MAX_PARALLEL_WORKERS < chunkUploads.length) {
        console.log(`Coordinator: fired batch ${Math.floor(i / MAX_PARALLEL_WORKERS) + 1}, waiting ${STAGGER_MS}ms before next batch`);
        await sleep(STAGGER_MS);
      }
    }

    // 7. Poll for completion
    const startTime = Date.now();
    let lastDoneCount = -1;
    while (Date.now() - startTime < MAX_WAIT_MS) {
      await sleep(POLL_INTERVAL_MS);

      // Check cancellation
      const { data: cur } = await supabase.from('translation_jobs')
        .select('status').eq('id', jobId).single();
      if (cur?.status === 'cancelled') {
        console.log('Job cancelled mid-flight:', jobId);
        return { statusCode: 200, body: 'Cancelled' };
      }

      const { data: chunks, error: cErr } = await supabase
        .from('translation_chunks')
        .select('status, page_end, page_start')
        .eq('job_id', jobId);
      if (cErr) { console.error('poll error:', cErr); continue; }

      const done = chunks.filter((c) => c.status === 'completed').length;
      const failed = chunks.filter((c) => c.status === 'failed').length;
      const total = chunks.length;
      const pagesDone = chunks
        .filter((c) => c.status === 'completed')
        .reduce((sum, c) => sum + (c.page_end - c.page_start + 1), 0);

      if (done !== lastDoneCount) {
        await updateJob(supabase, jobId, {
          chunks_done: done,
          pages_done: pagesDone,
        });
        lastDoneCount = done;
      }

      if (done + failed >= total) {
        // All chunks settled — but if we have failures, try retrying them once
        if (failed > 0) {
          // Find failed chunks that haven't been retried at the coordinator level yet
          const { data: failedChunks } = await supabase
            .from('translation_chunks')
            .select('chunk_index, attempts, error_message')
            .eq('job_id', jobId)
            .eq('status', 'failed');

          // Only retry chunks that failed due to rate limits AND haven't been retried more than once
          const retryable = (failedChunks || []).filter((c) => {
            const msg = (c.error_message || '').toLowerCase();
            const isRateLimit = msg.includes('rate limit') || msg.includes('rate_limit')
              || msg.includes('would exceed') || msg.includes('tokens per minute');
            return isRateLimit && (c.attempts || 0) < 3;
          });

          if (retryable.length > 0) {
            console.log(`Coordinator: ${retryable.length} chunks failed on rate limits, waiting 70s and retrying...`);
            await sleep(70000); // wait for rate limit window to fully reset

            // Re-find chunk paths for retry
            for (let i = 0; i < retryable.length; i += MAX_PARALLEL_WORKERS) {
              const batch = retryable.slice(i, i + MAX_PARALLEL_WORKERS);
              for (const failedChunk of batch) {
                const original = chunkUploads.find((c) => c.index === failedChunk.chunk_index);
                if (!original) continue;
                // Reset chunk status to queued before refiring
                await supabase.from('translation_chunks')
                  .update({ status: 'queued', error_message: null })
                  .eq('job_id', jobId)
                  .eq('chunk_index', failedChunk.chunk_index);
                fetch(workerUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    jobId,
                    chunkIndex: original.index,
                    chunkPath: original.path,
                    targetLang: job.target_lang,
                    service: job.service,
                  }),
                }).catch((e) => console.warn('worker retry failed:', original.index, e?.message));
              }
              if (i + MAX_PARALLEL_WORKERS < retryable.length) {
                await sleep(STAGGER_MS);
              }
            }
            // Continue the polling loop — workers will update statuses as they complete
            lastDoneCount = -1; // force a UI refresh next iteration
            continue;
          }
        }

        // No more retries possible — assemble final result from whatever we have
        const { data: allChunks } = await supabase
          .from('translation_chunks')
          .select('chunk_index, status, extracted_text, translated_text, error_message')
          .eq('job_id', jobId)
          .order('chunk_index', { ascending: true });

        const finalParts = [];
        const extractedParts = [];
        const errors = [];
        for (const c of allChunks) {
          if (c.status === 'completed') {
            finalParts.push(c.translated_text || '');
            extractedParts.push(c.extracted_text || '');
          } else {
            errors.push(`Chunk ${c.chunk_index} (pages ${c.chunk_index * PAGES_PER_CHUNK + 1}-${Math.min((c.chunk_index + 1) * PAGES_PER_CHUNK, totalPages)}): ${c.error_message || 'failed'}`);
          }
        }

        const finalStatus = errors.length === 0 ? 'completed' :
                            finalParts.length > 0 ? 'completed' : 'failed';

        await updateJob(supabase, jobId, {
          status: finalStatus,
          result_text: finalParts.join('\n\n'),
          extracted_text: extractedParts.join('\n\n'),
          error_message: errors.length > 0 ? `${errors.length} of ${allChunks.length} chunks failed: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '...' : ''}` : null,
          completed_at: new Date().toISOString(),
        });

        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
    }

    // Timeout
    await failJob(supabase, jobId, 'Coordinator timed out waiting for chunks.');
    return { statusCode: 500, body: 'Timeout' };
  } catch (err) {
    console.error('coordinator-background error:', err);
    await failJob(supabase, jobId, err.message || 'Unknown error');
    return { statusCode: 500, body: 'Error' };
  }
}
