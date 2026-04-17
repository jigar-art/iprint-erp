// api/wa-send.js
// Vercel serverless function: proxies WhatsApp send requests from the iPrint ERP
// client to the Interakt API. The Interakt Secret Key (pre-encoded base64 of
// `apiKey:`) lives in the Vercel env var INTERAKT_KEY and is NEVER exposed to the
// browser.
//
// Client sends:   POST /api/wa-send   { to: "919076270111", message: "...", campaign: "..." }
// Proxy replies:  { ok: true, id: "<interakt message id>" }  OR  { ok: false, error: "..." }

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Origin allow-list — rejects calls from anywhere except iPrint's own domains.
  // The browser sends an Origin header; same-origin fetches from the ERP page
  // carry an origin matching one of these. Requests from curl / other sites
  // without a matching origin are refused so the proxy can't be abused.
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://iprint-erp.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ];
  // Vercel preview deploys (iprint-erp-*.vercel.app) are also allowed.
  const isVercelPreview = /^https:\/\/iprint-erp-[a-z0-9-]+\.vercel\.app$/.test(origin);
  if (origin && !allowedOrigins.includes(origin) && !isVercelPreview) {
    return res.status(403).json({ ok: false, error: 'Forbidden origin' });
  }

  // Validate body
  const { to, message, campaign } = req.body || {};
  if (!to || typeof to !== 'string') {
    return res.status(400).json({ ok: false, error: "Missing or invalid 'to'" });
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: "Missing or invalid 'message'" });
  }
  if (message.length > 4096) {
    return res.status(400).json({ ok: false, error: 'Message exceeds WhatsApp 4096 char limit' });
  }

  // Env var must exist
  const interaktAuth = process.env.INTERAKT_KEY;
  if (!interaktAuth) {
    console.error('INTERAKT_KEY env var not set');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  // Normalize phone: strip spaces/dashes/plus, then split country code from number.
  // ERP always passes numbers as 91XXXXXXXXXX (country code 91 prefix). Interakt
  // wants countryCode and phoneNumber as separate fields.
  const digitsOnly = to.replace(/\D/g, '');
  let countryCode = '91';
  let phoneNumber = digitsOnly;
  if (digitsOnly.startsWith('91') && digitsOnly.length === 12) {
    phoneNumber = digitsOnly.slice(2);
  } else if (digitsOnly.length === 10) {
    // assume Indian local number
    phoneNumber = digitsOnly;
  } else if (digitsOnly.length > 10) {
    // keep first 1-3 digits as country code, rest as phone
    // fallback — user can always fix by passing canonical 91XXXXXXXXXX
    countryCode = digitsOnly.slice(0, digitsOnly.length - 10);
    phoneNumber = digitsOnly.slice(-10);
  } else {
    return res.status(400).json({ ok: false, error: 'Phone number too short' });
  }

  try {
    const interaktRes = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + interaktAuth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        countryCode: countryCode,
        phoneNumber: phoneNumber,
        callbackData: campaign || 'iprint_erp',
        type: 'Text',
        data: { message: message }
      })
    });

    const data = await interaktRes.json().catch(() => ({}));

    if (!interaktRes.ok) {
      console.warn('Interakt non-OK:', interaktRes.status, JSON.stringify(data).slice(0, 300));
      return res.status(interaktRes.status).json({
        ok: false,
        error: 'Interakt error',
        upstream_status: interaktRes.status,
        upstream: data
      });
    }

    // Interakt success response shape: { result: true, id: "...", ... }
    if (data.result === false) {
      return res.status(502).json({ ok: false, error: 'Interakt refused', upstream: data });
    }

    return res.status(200).json({
      ok: true,
      id: data.id || null,
      to: countryCode + phoneNumber
    });
  } catch (err) {
    console.error('Proxy exception:', err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
}
