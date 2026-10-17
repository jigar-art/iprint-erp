// api/file.js
// 17 Oct 2026: the Uploads bucket is private. The ERP rewrites every stored public file link
//   https://<project>.supabase.co/storage/v1/object/public/Uploads/<path>
// to /api/file?p=<path>. This route checks the caller is logged in (ERP session token in the
// erp_ft cookie set by the app, or a Bearer header) and redirects to a 1-hour signed link.
// The link is signed with the caller's own token, so storage's own access rules apply
// (no service key involved).
const SUPABASE_URL = 'https://idjeniwznjiaanaxcjvg.supabase.co';
const BUCKET = 'Uploads';

function tokenFrom(req) {
  const auth = String(req.headers?.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1];
  const c = String(req.headers?.cookie || '').match(/(?:^|;\s*)erp_ft=([^;]+)/);
  return c ? decodeURIComponent(c[1]) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).send('Method not allowed');
  }
  const p = String(req.query?.p || '').replace(/^\/+/, '');
  if (!p || p.length > 500 || p.split('/').some(s => s === '..' || s === '.')) {
    return res.status(400).send('Bad file path');
  }
  const token = tokenFrom(req);
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!token || !anon) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).send('Please log in to the ERP to open this file.');
  }
  const encPath = p.split('/').map(encodeURIComponent).join('/');
  try {
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${encPath}`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    const j = await r.json().catch(() => ({}));
    const signed = j.signedURL || j.signedUrl;
    if (!r.ok || !signed) {
      res.setHeader('Cache-Control', 'no-store');
      const notFound = r.status === 400 || r.status === 404 || /not found/i.test(JSON.stringify(j));
      return res.status(notFound ? 404 : 401).send(notFound ? 'File not found.' : 'Please log in to the ERP to open this file.');
    }
    const target = signed.startsWith('http') ? signed : `${SUPABASE_URL}/storage/v1${signed}`;
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Location', target);
    return res.status(302).end();
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).send('File service unavailable, try again.');
  }
}
