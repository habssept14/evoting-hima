'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class ConfigError extends Error {}

// ---------- Database ----------
let _db;
function db() {
  if (!_db) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new ConfigError('SUPABASE_URL dan SUPABASE_SERVICE_KEY belum diatur di Netlify.');
    _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _db;
}

// ---------- Token sesi (HMAC-SHA256, tanpa dependensi tambahan) ----------
function secret() {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 32) throw new ConfigError('TOKEN_SECRET belum diatur (minimal 32 karakter).');
  return s;
}

function signToken(payload, ttlSeconds) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const p = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(p).digest('base64url');
  return p + '.' + sig;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [p, sig] = parts;
  const expected = crypto.createHmac('sha256', secret()).update(p).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!body || typeof body.exp !== 'number' || body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

function bearer(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  return m ? m[1] : null;
}

function authAs(event, role) {
  const t = verifyToken(bearer(event));
  return t && t.role === role ? t : null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- HTTP ----------
function respond(status, data) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(data),
  };
}

// Mengembalikan null bila JSON rusak, {} bila body kosong.
function parseBody(event) {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

function handle(method, fn) {
  return async (event) => {
    if (event.httpMethod !== method) return respond(405, { error: 'Metode tidak diizinkan' });
    try {
      return await fn(event);
    } catch (e) {
      if (e instanceof HttpError) return respond(e.status, { error: e.message });
      if (e instanceof ConfigError) { console.error(e.message); return respond(500, { error: e.message }); }
      console.error(e);
      return respond(500, { error: 'Terjadi kesalahan pada server. Coba lagi atau hubungi panitia.' });
    }
  };
}

// ---------- Status pemilihan ----------
const STATUS_MESSAGE = {
  not_configured: 'Jadwal pemilihan belum diatur oleh panitia.',
  not_started: 'Pemungutan suara belum dimulai.',
  closed: 'Pemungutan suara sudah ditutup.',
  stopped: 'Pemungutan suara dihentikan sementara oleh panitia.',
};

function computeStatus(s, now = new Date()) {
  if (s.force_closed) return 'stopped';
  if (!s.start_at || !s.end_at) return 'not_configured';
  const t = now.getTime();
  if (t < new Date(s.start_at).getTime()) return 'not_started';
  if (t >= new Date(s.end_at).getTime()) return 'closed';
  return 'open';
}

async function getSettings() {
  const { data, error } = await db().from('settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data;
}

// ---------- Utilitas data ----------
async function count(table, filter) {
  let q = db().from(table).select('id', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  if (error) throw error;
  return n || 0;
}

async function audit(actor, action, detail) {
  try {
    await db().from('audit_log').insert({ actor, action, detail: detail ?? null });
  } catch (e) {
    console.error('audit gagal:', e.message);
  }
}

async function recentCount(action, minutes) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  return count('audit_log', (q) => q.eq('action', action).gte('at', since));
}

async function getResults() {
  const [c, t] = await Promise.all([
    db().from('candidates').select('id, number, name').order('number'),
    db().rpc('get_results'),
  ]);
  if (c.error) throw c.error;
  if (t.error) throw t.error;
  const totals = new Map((t.data || []).map((r) => [r.candidate_id, Number(r.total)]));
  return (c.data || []).map((x) => ({ id: x.id, number: x.number, name: x.name, total: totals.get(x.id) || 0 }));
}

module.exports = {
  HttpError, ConfigError, db, signToken, verifyToken, authAs, safeEqual,
  respond, parseBody, handle, STATUS_MESSAGE, computeStatus, getSettings,
  count, audit, recentCount, getResults,
};
