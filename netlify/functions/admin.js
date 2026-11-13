'use strict';
const {
  HttpError, db, respond, parseBody, handle, authAs, getSettings, computeStatus,
  count, audit, getResults,
} = require('../lib/common');

const MAX_CANDIDATES = 2; // sesuai kebutuhan: 2 calon wakil ketua
const MAX_IMPORT = 500;
const MAX_PHOTO_CHARS = 400000;
const NIM_RE = /^[A-Z0-9._-]{3,30}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const bad = (msg) => new HttpError(400, msg);
const requireId = (id) => {
  if (!UUID_RE.test(String(id || ''))) throw bad('ID tidak valid.');
  return String(id);
};

function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw bad('Format tanggal/waktu tidak valid.');
  return d;
}

async function candidatesLocked() {
  const status = computeStatus(await getSettings());
  if (status === 'open') return true;
  return (await count('votes')) > 0;
}

const LOCK_MESSAGE =
  'Kandidat terkunci karena pemungutan suara sedang berjalan atau sudah ada suara masuk. ' +
  'Untuk mengubah, reset data uji coba terlebih dahulu di Pengaturan.';

const actions = {
  async overview() {
    const settings = await getSettings();
    const [candidates, totalVoters, voted, checkedIn, votes, results] = await Promise.all([
      db().from('candidates').select('*').order('number'),
      count('voters'),
      count('voters', (q) => q.eq('has_voted', true)),
      count('voters', (q) => q.eq('checked_in', true)),
      count('votes'),
      getResults(),
    ]);
    if (candidates.error) throw candidates.error;
    const status = computeStatus(settings);
    return {
      settings,
      status,
      server_time: new Date().toISOString(),
      candidates: candidates.data,
      candidates_locked: status === 'open' || votes > 0,
      max_candidates: MAX_CANDIDATES,
      totals: { voters: totalVoters, voted, checked_in: checkedIn, votes },
      results,
    };
  },

  async settings_save(b) {
    const name = String(b.election_name || '').trim().slice(0, 120);
    if (!name) throw bad('Nama pemilihan wajib diisi.');
    const start = parseDate(b.start_at);
    const end = parseDate(b.end_at);
    if (!!start !== !!end) throw bad('Isi waktu mulai dan waktu selesai sekaligus.');
    if (start && end <= start) throw bad('Waktu selesai harus setelah waktu mulai.');

    const patch = {
      election_name: name,
      start_at: start ? start.toISOString() : null,
      end_at: end ? end.toISOString() : null,
      force_closed: !!b.force_closed,
      results_public: !!b.results_public,
      require_checkin: !!b.require_checkin,
    };
    const { error } = await db().from('settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);
    if (error) throw error;
    await audit('admin', 'settings_save', patch);
    const settings = await getSettings();
    return { settings, status: computeStatus(settings) };
  },

  async candidate_save(b) {
    if (await candidatesLocked()) throw new HttpError(409, LOCK_MESSAGE);

    const number = Number(b.number);
    if (!Number.isInteger(number) || number < 1 || number > 99) throw bad('Nomor urut harus angka 1 sampai 99.');
    const name = String(b.name || '').trim().slice(0, 100);
    if (!name) throw bad('Nama kandidat wajib diisi.');
    const photo = b.photo ? String(b.photo) : null;
    if (photo && (photo.length > MAX_PHOTO_CHARS || !PHOTO_RE.test(photo))) {
      throw bad('Foto tidak valid atau terlalu besar. Gunakan JPG, PNG, atau WebP.');
    }
    const row = {
      number,
      name,
      photo,
      vision: String(b.vision || '').trim().slice(0, 1000),
      mission: String(b.mission || '').trim().slice(0, 2000),
    };

    let result;
    if (b.id) {
      const id = requireId(b.id);
      result = await db().from('candidates').update(row).eq('id', id).select('id').maybeSingle();
      if (!result.error && !result.data) throw new HttpError(404, 'Kandidat tidak ditemukan.');
    } else {
      if ((await count('candidates')) >= MAX_CANDIDATES) {
        throw new HttpError(409, `Jumlah kandidat dibatasi ${MAX_CANDIDATES} orang.`);
      }
      result = await db().from('candidates').insert(row).select('id').single();
    }
    if (result.error) {
      if (result.error.code === '23505') throw new HttpError(409, 'Nomor urut sudah dipakai kandidat lain.');
      throw result.error;
    }
    await audit('admin', b.id ? 'candidate_update' : 'candidate_create', { number, name });
    return { ok: true, id: result.data.id };
  },

  async candidate_delete(b) {
    if (await candidatesLocked()) throw new HttpError(409, LOCK_MESSAGE);
    const id = requireId(b.id);
    const { data: cand, error: e1 } = await db().from('candidates').select('number, name').eq('id', id).maybeSingle();
    if (e1) throw e1;
    if (!cand) throw new HttpError(404, 'Kandidat tidak ditemukan.');
    const { error } = await db().from('candidates').delete().eq('id', id);
    if (error) throw error;
    await audit('admin', 'candidate_delete', cand);
    return { ok: true };
  },

  async voters_list() {
    const { data, error } = await db()
      .from('voters')
      .select('id, nim, name, checked_in, checked_in_at, has_voted, voted_at')
      .order('nim');
    if (error) throw error;
    return { voters: data };
  },

  async voters_import(b) {
    const rows = Array.isArray(b.rows) ? b.rows : null;
    if (!rows || !rows.length) throw bad('Tidak ada data pemilih untuk diimpor.');
    if (rows.length > MAX_IMPORT) throw bad(`Maksimal ${MAX_IMPORT} baris sekali impor.`);

    const seen = new Set();
    const valid = [];
    const invalid = [];
    let duplicateInInput = 0;
    for (const r of rows) {
      const nim = String((r && r.nim) || '').trim().toUpperCase();
      const name = String((r && r.name) || '').trim().slice(0, 100);
      if (!NIM_RE.test(nim)) { invalid.push({ nim: nim.slice(0, 30), reason: 'Format NIM tidak valid' }); continue; }
      if (!name) { invalid.push({ nim, reason: 'Nama kosong' }); continue; }
      if (seen.has(nim)) { duplicateInInput++; continue; }
      seen.add(nim);
      valid.push({ nim, name });
    }

    let inserted = 0;
    if (valid.length) {
      const { data, error } = await db()
        .from('voters')
        .upsert(valid, { onConflict: 'nim', ignoreDuplicates: true })
        .select('id');
      if (error) throw error;
      inserted = data ? data.length : 0;
    }
    const result = {
      inserted,
      skipped_existing: valid.length - inserted,
      duplicate_in_input: duplicateInInput,
      invalid,
    };
    await audit('admin', 'voters_import', {
      submitted: rows.length, inserted, skipped_existing: result.skipped_existing, invalid: invalid.length,
    });
    return result;
  },

  async voter_delete(b) {
    const id = requireId(b.id);
    const { data: v, error: e1 } = await db().from('voters').select('nim, has_voted').eq('id', id).maybeSingle();
    if (e1) throw e1;
    if (!v) throw new HttpError(404, 'Pemilih tidak ditemukan.');
    if (v.has_voted) throw new HttpError(409, 'Pemilih yang sudah memilih tidak dapat dihapus.');
    const { error } = await db().from('voters').delete().eq('id', id);
    if (error) throw error;
    await audit('admin', 'voter_delete', { nim: v.nim });
    return { ok: true };
  },

  async voter_checkin(b) {
    const id = requireId(b.id);
    const checkedIn = !!b.checked_in;
    const { data: v, error: e1 } = await db().from('voters').select('nim').eq('id', id).maybeSingle();
    if (e1) throw e1;
    if (!v) throw new HttpError(404, 'Pemilih tidak ditemukan.');
    const { error } = await db()
      .from('voters')
      .update({ checked_in: checkedIn, checked_in_at: checkedIn ? new Date().toISOString() : null })
      .eq('id', id);
    if (error) throw error;
    await audit('admin', 'voter_checkin', { nim: v.nim, checked_in: checkedIn });
    return { ok: true };
  },

  async audit_list() {
    const { data, error } = await db()
      .from('audit_log')
      .select('id, at, actor, action, detail')
      .order('id', { ascending: false })
      .limit(300);
    if (error) throw error;
    return { entries: data };
  },

  async reset_election(b) {
    if (b.confirm !== 'RESET') throw bad('Ketik RESET untuk mengonfirmasi.');
    if (computeStatus(await getSettings()) === 'open') {
      throw new HttpError(409, 'Suara tidak dapat direset saat pemungutan suara sedang dibuka. Hentikan pemungutan suara terlebih dahulu di Pengaturan.');
    }
    const { error } = await db().rpc('reset_election');
    if (error) throw error;
    await audit('admin', 'reset_election');
    return { ok: true };
  },
};

exports.handler = handle('POST', async (event) => {
  if (!authAs(event, 'admin')) {
    return respond(401, { error: 'Sesi panitia berakhir. Masuk kembali.', code: 'session' });
  }
  const body = parseBody(event);
  if (!body || typeof body.action !== 'string') return respond(400, { error: 'Permintaan tidak valid.' });
  if (!Object.hasOwn(actions, body.action)) return respond(400, { error: 'Aksi tidak dikenal.' });
  const data = await actions[body.action](body);
  return respond(200, data === undefined ? { ok: true } : data);
});
