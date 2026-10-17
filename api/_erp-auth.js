// api/_erp-auth.js  (underscore prefix: helper module, not a route)
// 17 Oct 2026: verifies the ERP session token sent by the browser.
// The token is the JWT issued by the erp-login Edge Function. We ask Supabase who it
// belongs to (rpc erp_me_key). An invalid/expired token gets 401 from PostgREST or null.
const SUPABASE_URL = 'https://idjeniwznjiaanaxcjvg.supabase.co';

export async function erpUserFromRequest(req) {
  const auth = String(req.headers?.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!m || !anon) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/erp_me_key`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: `Bearer ${m[1]}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r.ok) return null;
    const who = await r.json().catch(() => null);
    return typeof who === 'string' && who ? who : null;
  } catch (e) {
    return null;
  }
}
