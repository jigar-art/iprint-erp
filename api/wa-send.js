// api/wa-send.js
// Vercel serverless function: proxies WhatsApp sends from the iPrint ERP client
// to Interakt. The Interakt Secret Key (base64 of `apiKey:`) lives in the Vercel
// env var INTERAKT_KEY and is NEVER exposed to the browser.
//
// Client sends:   POST /api/wa-send   { to: "919076270111", message: "...", campaign: "..." }
// Proxy replies:  { ok: true, id: "<interakt message id>" }  OR  { ok: false, error: "..." }
//
// 24 Sep 2026: switched from free-text ("Text") messages to approved Templates.
// Free text was failing on every send — Interakt 403 "API not supported on your
// account" and 400 "Customer has not messaged within last 24 hours" (WhatsApp's
// 24-hour rule). Every ERP message is now sent through one of two generic
// UTILITY templates, so the 15 message types in index.html need no change:
//   iprint_erp_update     — staff (PR / GRN / billing / PO request ...)
//   iprint_vendor_update  — vendors (PO sent, vendor notify, quote revisions)
// Both take {{1}} = subject line, {{2}} = details. WhatsApp does not allow
// new lines, tabs or 4+ spaces inside a variable, so the message is flattened:
// first non-empty line -> subject, remaining lines joined with " · ".
//
// 21 Apr 2026: track-user upsert before send (kept) — resolves
// "Customer is not available for the organization".

const VENDOR_CAMPAIGN = /vendor|po_send/i;
const TEMPLATE_STAFF = 'iprint_erp_update';
const TEMPLATE_VENDOR = 'iprint_vendor_update';

function flatten(message) {
  const lines = String(message || '')
    .replace(/\r/g, '')
    .split('\n')
    .map(s => s.replace(/[*_~`]/g, '').replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim())
    .filter(Boolean);
  let subject = (lines[0] || 'Update from iPrint').slice(0, 200);
  let details = lines.slice(1).join(' · ') || '-';
  if (details.length > 900) details = details.slice(0, 897) + '...';
  return [subject, details];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Origin allow-list — rejects calls from anywhere except iPrint's own domains.
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://iprint-erp.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ];
  const isVercelPreview = /^https:\/\/iprint-erp-[a-z0-9-]+\.vercel\.app$/.test(origin);
  if (origin && !allowedOrigins.includes(origin) && !isVercelPreview) {
    return res.status(403).json({ ok: false, error: 'Forbidden origin' });
  }

  const { to, message, campaign } = req.body || {};
  if (!to || typeof to !== 'string') {
    return res.status(400).json({ ok: false, error: "Missing or invalid 'to'" });
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ ok: false, error: "Missing or invalid 'message'" });
  }

  const interaktAuth = process.env.INTERAKT_KEY;
  if (!interaktAuth) {
    console.error('INTERAKT_KEY env var not set');
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  const digitsOnly = to.replace(/\D/g, '');
  let countryCode = '91';
  let phoneNumber = digitsOnly;
  if (digitsOnly.startsWith('91') && digitsOnly.length === 12) {
    phoneNumber = digitsOnly.slice(2);
  } else if (digitsOnly.length === 10) {
    phoneNumber = digitsOnly;
  } else if (digitsOnly.length > 10) {
    countryCode = digitsOnly.slice(0, digitsOnly.length - 10);
    phoneNumber = digitsOnly.slice(-10);
  } else {
    return res.status(400).json({ ok: false, error: 'Phone number too short' });
  }

  // STEP 1: make sure the phone exists as a customer in Interakt (idempotent, non-blocking).
  let trackOk = false;
  let trackStatus = 0;
  try {
    const trackRes = await fetch('https://api.interakt.ai/v1/public/track/users/', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + interaktAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ countryCode, phoneNumber, traits: { source: 'iprint_erp' } })
    });
    trackStatus = trackRes.status;
    trackOk = trackRes.ok;
    if (!trackRes.ok) {
      const trackBody = await trackRes.text().catch(() => '');
      console.warn('Track-user non-OK:', trackRes.status, trackBody.slice(0, 200));
    }
  } catch (trackErr) {
    console.warn('Track-user exception:', (trackErr && trackErr.message) || trackErr);
  }

  // STEP 2: send through the approved template.
  const templateName = VENDOR_CAMPAIGN.test(campaign || '') ? TEMPLATE_VENDOR : TEMPLATE_STAFF;
  const bodyValues = flatten(message);
  try {
    const interaktRes = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + interaktAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        countryCode,
        phoneNumber,
        callbackData: campaign || 'iprint_erp',
        type: 'Template',
        template: { name: templateName, languageCode: 'en', bodyValues }
      })
    });
    const data = await interaktRes.json().catch(() => ({}));

    if (!interaktRes.ok || data.result === false) {
      console.warn('Interakt template non-OK:', templateName, interaktRes.status, JSON.stringify(data).slice(0, 300));
      return res.status(interaktRes.ok ? 502 : interaktRes.status).json({
        ok: false, error: 'Interakt refused', template: templateName,
        upstream_status: interaktRes.status, upstream: data, track_ok: trackOk, track_status: trackStatus
      });
    }

    console.log('WA template sent:', templateName, campaign || '', data.id || '');
    return res.status(200).json({ ok: true, id: data.id || null, to: countryCode + phoneNumber, template: templateName, track_ok: trackOk });
  } catch (err) {
    console.error('Proxy exception:', err);
    return res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
}
