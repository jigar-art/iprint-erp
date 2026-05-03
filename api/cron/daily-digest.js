// api/cron/daily-digest.js
// Vercel Cron handler — runs at 14:30 UTC Mon-Sat (8:00 PM IST).
// Pulls the same data ReportsPage uses, builds a Template-message payload,
// and POSTs to /api/wa-send-template for each recipient.
// Kill-switch: app_settings.digest_config.enabled (default false until template
// approves and Jigar flips it on via the Settings panel).
//
// Audit: every run (sent / skipped / partial / failed) writes one row to
// digest_history. NO operational tables (jobs/prs/etc.) are written by this
// handler — strictly read-only on operational data + INSERT-only on history.

const SUPABASE_URL = 'https://idjeniwznjiaanaxcjvg.supabase.co';

// WhatsApp number map — must stay in sync with WA_NUMBERS in index.html.
const WA_NUMBERS = {
  'Amol':         '918433727608',
  'Murli Shetty': '918691069121',
  'Harish':       '919326282238',
  'Priyanka':     '917400214057',
  'Jigar':        '919076270111',
  'Shreya':       '917304008506',
  'Ruchita':      '918591872142',
  'Vidya':        '917743811713',
  'Aparna':       '918425877312',
  'Chandni':      '918291297160',
  'Ankita':       '918454878271',
  'Batul':        '916352713981',
};

// PostgREST helper — read-only fetch, returns parsed JSON or [].
async function pg(supabaseKey, path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  try {
    const r = await fetch(url, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Accept': 'application/json',
      },
    });
    if (!r.ok) {
      console.error(`pg fail ${path}: ${r.status}`);
      return [];
    }
    return await r.json();
  } catch (e) {
    console.error(`pg err ${path}:`, e.message);
    return [];
  }
}

// Insert one row into digest_history. Never throws — logs and returns.
async function logHistory(supabaseKey, row) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/digest_history`, {
      method: 'POST',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) console.error('history insert fail:', r.status, await r.text().catch(()=>''));
  } catch (e) {
    console.error('history insert err:', e.message);
  }
}

// Date helpers — IST (UTC+5:30) since the digest spans "today" in India.
function todayISO() {
  const now = new Date();
  // Convert to IST by adding 5:30
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth()+1).padStart(2,'0')}-${String(ist.getUTCDate()).padStart(2,'0')}`;
}
function startOfTodayISTToISO() {
  // 00:00 IST today, expressed as UTC ISO
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - (5.5 * 60 * 60 * 1000)).toISOString();
}

// Build the traits object the Interakt template will substitute.
// 15 named keys; values are stringified (Interakt requires strings).
function buildTraits(d) {
  return {
    digest_date: d.dateLabel,
    prs_pending: String(d.prsPending),
    prs_pending_oldest_h: String(d.oldestPrHours),
    billing_pending: String(d.billingPending),
    jobs_stuck: String(d.jobsStuck),
    jobs_stuck_top: d.jobsStuckTop || 'none',
    output_prs_raised: String(d.prsRaisedToday),
    output_prs_approved: String(d.prsApprovedToday),
    output_jobs_new: String(d.jobsNewToday),
    output_invoices: String(d.invoicesToday),
    output_billing_approved: String(d.billingApprovedToday),
    standup_posted: String(d.standupPosted),
    standup_pending: String(d.standupPending),
    top_contributor: d.topContributor || 'none',
    value_label: d.valueLabel || '₹0',
  };
}

// Build the human-readable text body (used as fallback if template send is
// disabled, for "Send test now" preview, AND as the template body content
// once the Interakt template is approved with these placeholders).
function buildTextBody(d, sections) {
  const lines = [`📊 *iPrint Daily Digest* · ${d.dateLabel}`, ''];
  if (sections.stalls !== false) {
    lines.push('🚨 *STALLS*');
    lines.push(`• ${d.prsPending} PRs pending${d.oldestPrHours ? ` (oldest ${d.oldestPrHours}h)` : ''}`);
    lines.push(`• ${d.billingPending} billing requests stale`);
    lines.push(`• ${d.jobsStuck} jobs stuck — top: ${d.jobsStuckTop || 'none'}`);
    lines.push('');
  }
  if (sections.output !== false) {
    lines.push('📈 *TODAY*');
    lines.push(`• ${d.prsRaisedToday} PRs raised, ${d.prsApprovedToday} approved`);
    lines.push(`• ${d.jobsNewToday} new jobs, ${d.invoicesToday} invoices added`);
    lines.push(`• ${d.billingApprovedToday} billing approved`);
    lines.push('');
  }
  if (sections.standup !== false) {
    lines.push('📋 *STANDUP*');
    lines.push(`• ${d.standupPosted} posted, ${d.standupPending} pending`);
    lines.push('');
  }
  lines.push(`🏆 Top contributor: ${d.topContributor || 'none'}`);
  if (sections.value !== false) lines.push(`💰 Value: ${d.valueLabel || '₹0'}`);
  lines.push('');
  lines.push('— iPrint ERP');
  return lines.join('\n');
}

