const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
    const { plan, period } = JSON.parse(event.body);

    if (!process.env.STRIPE_SECRET_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Stripe not configured' }) };
    }

    // Define pricing - use your actual Stripe Price IDs after creating products in Stripe Dashboard
    const prices = {
      pro_monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
      pro_annual: process.env.STRIPE_PRICE_PRO_ANNUAL || null,
      business_monthly: process.env.STRIPE_PRICE_BIZ_MONTHLY || null,
      business_annual: process.env.STRIPE_PRICE_BIZ_ANNUAL || null,
    };

    const priceKey = plan + '_' + period;
    const priceId = prices[priceKey];

    if (!priceId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid plan or price not configured. Set STRIPE_PRICE_* environment variables.' })
      };
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: (process.env.SITE_URL || 'https://tranpages.netlify.app') + '?payment=success&plan=' + plan,
      cancel_url: (process.env.SITE_URL || 'https://tranpages.netlify.app') + '?payment=cancelled',
      allow_promotion_codes: true,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url })
    };

  } catch (error) {
    console.error('Stripe error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Payment failed', message: error.message })
    };
  }
};
