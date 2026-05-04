exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Supabase admin keys not configured. Add SUPABASE_URL and SUPABASE_SERVICE_KEY to Netlify environment variables.' })
      };
    }

    // Fetch all users using Supabase Admin API
    const resp = await fetch(supabaseUrl + '/auth/v1/admin/users?per_page=500', {
      headers: {
        'Authorization': 'Bearer ' + supabaseServiceKey,
        'apikey': supabaseServiceKey
      }
    });

    const data = await resp.json();
    const rawUsers = data.users || data || [];

    // Process users
    const users = rawUsers.map(u => {
      const createdAt = new Date(u.created_at);
      const now = new Date();
      const daysSinceSignup = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
      const trialDaysLeft = Math.max(0, 14 - daysSinceSignup);
      
      // Determine status (basic logic - in production you'd check Stripe subscriptions)
      let status = 'free';
      if (daysSinceSignup <= 14) status = 'trial';
      
      // Extract metadata
      const meta = u.user_metadata || {};
      const appMeta = u.app_metadata || {};
      
      return {
        id: u.id,
        email: u.email || '—',
        name: meta.full_name || meta.name || (u.email ? u.email.split('@')[0] : '—'),
        country: meta.country || '—',
        created_at: u.created_at,
        last_sign_in: u.last_sign_in_at,
        status: appMeta.subscription_status || status,
        trial_days_left: status === 'trial' ? trialDaysLeft : null,
        provider: u.app_metadata?.provider || 'email',
        tokens: meta.tokens_used || 0,
        cost: meta.cost_used || 0,
        pages_used: meta.pages_used || 0,
        transcription_mins_used: meta.transcription_mins_used || 0,
        services: meta.services || { translate: 0, audio: 0, video: 0, batch: 0, ocr: 0, esign: 0 }
      };
    });

    // Calculate totals
    let totalTokens = 0, totalCost = 0, paying = 0;
    users.forEach(u => {
      totalTokens += u.tokens || 0;
      totalCost += u.cost || 0;
      if (u.status === 'paying') paying++;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        users: users,
        totals: { tokens: totalTokens, cost: totalCost, paying: paying }
      })
    };

  } catch (error) {
    console.error('Admin error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to load users', message: error.message })
    };
  }
};
