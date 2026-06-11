// api/cron/db-health.js
// Lever C — external DB Health Watchdog (spec 2026-05-31).
// Probes Supabase from OUTSIDE the DB (Vercel), so it still works when the DB
// itself is the failing component (the 30-31 May class of outage).
//
// Checks: heartbeat / connections / slow queries / cron failures.
// Alerts:  email via Resend on state TRANSITIONS only (anti-spam), one
//          reminder after 24h, RECOVERED email on clear.
// State:   public.health_alerts_state (service_role only).
// Guard:   self-expiring sentinel-row lock (90s) — overlapping invocations
//          never stack (Lever B reference implementation).
//
// Env (Vercel): SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, FROM_EMAIL,
//               ALERT_EMAILS (comma-separated), CRON_SECRET (already exists).
// NOTE: if the DB is fully unreachable, dedup state can't be read — the
// watchdog then emails EVERY cycle until the DB returns. Loud by design.

const SUPABASE_URL = 'https://idjeniwznjiaanaxcjvg.supabase.co';

const T = {
  heartbeatMs: 3000,     // heartbeat probe timeout
  connWarn: 42,          // >70% of max_connections (60)
  connCrit: 54,          // >90%
  slowQuerySec: 30,      // any active client query older than this -> warning
  cronConsecFails: 3,    // consecutive failures -> warning
  cronStuckMin: 10,      // a run still 'running' after this -> warning
  reminderHours: 24,     // one reminder while condition persists
  lockStaleSec: 90,      // sentinel lock self-expiry
};

export const config = { maxDuration: 20 };

function hdrs(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function fetchT(url, opts = {}, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } finally {
    clearTimeout(t);
  }
}

async function rpc(key, fn, ms = 8000) {
  const r = await fetchT(
    `${SUPABASE_URL}/rest/v1/rpc/${fn}`,
    { method: 'POST', headers: hdrs(key), body: '{}' },
    ms
  );
  if (!r.ok) throw new Error(`rpc ${fn} HTTP ${r.status}`);
  return r.json();
}

