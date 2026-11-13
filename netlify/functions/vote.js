'use strict';
const { db, respond, parseBody, handle, authAs } = require('../lib/common');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOME = {
  closed: [403, 'Pemungutan suara sedang tidak dibuka.'],
  already_voted: [409, 'NIM ini sudah menggunakan hak pilih.'],
  not_checked_in: [403, 'Anda belum diverifikasi panitia.'],
  candidate_not_found: [404, 'Kandidat tidak ditemukan. Muat ulang halaman.'],
  voter_not_found: [401, 'Data pemilih tidak ditemukan. Hubungi panitia.'],
};

exports.handler = handle('POST', async (event) => {
  const auth = authAs(event, 'voter');
  if (!auth) return respond(401, { error: 'Sesi berakhir. Masuk kembali dengan NIM Anda.', code: 'session' });

  const body = parseBody(event);
  const candidateId = body ? String(body.candidate_id || '') : '';
  if (!UUID_RE.test(candidateId)) return respond(400, { error: 'Pilihan tidak valid.' });

  const { data, error } = await db().rpc('cast_vote', { p_voter_id: auth.sub, p_candidate_id: candidateId });
  if (error) throw error;

  if (data === 'ok') return respond(200, { ok: true });
  const [status, message] = OUTCOME[data] || [500, 'Suara gagal disimpan. Hubungi panitia.'];
  return respond(status, { error: message, code: data });
});
