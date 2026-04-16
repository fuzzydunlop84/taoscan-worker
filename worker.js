// TaoScan — Cloudflare Worker Proxy
// Routes requests to Groq API (free, no credit card)
// Rate limit: 5 scans per IP per day
// Deploy at: workers.cloudflare.com

const DAILY_LIMIT = 5;

// Cloudflare Workers use a global object for in-memory state
// Note: resets on worker restart, which is fine for rate limiting
const ipLog = {};

function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function getRemainingScans(ip) {
  const today = getTodayKey();
  if (!ipLog[ip] || ipLog[ip].date !== today) {
    ipLog[ip] = { date: today, count: 0 };
  }
  return DAILY_LIMIT - ipLog[ip].count;
}

function incrementCount(ip) {
  const today = getTodayKey();
  if (!ipLog[ip] || ipLog[ip].date !== today) {
    ipLog[ip] = { date: today, count: 0 };
  }
  ipLog[ip].count++;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405, headers: corsHeaders()
      });
    }

    // Get IP for rate limiting
    const ip = request.headers.get('CF-Connecting-IP') ||
               request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
               'unknown';

    // Check rate limit
    const remaining = getRemainingScans(ip);

    if (remaining <= 0) {
      const now = new Date();
      const midnight = new Date();
      midnight.setUTCHours(24, 0, 0, 0);
      const secondsUntilReset = Math.floor((midnight - now) / 1000);

      return new Response(JSON.stringify({
        error: 'rate_limit',
        message: 'Daily scan limit reached',
        limit: DAILY_LIMIT,
        remaining: 0,
        resets_in_seconds: secondsUntilReset,
      }), { status: 429, headers: corsHeaders() });
    }

    // Parse body
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400, headers: corsHeaders()
      });
    }

    const { system, messages, max_tokens } = body;
    if (!system || !messages) {
      return new Response(JSON.stringify({ error: 'Missing system or messages' }), {
        status: 400, headers: corsHeaders()
      });
    }

    // Call Groq API
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: max_tokens || 4000,
          temperature: 0.7,
          messages: [
            { role: 'system', content: system },
            ...messages,
          ],
        }),
      });

      const data = await groqRes.json();

      if (!groqRes.ok) {
        return new Response(JSON.stringify({
          error: data.error?.message || 'Groq API error'
        }), { status: groqRes.status, headers: corsHeaders() });
      }

      // Increment count after success
      incrementCount(ip);
      const newRemaining = getRemainingScans(ip);

      // Return in Anthropic-compatible format so frontend works unchanged
      const content = data.choices?.[0]?.message?.content || '';
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: content }],
        _rate_limit: {
          limit: DAILY_LIMIT,
          remaining: newRemaining,
          used: DAILY_LIMIT - newRemaining,
        },
      }), { status: 200, headers: corsHeaders() });

    } catch (err) {
      return new Response(JSON.stringify({
        error: 'Worker error: ' + err.message
      }), { status: 500, headers: corsHeaders() });
    }
  }
};
