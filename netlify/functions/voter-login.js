'use strict';
const {
  db, respond, parseBody, handle, getSettings, computeStatus, STATUS_MESSAGE,
  signToken, audit, recentCount,
} = require('../lib/common');

const NIM_RE = /^[A-Z0-9._-]{3,30}$/;
const TOKEN_TTL = 10 * 60; // detik

exports.handler = handle('POST', async (event) => {
  const body = parseBody(event);
  if (body === null) return respond(400, { error: 'Format permintaan tidak valid.' });

  const nim = String(body.nim || '').trim().toUpperCase();
  if (!NIM_RE.test(nim)) return respond(400, { error: 'Format NIM tidak valid.' });

  // Batas percobaan gagal (anti tebak-tebakan NIM). Cukup longgar untuk acara on-site.
  if ((await recentCount('voter_login_failed', 10)) >= 30) {
    return respond(429, { error: 'Terlalu banyak percobaan gagal. Hubungi panitia.' });
  }

  const settings = await getSettings();
  const status = computeStatus(settings);
  if (status !== 'open') return respond(403, { error: STATUS_MESSAGE[status], status });

  const { data: voter, error } = await db()
    .from('voters')
    .select('id, nim, name, has_voted, checked_in')
    .eq('nim', nim)
    .maybeSingle();
  if (error) throw error;

  if (!voter) {
    await audit('system', 'voter_login_failed', { nim });
    return respond(401, { error: 'NIM tidak terdaftar sebagai pemilih. Hubungi panitia.' });
  }
  if (voter.has_voted) {
    return respond(409, { error: 'NIM ini sudah menggunakan hak pilih.' });
  }
  if (settings.require_checkin && !voter.checked_in) {
    return respond(403, { error: 'Anda belum diverifikasi panitia. Silakan lapor ke meja panitia.' });
  }

  const token = signToken({ role: 'voter', sub: voter.id }, TOKEN_TTL);
  await audit('voter:' + voter.nim, 'voter_login');
  return respond(200, { token, voter: { name: voter.name, nim: voter.nim }, expires_in: TOKEN_TTL });
});