// Main handler — Vercel invokes this on cron schedule OR on manual GET.
export default async function handler(req, res) {
  const startTime = Date.now();
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseKey) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_ANON_KEY not configured' });
  }

  // Auth: cron invocations carry CRON_SECRET; manual triggers from the UI
  // pass ?manual=1 + a logged-in supabase context check (lighter — UI is
  // already gated to JIGAR/CHANDNI inside the app).
  const isManual = (req.query?.manual === '1') || (req.url || '').includes('manual=1');
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || '';
  if (!isManual) {
    if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }
  const triggeredBy = isManual ? 'manual' : 'cron';

  // 1. Read digest_config
  const cfgRows = await pg(supabaseKey, `app_settings?key=eq.digest_config&select=value`);
  const cfg = cfgRows[0]?.value || {};
  const enabled = cfg.enabled === true;
  const recipients = Array.isArray(cfg.recipients) && cfg.recipients.length ? cfg.recipients : ['Jigar', 'Chandni'];
  const sections = cfg.sections || { stalls: true, output: true, standup: true, value: true };

  // 2. Build the digest. Even when disabled, we build it so the audit log
  //    captures what *would* have been sent — useful for dry-run review.
  const todayStartISO = startOfTodayISTToISO();
  const today = todayISO();
  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

  const [thresholdRows, prs, billingReqs, jobs, siteInvoicesToday, dcsToday, salesActsToday, dailyLogsToday, teamRows] = await Promise.all([
    pg(supabaseKey, `app_settings?key=eq.stall_thresholds&select=value`),
    pg(supabaseKey, `purchase_requests?select=id,status,created_at,approved_at,rejected_at,po_generated_at,received_at,created_by,approved_by,rejected_by,po_generated_by,received_by,vendor_name`),
    pg(supabaseKey, `billing_requests?select=id,status,created_at,decided_at,requested_by,decided_by`),
    pg(supabaseKey, `jobs?select=id,status,status_dates,created_at,updated_at,made_by,client_name`),
    pg(supabaseKey, `site_invoices?select=id,invoice_amount,added_by,created_at&created_at=gte.${encodeURIComponent(todayStartISO)}`),
    pg(supabaseKey, `delivery_challans?select=id,created_by,delivered_by,prepared_by,created_at&created_at=gte.${encodeURIComponent(todayStartISO)}`),
    pg(supabaseKey, `sales_activities?select=id,rep_name,estimated_value,created_at&created_at=gte.${encodeURIComponent(todayStartISO)}`),
    pg(supabaseKey, `daily_logs?select=id,user_name&log_date=eq.${today}`),
    pg(supabaseKey, `team_members?select=name,active&active=eq.true`),
  ]);

  const thresholds = thresholdRows[0]?.value || { pr_hours: 48, billing_hours: 48, job_days: 14, banking_days: 30 };
  const ageHours = (iso) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 3600000) : 0;
  const ageDays  = (iso) => Math.floor(ageHours(iso) / 24);
  const inToday  = (iso) => iso && iso >= todayStartISO;

  // STALLS
  const prsPendingArr = (prs || []).filter(p => p.status === 'Pending Approval' && ageHours(p.created_at) >= thresholds.pr_hours);
  const oldestPrHours = prsPendingArr.length
    ? Math.max(...prsPendingArr.map(p => ageHours(p.created_at)))
    : 0;
  const billingPendingArr = (billingReqs || []).filter(b => b.status === 'Pending Approval' && ageHours(b.created_at) >= thresholds.billing_hours);

  const TERMINAL = new Set(['Billing Done', 'Cash Received', 'No Bill', 'Cancelled', 'Delivered']);
  const stuckJobs = (jobs || []).filter(j => {
    if (TERMINAL.has(j.status)) return false;
    const lastTouch = j.updated_at || j.created_at;
    return lastTouch && ageDays(lastTouch) >= thresholds.job_days;
  });
  const stuckByStatus = {};
  stuckJobs.forEach(j => { stuckByStatus[j.status] = (stuckByStatus[j.status] || 0) + 1; });
  const jobsStuckTop = Object.entries(stuckByStatus)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([s, n]) => `${s} ${n}`)
    .join(', ');

  // OUTPUT (today)
  const prsRaisedToday   = (prs || []).filter(p => inToday(p.created_at)).length;
  const prsApprovedToday = (prs || []).filter(p => inToday(p.approved_at)).length;
  const jobsNewToday     = (jobs || []).filter(j => inToday(j.created_at)).length;
  const invoicesToday    = (siteInvoicesToday || []).length;
  const billingApprovedToday = (billingReqs || []).filter(b => inToday(b.decided_at) && b.status === 'Approved').length;
  const invoiceTotalToday = (siteInvoicesToday || []).reduce((s, i) => s + (Number(i.invoice_amount) || 0), 0);
  const salesValueToday   = (salesActsToday || []).reduce((s, a) => s + (Number(a.estimated_value) || 0), 0);
  const valueTotal = invoiceTotalToday + salesValueToday;
  const valueLabel = '₹' + Math.round(valueTotal).toLocaleString('en-IN');

  // STANDUP (today)
  const postedNames = new Set((dailyLogsToday || []).map(l => (l.user_name || '').toUpperCase().trim()));
  const activeTeam  = (teamRows || []).filter(t => t.active);
  const standupPosted  = (dailyLogsToday || []).length;
  const standupPending = Math.max(0, activeTeam.length - standupPosted);

  // TOP CONTRIBUTOR (today, same bucketing as Output tab)
  const byUser = {};
  const bump = (u) => { if (!u) return; const k = String(u).toUpperCase().trim(); if (k) byUser[k] = (byUser[k] || 0) + 1; };
  (prs || []).filter(p => inToday(p.created_at)).forEach(p => bump(p.created_by));
  (prs || []).filter(p => inToday(p.approved_at)).forEach(p => bump(p.approved_by));
  (prs || []).filter(p => inToday(p.po_generated_at)).forEach(p => bump(p.po_generated_by));
  (prs || []).filter(p => inToday(p.received_at)).forEach(p => bump(p.received_by));
  (jobs || []).filter(j => inToday(j.created_at)).forEach(j => bump(j.made_by));
  (siteInvoicesToday || []).forEach(i => bump(i.added_by));
  (salesActsToday || []).forEach(a => bump(a.rep_name));
  (dcsToday || []).forEach(d => bump(d.created_by || d.delivered_by || d.prepared_by));
  (billingReqs || []).filter(b => inToday(b.decided_at)).forEach(b => bump(b.decided_by));
  const topEntry = Object.entries(byUser).sort((a, b) => b[1] - a[1])[0];
  const topContributor = topEntry ? `${topEntry[0]} (${topEntry[1]})` : '';

  const digestData = {
    dateLabel,
    prsPending: prsPendingArr.length,
    oldestPrHours,
    billingPending: billingPendingArr.length,
    jobsStuck: stuckJobs.length,
    jobsStuckTop,
    prsRaisedToday,
    prsApprovedToday,
    jobsNewToday,
    invoicesToday,
    billingApprovedToday,
    standupPosted,
    standupPending,
    topContributor,
    valueLabel,
  };

  const traits = buildTraits(digestData);
  const textBody = buildTextBody(digestData, sections);

  // 3. If kill-switch is off, log skip and exit (audit trail still records
  //    what *would* have been sent — handy for dry-run review).
  if (!enabled) {
    await logHistory(supabaseKey, {
      triggered_by: triggeredBy,
      status: 'skipped_disabled',
      payload: { traits, text_preview: textBody, sections },
      recipients: [],
      duration_ms: Date.now() - startTime,
    });
    return res.status(200).json({
      ok: true,
      status: 'skipped_disabled',
      message: 'Digest is disabled in app_settings.digest_config. Flip enabled=true to start sending.',
      preview: { traits, text: textBody },
    });
  }

  // 4. Send to each recipient via /api/wa-send-template (separate proxy).
  //    Determine our own host so the request stays internal.
  const proto = (req.headers['x-forwarded-proto'] || 'https');
  const host  = (req.headers['x-forwarded-host'] || req.headers.host);
  const sendUrl = `${proto}://${host}/api/wa-send-template`;

  const results = [];
  for (const name of recipients) {
    const phone = WA_NUMBERS[name];
    if (!phone) {
      results.push({ name, phone: null, status: 'skipped_no_phone', interakt_id: null, error: `No WA number for ${name}` });
      continue;
    }
    try {
      const r = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: phone,
          template_name: 'iprint_daily_digest',
          language_code: 'en',
          traits,
          fallback_text: textBody,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.ok) {
        results.push({ name, phone, status: 'sent', interakt_id: data.id || null, error: null });
      } else {
        results.push({ name, phone, status: 'failed', interakt_id: null, error: data.error || `HTTP ${r.status}` });
      }
    } catch (e) {
      results.push({ name, phone, status: 'failed', interakt_id: null, error: e.message });
    }
  }

  const allOk = results.every(r => r.status === 'sent');
  const anyOk = results.some(r => r.status === 'sent');
  const overall = allOk ? 'sent' : (anyOk ? 'partial' : 'failed');

  // 5. Audit log + bookkeeping update on app_settings
  const durationMs = Date.now() - startTime;
  await logHistory(supabaseKey, {
    triggered_by: triggeredBy,
    status: overall,
    payload: { traits, text_preview: textBody, sections },
    recipients: results,
    duration_ms: durationMs,
  });

  // Update last_run_at + last_run_status (read-modify-write — single row, low contention)
  try {
    const fresh = await pg(supabaseKey, `app_settings?key=eq.digest_config&select=value`);
    const v = fresh[0]?.value || {};
    v.last_run_at = new Date().toISOString();
    v.last_run_status = overall;
    await fetch(`${SUPABASE_URL}/rest/v1/app_settings?key=eq.digest_config`, {
      method: 'PATCH',
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ value: v, updated_at: new Date().toISOString(), updated_by: 'cron' }),
    });
  } catch (e) {
    console.error('config bookkeeping update failed:', e.message);
  }

  return res.status(200).json({
    ok: anyOk,
    status: overall,
    duration_ms: durationMs,
    recipients: results,
    preview: { traits },
  });
}
