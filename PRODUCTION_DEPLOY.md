# Tranpages Production Deployment Guide

## Overview
This is the production-ready version with a secure backend that handles API calls through Netlify Functions.

## What Changed from Demo Version
- ✅ API calls now go through Netlify Functions (serverless backend)
- ✅ API key stored securely in environment variables
- ✅ CORS issues resolved
- ✅ Production-ready security headers
- ✅ No API keys exposed in browser

## Files Structure
```
tranpages-production/
├── index.html                      # Frontend application
├── TP_LOGO.png                     # Logo
├── package.json                    # Node.js metadata
├── netlify.toml                    # Netlify configuration
├── _redirects                      # SPA routing
└── netlify/
    └── functions/
        └── translate.js            # Translation API proxy
```

---

## Deployment Steps

### Step 1: Push to GitHub

```bash
cd tranpages-production

git init
git add .
git commit -m "Production-ready Tranpages with Netlify Functions"
git branch -M main
git remote add origin https://github.com/alngumba-sys/transpages.git
git push -u origin main --force
```

### Step 2: Connect to Netlify

1. Go to **https://app.netlify.com**
2. Click **"Add new site" → "Import an existing project"**
3. Choose **GitHub**
4. Select the **transpages** repository
5. Build settings:
   - **Build command:** (leave empty or `npm run build`)
   - **Publish directory:** `.`
   - **Functions directory:** `netlify/functions` (auto-detected)
6. Click **"Deploy site"**

### Step 3: Add Your Anthropic API Key

This is **CRITICAL** — without this, translations won't work.

1. In your Netlify site dashboard, go to **Site settings**
2. Click **Environment variables** (in the left sidebar under "Build & deploy")
3. Click **"Add a variable"**
4. Add:
   - **Key:** `ANTHROPIC_API_KEY`
   - **Value:** `YOUR_ANTHROPIC_API_KEY_HERE`
   - **Scopes:** Check all (Builds, Functions, Post-processing)
5. Click **"Save"**

#### Where to Get Your Anthropic API Key:
1. Go to https://console.anthropic.com
2. Sign in (or create an account)
3. Go to **API Keys** section
4. Click **"Create Key"**
5. Copy the key (starts with `sk-ant-...`)
6. Paste it into Netlify's environment variable

### Step 4: Trigger Redeploy

After adding the API key:
1. Go to **Deploys** tab
2. Click **"Trigger deploy" → "Clear cache and deploy site"**
3. Wait for the deploy to finish (~30 seconds)

---

## Verify It's Working

1. Visit your Netlify URL (e.g., `https://transpages.netlify.app`)
2. Sign up / Log in
3. Upload a PDF document
4. Select a language and click "Translate Now"
5. **It should work!** No more "Failed to fetch" error

---

## Custom Domain Setup (Optional)

### Option A: Netlify Subdomain
Your site is already live at: `https://YOUR-SITE-NAME.netlify.app`

To customize:
1. **Site settings → Domain management → Change site name**
2. Enter: `tranpages` or `tranpages-demo`
3. New URL: `https://tranpages.netlify.app`

### Option B: Custom Domain
1. **Site settings → Domain management → Add custom domain**
2. Enter your domain: `app.tranpages.com`
3. Add DNS records (Netlify provides instructions):
   ```
   Type: CNAME
   Name: app (or @ for root)
   Value: YOUR-SITE.netlify.app
   ```
4. Netlify automatically provisions SSL certificate (free)

---

## Troubleshooting

### Problem: "Failed to fetch" error still appears

**Solution:**
1. Check that `ANTHROPIC_API_KEY` is set in **Site settings → Environment variables**
2. Make sure you triggered a redeploy after adding the key
3. Check the Functions logs:
   - Go to **Functions** tab in Netlify dashboard
   - Click on `translate` function
   - Check recent invocations for errors

### Problem: Function not found (404)

**Solution:**
1. Make sure the `netlify/functions` folder was committed to git
2. Check that `netlify.toml` has: `functions = "netlify/functions"`
3. Redeploy the site

### Problem: API key error

**Solution:**
1. Verify your API key is valid at https://console.anthropic.com
2. Make sure the key starts with `sk-ant-`
3. Re-enter it in Netlify environment variables
4. Redeploy

---

## API Usage & Costs

### Anthropic API Pricing (as of 2024):
- **Claude Sonnet:** ~$3 per million input tokens, ~$15 per million output tokens
- A typical 10-page PDF translation costs approximately **$0.05 - $0.15**

### Monitor Usage:
1. Go to https://console.anthropic.com
2. Check **Usage** section to see your API consumption

### Set Spending Limits:
1. In Anthropic Console, go to **Billing**
2. Set a monthly budget limit (e.g., $50/month)
3. Get email alerts when you reach thresholds

---

## Production Considerations

### Rate Limiting
The Netlify function doesn't have rate limiting built in. For production, consider:

1. **Add rate limiting to the function:**
```javascript
// In netlify/functions/translate.js
// Use a service like Upstash Redis or Netlify Rate Limiting
```

2. **Monitor function invocations** in Netlify dashboard

### Scaling
- Netlify Functions automatically scale
- Free tier: 125,000 function invocations/month
- Pro tier: Unlimited invocations

### Security Best Practices
- ✅ API key in environment variables (never in code)
- ✅ CORS headers configured
- ✅ HTTPS enabled by default
- ✅ Security headers in netlify.toml
- 🔲 Consider adding authentication for production users
- 🔲 Add rate limiting per user/IP

---

## Next Steps

1. **Test thoroughly** — upload different file types, try all features
2. **Monitor usage** — check Anthropic API consumption
3. **Set up analytics** — add Google Analytics or Plausible
4. **Add user authentication** — integrate Auth0, Clerk, or Supabase Auth
5. **Database for user data** — Supabase, Firebase, or PostgreSQL on Railway

---

## Support

If you run into issues:
1. Check Netlify Function logs (Functions tab)
2. Check browser console for errors (F12 → Console)
3. Verify environment variables are set correctly
4. Test the function directly: `https://YOUR-SITE.netlify.app/.netlify/functions/translate`

---

**You're ready for production!** 🚀