async function sendEmail(subject, text) {
  const to = (process.env.ALERT_EMAILS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!to.length || !process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
    console.error('db-health: email env not configured');
    return false;
  }
  try {
    const r = await fetchT(
      'https://api.resend.com/emails',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: process.env.FROM_EMAIL, to, subject, text }),
      },
      8000
    );
    if (!r.ok) console.error('db-health: resend HTTP', r.status);
    return r.ok;
  } catch (e) {
    console.error('db-health: resend err', e.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // Auth: Vercel cron sends "Authorization: Bearer <CRON_SECRET>".
  // Also accepts ?key=<CRON_SECRET> so an external pinger (UptimeRobot) can
  // trigger it on plans where */5 Vercel crons aren't available.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || '';
  const qkey = (req.query && req.query.key) || '';
  if (!secret || (auth !== `Bearer ${secret}` && qkey !== secret)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return res.status(500).json({ error: 'service role key not set' });

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const results = {};   // condition -> { state, detail }

  // ---- 1. HEARTBEAT (3s) — also gates everything else -----------------
  let heartbeatOk = false;
  try {
    const r = await fetchT(
      `${SUPABASE_URL}/rest/v1/health_alerts_state?select=condition&limit=1`,
      { headers: hdrs(key) },
      T.heartbeatMs
    );
    heartbeatOk = r.ok;
    results.heartbeat = r.ok
      ? { state: 'healthy', detail: 'ok' }
      : { state: 'critical', detail: `HTTP ${r.status}` };
  } catch (e) {
    results.heartbeat = { state: 'critical', detail: `unreachable: ${e.message}` };
  }

  if (!heartbeatOk) {
    // DB unreachable -> can't read dedup state. Email every cycle (loud).
    await sendEmail(
      '[CRITICAL] iPrint ERP — database unreachable',
      `DB heartbeat failed at ${new Date().toISOString()}\n` +
      `Detail: ${results.heartbeat.detail}\n\n` +
      `This is the 30-31 May outage class. Runbook:\n` +
      `1. Supabase dashboard -> project health\n` +
      `2. If resource-exhausted, restart/upgrade instance\n` +
      `3. After recovery run ANALYZE (whole DB)\n\n` +
      `This email repeats every cycle until the DB responds.`
    );
    return res.status(200).json({ run: runId, heartbeat: 'CRITICAL', alerted: true });
  }

  // ---- 2. CONCURRENCY GUARD (self-expiring sentinel lock) --------------
  try {
    const staleBefore = new Date(Date.now() - T.lockStaleSec * 1000).toISOString();
    const claim = await fetchT(
      `${SUPABASE_URL}/rest/v1/health_alerts_state` +
        `?condition=eq.watchdog_lock&since=lt.${encodeURIComponent(staleBefore)}`,
      {
        method: 'PATCH',
        headers: hdrs(key, { Prefer: 'return=representation' }),
        body: JSON.stringify({ since: new Date().toISOString(), detail: runId }),
      },
      5000
    );
    const rows = claim.ok ? await claim.json() : [];
    if (!rows.length) {
      return res.status(200).json({ run: runId, skipped: 'lock held by prior run' });
    }
  } catch (e) {
    console.error('db-health: lock claim err (continuing)', e.message);
  }

  // ---- 3. METRICS + CRON CHECKS ----------------------------------------
  try {
    const m = (await rpc(key, 'db_health_metrics'))[0] || {};
    const conns = m.total_conns ?? 0;
    results.connections =
      conns > T.connCrit
        ? { state: 'critical', detail: `${conns}/${m.max_conns} connections` }
        : conns > T.connWarn
        ? { state: 'warning', detail: `${conns}/${m.max_conns} connections` }
        : { state: 'healthy', detail: `${conns}/${m.max_conns}` };

    const slow = Number(m.longest_active_seconds || 0);
    results.slow_query =
      slow > T.slowQuerySec
        ? { state: 'warning', detail: `active query running ${slow}s` }
        : { state: 'healthy', detail: `longest ${slow}s` };
  } catch (e) {
    results.connections = { state: 'warning', detail: `metrics probe failed: ${e.message}` };
    results.slow_query = { state: 'healthy', detail: 'metrics unavailable' };
  }

  try {
    const jobs = (await rpc(key, 'recent_cron_failures')) || [];
    const bad = jobs.filter(
      (j) =>
        (j.consecutive_failures || 0) >= T.cronConsecFails ||
        Number(j.stuck_running_minutes || 0) >= T.cronStuckMin
    );
    results.cron_failures = bad.length
      ? {
          state: 'warning',
          detail: bad
            .map((j) => `${j.jobname || j.jobid}: ${j.consecutive_failures} fails, stuck ${j.stuck_running_minutes}m`)
            .join(' | ')
            .slice(0, 400),
        }
      : { state: 'healthy', detail: 'all crons ok' };
  } catch (e) {
    results.cron_failures = { state: 'warning', detail: `cron probe failed: ${e.message}` };
  }

  // ---- 4. STATE MACHINE + ALERTS ----------------------------------------
  let prev = [];
  try {
    const r = await fetchT(
      `${SUPABASE_URL}/rest/v1/health_alerts_state?select=*&condition=neq.watchdog_lock`,
      { headers: hdrs(key) },
      5000
    );
    prev = r.ok ? await r.json() : [];
  } catch (e) {
    console.error('db-health: state read err', e.message);
  }

  const nowIso = new Date().toISOString();
  const alerts = [];

  for (const [cond, cur] of Object.entries(results)) {
    const p = prev.find((x) => x.condition === cond) || { state: 'healthy', last_alert: null, since: nowIso };
    const wasBad = p.state !== 'healthy';
    const isBad = cur.state !== 'healthy';
    const patch = { detail: cur.detail };
    let alertNow = false, subject = '';

    if (!wasBad && isBad) {
      // healthy -> unhealthy: alert + reset since
      alertNow = true;
      patch.state = cur.state;
      patch.since = nowIso;
      subject = `[${cur.state.toUpperCase()}] iPrint ERP — ${cond}`;
    } else if (wasBad && isBad) {
      // still bad: escalation (warning->critical) alerts; else 24h reminder
      patch.state = cur.state;
      if (p.state === 'warning' && cur.state === 'critical') {
        alertNow = true;
        subject = `[CRITICAL] iPrint ERP — ${cond} escalated`;
      } else if (
        !p.last_alert ||
        Date.now() - new Date(p.last_alert).getTime() > T.reminderHours * 3600 * 1000
      ) {
        alertNow = true;
        subject = `[REMINDER] iPrint ERP — ${cond} still ${cur.state} since ${p.since}`;
      }
    } else if (wasBad && !isBad) {
      // recovered
      alertNow = true;
      patch.state = 'healthy';
      patch.since = nowIso;
      subject = `[RECOVERED] iPrint ERP — ${cond}`;
    } else {
      patch.state = 'healthy';
    }

    if (alertNow) {
      patch.last_alert = nowIso;
      alerts.push({ subject, body: `Condition: ${cond}\nState: ${cur.state}\nDetail: ${cur.detail}\nTime: ${nowIso}` });
    }

    try {
      await fetchT(
        `${SUPABASE_URL}/rest/v1/health_alerts_state?condition=eq.${cond}`,
        { method: 'PATCH', headers: hdrs(key), body: JSON.stringify(patch) },
        5000
      );
    } catch (e) {
      console.error(`db-health: state write err ${cond}`, e.message);
    }
  }

  for (const a of alerts) await sendEmail(a.subject, a.body);

  return res.status(200).json({
    run: runId,
    summary: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.state])),
    alertsSent: alerts.length,
  });
}
