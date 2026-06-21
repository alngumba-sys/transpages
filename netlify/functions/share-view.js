// netlify/functions/share-view.js
// Public read endpoint for shared translations.
// No auth required — security is via the unguessable token + share_links table state.

import { createClient } from '@supabase/supabase-js';

export default async (request) => {
    // Parse query params from the URL
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    if (!token) {
        return new Response(JSON.stringify({ error: 'Token required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Use service-role key so we can read past RLS — security comes from the token itself
    const sb = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
    );

    try {
        // Look up the share link
        const { data: link, error: linkErr } = await sb
            .from('share_links')
            .select('id, job_id, expires_at, revoked, view_count')
            .eq('token', token)
            .single();

        if (linkErr || !link) {
            return new Response(JSON.stringify({ error: 'Share link not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (link.revoked) {
            return new Response(JSON.stringify({ error: 'This share link has been revoked' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (link.expires_at && new Date(link.expires_at) < new Date()) {
            return new Response(JSON.stringify({ error: 'This share link has expired' }), {
                status: 410,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Look up the translation job (only safe public fields)
        const { data: job, error: jobErr } = await sb
            .from('translation_jobs')
            .select('source_filename, target_lang, result_text, completed_at')
            .eq('id', link.job_id)
            .single();

        if (jobErr || !job) {
            return new Response(JSON.stringify({ error: 'Translation not found' }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        if (!job.result_text) {
            return new Response(JSON.stringify({ error: 'Translation is still in progress or failed' }), {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Bump view count (fire and forget)
        sb.from('share_links')
            .update({ view_count: (link.view_count || 0) + 1 })
            .eq('id', link.id)
            .then(() => {}, () => {});

        // Return public data only — no user_id, no extracted_text, etc.
        return new Response(JSON.stringify({
            source_filename: job.source_filename,
            target_lang: job.target_lang,
            result_text: job.result_text,
            completed_at: job.completed_at,
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
            },
        });
    } catch (err) {
        console.error('share-view error:', err);
        return new Response(JSON.stringify({ error: 'Server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        });
    }
};

export const config = { path: '/api/share-view' };
