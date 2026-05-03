// api/wa-send-template.js
// Vercel serverless function: proxies WhatsApp Template-message sends to
// Interakt's Template Message API (distinct from the Track Event API used
// by /api/wa-send). The Interakt Secret Key (base64 of `apiKey:`) lives in
// the Vercel env var INTERAKT_KEY and is NEVER exposed to the browser.
//
// Why a separate proxy:
//   * /api/wa-send hits /api/v1/public/track/events to FIRE registered
//     templates by event name (campaign-style).
//   * /api/wa-send-template hits /api/v1/public/message/ to send a Template
//     directly with parameter substitutions (bodyValues array).
//   Both endpoints exist; both require approved templates. The digest needs
//   the second pattern because we want explicit traits/parameters control.
//
// Client/Server caller sends:   POST /api/wa-send-template
//   { to: "919076270111",
//     template_name: "iprint_daily_digest",
//     language_code: "en",
//     traits: { digest_date: "Sun, 3 May 2026", prs_pending: "3", ... },
//     fallback_text: "..."  // optional, used if traits are empty
//   }
//
// Server returns:               { ok: true, id: "..." } | { ok: false, error: "..." }

// Order matters — Interakt expects bodyValues as a positional array matching
// {{1}}, {{2}}, ... in the approved template. THIS LIST IS THE CONTRACT
// between the cron handler's traits object and the template variable order.
// If you re-order the template body in the Interakt UI, update this array.
const TEMPLATE_PARAM_ORDER = {
  iprint_daily_digest: [
    'digest_date',           // {{1}}
    'prs_pending',           // {{2}}
    'prs_pending_oldest_h',  // {{3}}
    'billing_pending',       // {{4}}
    'jobs_stuck',            // {{5}}
    'jobs_stuck_top',        // {{6}}
    'output_prs_raised',     // {{7}}
    'output_prs_approved',   // {{8}}
    'output_jobs_new',       // {{9}}
    'output_invoices',       // {{10}}
    'output_billing_approved', // {{11}}
    'standup_posted',        // {{12}}
    'standup_pending',       // {{13}}
    'top_contributor',       // {{14}}
    'value_label',           // {{15}}
  ],
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const interaktKey = process.env.INTERAKT_KEY;
  if (!interaktKey) {
    return res.status(500).json({ ok: false, error: 'INTERAKT_KEY not configured' });
  }

  // Body parse — Vercel auto-parses JSON when Content-Type is application/json,
  // but be defensive in case content-type is missing.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'invalid_json' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'missing_body' });
  }

  const to = String(body.to || '').replace(/\D/g, '');
  const templateName = String(body.template_name || '').trim();
  const languageCode = String(body.language_code || 'en').trim();
  const traits = body.traits || {};

  if (!to || to.length < 10) {
    return res.status(400).json({ ok: false, error: 'invalid_phone' });
  }
  if (!templateName) {
    return res.status(400).json({ ok: false, error: 'missing_template_name' });
  }

  // Split country code (IN = 91) from the rest of the number.
  let countryCode = '91';
  let phoneNumber = to;
  if (to.startsWith('91') && to.length === 12) {
    countryCode = '91';
    phoneNumber = to.slice(2);
  } else if (to.length === 10) {
    countryCode = '91';
    phoneNumber = to;
  }

  // Build bodyValues from traits using the registered parameter order.
  const order = TEMPLATE_PARAM_ORDER[templateName];
  if (!order) {
    return res.status(400).json({ ok: false, error: `unknown_template:${templateName}` });
  }
  const bodyValues = order.map(k => {
    const v = traits[k];
    return (v === null || v === undefined) ? '' : String(v);
  });

  // POST to Interakt Template Message API.
  // Endpoint reference: https://docs.interakt.shop/docs/sending-messages-using-amped
  try {
    const interaktRes = await fetch('https://api.interakt.ai/v1/public/message/', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${interaktKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        countryCode,
        phoneNumber,
        callbackData: `iprint_${templateName}_${Date.now()}`,
        type: 'Template',
        template: {
          name: templateName,
          languageCode,
          bodyValues,
        },
      }),
    });

    const data = await interaktRes.json().catch(() => ({}));
    if (interaktRes.ok && (data.result === true || data.id)) {
      return res.status(200).json({ ok: true, id: data.id || null });
    }
    return res.status(interaktRes.status >= 400 ? interaktRes.status : 502).json({
      ok: false,
      error: data.message || data.error || `interakt_http_${interaktRes.status}`,
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: e.message || 'interakt_fetch_failed' });
  }
}
