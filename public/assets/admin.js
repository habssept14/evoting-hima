/* Halaman panitia: ringkasan live, kandidat, pemilih, pengaturan, laporan, log audit. */
(function () {
  'use strict';
  const { api, h, clear, $, fmtDateTime, fmtTime, toInputValue, fromInputValue, statusChip, clock, leaderOf, toast } = App;

  const TOKEN_KEY = 'hima_admin_token';
  const POLL_MS = 4000;
  const TABS = ['ringkasan', 'kandidat', 'pemilih', 'pengaturan', 'laporan', 'log'];

  const store = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
    set(v) { try { sessionStorage.setItem(TOKEN_KEY, v); } catch (e) { /* abaikan */ } },
    del() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* abaikan */ } },
  };

  const state = {
    token: store.get(), tab: 'ringkasan', overview: null, status: null,
    voters: [], q: '', filter: 'all', editing: null, poll: null,
  };

  // ---------- API ----------
  const isSession = (e) => e.status === 401 && e.data && e.data.code === 'session';

  async function call(action, payload) {
    try {
      return await api('admin', { token: state.token, body: Object.assign({ action }, payload || {}) });
    } catch (e) {
      if (isSession(e)) signOut('Sesi panitia berakhir. Masuk kembali.');
      throw e;
    }
  }
  function fail(e) { if (!isSession(e)) toast(e.message, 'bad'); }

  // ---------- Masuk dan keluar ----------
  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('#login-err');
    err.hidden = true;
    try {
      const r = await api('admin-login', { body: { password: $('#pw').value } });
      state.token = r.token;
      store.set(r.token);
      $('#pw').value = '';
      await enter();
    } catch (e) {
      if (!isSession(e)) { err.textContent = e.message; err.hidden = false; }
    }
  });
  $('#logout-btn').addEventListener('click', () => signOut());

  async function enter() {
    await loadOverview();
    $('#login-view').hidden = true;
    $('#app').hidden = false;
    $('#bar-right').hidden = false;
    selectTab(state.tab);
  }

  function signOut(message) {
    stopPoll();
    state.token = null;
    state.overview = null;
    store.del();
    $('#app').hidden = true;
    $('#bar-right').hidden = true;
    $('#login-view').hidden = false;
    $('#election-name').textContent = 'Panel panitia';
    document.title = 'Panitia';
    const err = $('#login-err');
    err.textContent = message || '';
    err.hidden = !message;
    $('#pw').focus();
  }

  // ---------- Data bersama ----------
  async function loadOverview() {
    const o = await call('overview');
    state.overview = o;
    state.status = o.status;
    clock.sync(o.server_time);
    renderHeader();
    return o;
  }

  async function loadVoters() {
    state.voters = (await call('voters_list')).voters;
  }

  function renderHeader() {
    const o = state.overview;
    if (!o) return;
    $('#election-name').textContent = o.settings.election_name;
    document.title = 'Panitia: ' + o.settings.election_name;
    clear($('#status-chip')).appendChild(statusChip(state.status));
  }

  // ---------- Tab / Sidebar ----------
  document.querySelectorAll('.sidebar-item[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  async function selectTab(name) {
    if (!TABS.includes(name)) name = 'ringkasan';
    state.tab = name;
    stopPoll();
    // Update active state sidebar
    document.querySelectorAll('.sidebar-item[data-tab]').forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    TABS.forEach((t) => { $('#tab-' + t).hidden = t !== name; });
    try {
      if (name === 'ringkasan') { buildSummary(); startPoll(); }
      else if (name === 'kandidat') { await loadOverview(); state.editing = null; renderCandidates(); }
      else if (name === 'pemilih') { await loadVoters(); buildVoters(); }
      else if (name === 'pengaturan') { await loadOverview(); renderSettings(); }
      else if (name === 'laporan') { await Promise.all([loadOverview(), loadVoters()]); renderReport(); }
      else if (name === 'log') { await renderAudit(); }
    } catch (e) { fail(e); }
  }

  // ---------- Dialog konfirmasi ----------
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const root = $('#modal-root');
      const done = (v) => { clear(root); resolve(v); };
      const yes = h('button', { class: 'btn' + (opts.danger ? ' danger' : ''), type: 'button', onclick: () => done(true) }, opts.confirm || 'Ya');
      const no = h('button', { class: 'btn secondary', type: 'button', onclick: () => done(false) }, 'Batal');
      const dlg = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cd-title' },
        h('h2', { id: 'cd-title', text: opts.title }),
        h('p', { text: opts.text }),
        h('div', { class: 'modal-actions' }, yes, no));
      dlg.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') done(false);
        if (e.key === 'Tab') { e.preventDefault(); (document.activeElement === yes ? no : yes).focus(); }
      });
      root.appendChild(h('div', { class: 'modal-backdrop' }, dlg));
      no.focus();
    });
  }

  // =====================================================================
  // Ringkasan
  // =====================================================================
  const sum = {};

  function statCell(valueEl, label) {
    return h('div', null, valueEl, h('div', { class: 'stat-l', text: label }));
  }

  function buildSummary() {
    sum.note = h('div', { class: 'note', hidden: true });
    // Stat cards berwarna per jenis (Sovereign Dark)
    sum.totalEl = h('div', { class: 'stat-n', text: '-' });
    sum.votedEl = h('div', { class: 'stat-n', text: '-' });
    sum.leftEl  = h('div', { class: 'stat-n', text: '-' });
    sum.pctEl   = h('div', { class: 'stat-n', text: '-' });
    // Alias lama untuk kompatibilitas renderSummary
    sum.total = sum.totalEl;
    sum.voted = sum.votedEl;
    sum.left  = sum.leftEl;
    sum.pct   = sum.pctEl;
    sum.conn = h('span', { class: 'muted small', role: 'status' });
    sum.results = h('div', { class: 'res-list' });
    sum.check = h('ul', { class: 'checklist' });

    const iconVoters = h('div', { class: 'stat-icon' },
      h('svg', { width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', viewBox: '0 0 24 24' },
        h('path', { d: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2' }),
        h('circle', { cx: '9', cy: '7', r: '4' }),
        h('path', { d: 'M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' })));
    const iconVoted = h('div', { class: 'stat-icon' },
      h('svg', { width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', viewBox: '0 0 24 24' },
        h('polyline', { points: '9 11 12 14 22 4' }),
        h('path', { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' })));
    const iconLeft = h('div', { class: 'stat-icon' },
      h('svg', { width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', viewBox: '0 0 24 24' },
        h('circle', { cx: '12', cy: '12', r: '10' }),
        h('polyline', { points: '12 6 12 12 16 14' })));
    const iconPct = h('div', { class: 'stat-icon' },
      h('svg', { width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', viewBox: '0 0 24 24' },
        h('line', { x1: '18', y1: '20', x2: '18', y2: '10' }),
        h('line', { x1: '12', y1: '20', x2: '12', y2: '4' }),
        h('line', { x1: '6', y1: '20', x2: '6', y2: '14' })));

    clear($('#tab-ringkasan')).append(
      h('div', { class: 'admin-section' },
        sum.note,
        h('div', { class: 'stat-cards' },
          h('div', { class: 'stat-card c1' }, iconVoters, sum.totalEl, h('div', { class: 'stat-l', text: 'Pemilih terdaftar' })),
          h('div', { class: 'stat-card c2' }, iconVoted,  sum.votedEl, h('div', { class: 'stat-l', text: 'Sudah memilih' })),
          h('div', { class: 'stat-card c3' }, iconLeft,   sum.leftEl,  h('div', { class: 'stat-l', text: 'Belum memilih' })),
          h('div', { class: 'stat-card c4' }, iconPct,    sum.pctEl,   h('div', { class: 'stat-l', text: 'Partisipasi' }))),
        h('div', { class: 'panel' },
          h('div', { class: 'row between' }, h('h2', { text: 'Perolehan suara' }), sum.conn),
          sum.results),
        h('div', { class: 'panel' }, h('h2', { text: 'Kesiapan sistem' }), sum.check),
        h('div', { class: 'panel' },
          h('h2', { text: 'Layar hasil di perangkat lain' }),
          h('p', { text: 'Buka alamat berikut di laptop atau proyektor lain. Layar diperbarui otomatis setiap 3 detik.' }),
          h('p', { class: 'num', style: 'font-weight:600; margin:8px 0 14px; color:var(--cyan)', text: location.origin + '/hasil.html' }),
          h('a', { class: 'btn secondary', href: '/hasil.html', target: '_blank', rel: 'noopener' }, 'Buka layar hasil'))));
  }

  function startPoll() {
    pollSummary();
    state.poll = setInterval(pollSummary, POLL_MS);
  }
  function stopPoll() { clearInterval(state.poll); state.poll = null; }

  async function pollSummary() {
    try {
      const live = await api('live', { token: state.token });
      clock.sync(live.server_time);
      state.status = live.status;
      if (state.overview) state.overview.settings.election_name = live.election_name;
      renderHeader();
      if (state.tab === 'ringkasan') renderSummary(live);
    } catch (e) {
      if (e.status === 401) signOut('Sesi panitia berakhir. Masuk kembali.');
      else if (sum.conn) sum.conn.textContent = 'Terputus. Mencoba lagi...';
    }
  }

  const STATUS_NOTE = {
    not_configured: ['warn', () => 'Jadwal belum diatur. Buka Pengaturan untuk menetapkan waktu mulai dan selesai.'],
    not_started: ['warn', (l) => 'Pemungutan suara dimulai ' + fmtDateTime(l.start_at) + '.'],
    open: ['ok', (l) => 'Pemungutan suara dibuka sampai ' + fmtDateTime(l.end_at) + '.'],
    closed: ['bad', () => 'Pemungutan suara sudah ditutup. Berita acara dan unduhan ada di tab Laporan.'],
    stopped: ['bad', () => 'Pemungutan suara dihentikan sementara. Matikan "Hentikan pemungutan suara" di Pengaturan untuk melanjutkan.'],
  };

  function renderSummary(live) {
    const total = live.total_voters;
    const voted = live.voted;
    sum.conn.textContent = '';
    sum.total.textContent = total;
    sum.voted.textContent = voted;
    sum.left.textContent = total - voted;
    sum.pct.textContent = (total ? Math.round((voted / total) * 100) : 0) + '%';

    const n = STATUS_NOTE[live.status];
    sum.note.hidden = !n;
    if (n) { sum.note.className = 'note ' + n[0]; sum.note.textContent = n[1](live); }

    const res = live.results || [];
    const votes = res.reduce((a, r) => a + r.total, 0);
    const lead = leaderOf(res);
    clear(sum.results);
    if (!res.length) sum.results.appendChild(h('p', { class: 'empty', text: 'Belum ada kandidat.' }));
    res.forEach((r) => {
      const pct = votes ? Math.round((r.total / votes) * 100) : 0;
      let tag = '';
      if (lead.id === r.id) tag = live.status === 'closed' ? 'Terpilih' : 'Memimpin';
      else if (lead.tie && r.total === lead.max) tag = 'Suara seri';
      sum.results.appendChild(h('div', { class: 'res-row' },
        h('span', { class: 'numeral', 'aria-hidden': 'true', text: r.number }),
        h('div', null,
          h('div', { class: 'res-meta' },
            h('span', { class: 'res-name' }, r.name, tag ? h('span', { class: 'tag', text: tag }) : null),
            h('span', { class: 'res-count' }, String(r.total), h('small', { text: pct + '%' }))),
          h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + pct + '%' })))));
    });

    const items = [
      [res.length >= 2, res.length >= 2 ? res.length + ' kandidat terdaftar' : 'Kandidat belum lengkap (' + res.length + ' dari 2). Tambahkan di tab Kandidat.'],
      [total > 0, total > 0 ? total + ' pemilih terdaftar' : 'Belum ada pemilih. Impor daftar di tab Pemilih.'],
      [!!live.start_at, live.start_at ? 'Jadwal: ' + fmtDateTime(live.start_at) + ' sampai ' + fmtDateTime(live.end_at) : 'Jadwal belum diatur. Atur di tab Pengaturan.'],
    ];
    clear(sum.check);
    items.forEach(([ok, text]) => sum.check.appendChild(h('li', null, h('span', { class: 'tick' + (ok ? ' is-ok' : ''), 'aria-hidden': 'true' }), h('span', { text }))));
  }

  // =====================================================================
  // Kandidat
  // =====================================================================
  function renderCandidates() {
    const o = state.overview;
    const full = o.candidates.length >= o.max_candidates;
    const panel = clear($('#tab-kandidat'));
    panel.append(
      h('div', { class: 'panel' },
        h('div', { class: 'row between', style: 'margin-bottom:14px' },
          h('h2', { style: 'margin:0', text: 'Kandidat' }),
          h('button', {
            class: 'btn', type: 'button', disabled: o.candidates_locked || full,
            onclick: () => { state.editing = {}; renderCandidates(); },
          }, 'Tambah kandidat')),
        o.candidates_locked
          ? h('div', { class: 'note warn', style: 'margin-bottom:8px', text: 'Kandidat terkunci karena pemungutan suara sedang berjalan atau sudah ada suara masuk. Untuk mengubah, reset data uji coba di Pengaturan.' })
          : null,
        o.candidates.length
          ? o.candidates.map(candidateRow)
          : h('p', { class: 'empty', text: 'Belum ada kandidat. Tambahkan 2 calon wakil ketua.' })),
      state.editing ? candidateForm(state.editing) : null);
  }

  function candidateRow(c) {
    const o = state.overview;
    const thumb = h('div', { class: 'thumb' }, c.photo ? h('img', { src: c.photo, alt: 'Foto ' + c.name }) : String(c.number));
    const brief = (c.vision || '').length > 150 ? c.vision.slice(0, 150) + '...' : (c.vision || 'Visi belum diisi.');
    return h('div', { class: 'acand' },
      thumb,
      h('div', null, h('h3', { text: c.number + '. ' + c.name }), h('p', { class: 'muted', text: brief })),
      h('div', { class: 'row' },
        h('button', { class: 'btn secondary small', type: 'button', disabled: o.candidates_locked, onclick: () => { state.editing = c; renderCandidates(); } }, 'Ubah'),
        h('button', { class: 'btn secondary small', type: 'button', disabled: o.candidates_locked, onclick: () => removeCandidate(c) }, 'Hapus')));
  }

  async function removeCandidate(c) {
    const ok = await confirmDialog({ title: 'Hapus kandidat?', text: 'Kandidat nomor ' + c.number + ', ' + c.name + ', akan dihapus dari daftar.', confirm: 'Hapus kandidat', danger: true });
    if (!ok) return;
    try {
      await call('candidate_delete', { id: c.id });
      toast('Kandidat dihapus');
      await loadOverview();
      renderCandidates();
    } catch (e) { fail(e); }
  }

  function nextNumber() {
    const used = new Set(state.overview.candidates.map((c) => c.number));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { reject(new Error('Gunakan berkas JPG, PNG, atau WebP.')); return; }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Berkas tidak dapat dibaca.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Berkas gambar tidak dapat dibaca.'));
        img.onload = () => {
          const scale = Math.min(1, 900 / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const hgt = Math.round(img.height * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = hgt;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, hgt);
          ctx.drawImage(img, 0, 0, w, hgt);
          let q = 0.85;
          let out = canvas.toDataURL('image/jpeg', q);
          while (out.length > 350000 && q > 0.4) { q -= 0.1; out = canvas.toDataURL('image/jpeg', q); }
          if (out.length > 390000) reject(new Error('Foto terlalu besar. Pilih foto lain.'));
          else resolve(out);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function candidateForm(c) {
    const draft = { photo: c.photo || null };
    const num = h('input', { id: 'f-num', type: 'number', min: '1', max: '99', value: String(c.number || nextNumber()) });
    const name = h('input', { id: 'f-name', type: 'text', maxlength: '100', value: c.name || '' });
    const vision = h('textarea', { id: 'f-vision', rows: '3', maxlength: '1000' }, c.vision || '');
    const mission = h('textarea', { id: 'f-mission', rows: '5', maxlength: '2000' }, c.mission || '');
    const preview = h('div', { class: 'photo-preview' });
    const paint = () => {
      clear(preview);
      if (draft.photo) preview.appendChild(h('img', { src: draft.photo, alt: 'Pratinjau foto' }));
      else preview.textContent = 'Belum ada foto';
    };
    paint();
    const file = h('input', { id: 'f-photo', type: 'file', accept: 'image/jpeg,image/png,image/webp' });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      if (!f) return;
      try { draft.photo = await resizeImage(f); paint(); } catch (e) { toast(e.message, 'bad'); file.value = ''; }
    });
    const removePhoto = h('button', { class: 'btn secondary small', type: 'button', onclick: () => { draft.photo = null; file.value = ''; paint(); } }, 'Hapus foto');
    const save = h('button', { class: 'btn', type: 'submit' }, 'Simpan kandidat');

    const form = h('form', { class: 'panel stack', novalidate: true },
      h('h2', { style: 'margin:0', text: c.id ? 'Ubah kandidat' : 'Tambah kandidat' }),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 'f-num', text: 'Nomor urut' }), num),
        h('div', { class: 'field' }, h('label', { for: 'f-name', text: 'Nama lengkap' }), name)),
      h('div', { class: 'field' },
        h('label', { for: 'f-photo', text: 'Foto' }),
        h('div', { class: 'row', style: 'align-items:flex-start; gap:20px' },
          preview,
          h('div', { class: 'stack', style: 'gap:10px' },
            file,
            h('span', { class: 'hint', text: 'JPG, PNG, atau WebP. Ukuran dikecilkan otomatis.' }),
            h('div', null, removePhoto)))),
      h('div', { class: 'field' }, h('label', { for: 'f-vision', text: 'Visi' }), vision),
      h('div', { class: 'field' }, h('label', { for: 'f-mission', text: 'Misi' }), mission, h('span', { class: 'hint', text: 'Tulis satu poin per baris.' })),
      h('div', { class: 'row' }, save,
        h('button', { class: 'btn secondary', type: 'button', onclick: () => { state.editing = null; renderCandidates(); } }, 'Batal')));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      save.disabled = true;
      try {
        await call('candidate_save', {
          id: c.id || undefined, number: Number(num.value), name: name.value,
          photo: draft.photo, vision: vision.value, mission: mission.value,
        });
        toast('Kandidat disimpan');
        state.editing = null;
        await loadOverview();
        renderCandidates();
      } catch (e) { fail(e); save.disabled = false; }
    });
    return form;
  }

  // =====================================================================
  // Pemilih
  // =====================================================================
  const vt = {};

  function parseVoterText(text) {
    const rows = [];
    text.split(/\r?\n/).forEach((raw) => {
      const line = raw.trim();
      if (!line) return;
      const parts = line.split(/[;\t,]/).map((s) => s.trim().replace(/^"|"$/g, '').trim());
      let nim;
      let name;
      if (parts.length >= 2) { nim = parts[0]; name = parts.slice(1).filter(Boolean).join(', '); }
      else {
        const sp = line.match(/^(\S+)\s+(.+)$/);
        if (sp) { nim = sp[1]; name = sp[2]; } else { nim = line; name = ''; }
      }
      rows.push({ nim, name });
    });
    if (rows.length && /^nim$/i.test(rows[0].nim)) rows.shift();   // lewati baris judul
    return rows;
  }

  function buildVoters() {
    vt.summary = h('p', { class: 'muted' });
    vt.result = h('div', { hidden: true });
    vt.text = h('textarea', { id: 'imp-text', rows: '6', placeholder: '2101, Sari Wulandari\n2102, Tono Prasetyo' });
    vt.preview = h('p', { class: 'muted small' });
    vt.file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', 'aria-label': 'Pilih berkas CSV' });
    vt.importBtn = h('button', { class: 'btn', type: 'button' }, 'Tambahkan pemilih');
    vt.search = h('input', { type: 'search', placeholder: 'Cari NIM atau nama', 'aria-label': 'Cari pemilih' });
    vt.filter = h('select', { 'aria-label': 'Saring pemilih' },
      h('option', { value: 'all', text: 'Semua pemilih' }),
      h('option', { value: 'voted', text: 'Sudah memilih' }),
      h('option', { value: 'not_voted', text: 'Belum memilih' }),
      h('option', { value: 'not_checked', text: 'Belum hadir' }));
    vt.body = h('tbody');

    vt.text.addEventListener('input', updateImportPreview);
    vt.file.addEventListener('change', () => {
      const f = vt.file.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => { vt.text.value = String(r.result || '').replace(/^﻿/, ''); updateImportPreview(); };
      r.readAsText(f);
    });
    vt.importBtn.addEventListener('click', doImport);
    vt.search.addEventListener('input', () => { state.q = vt.search.value.trim().toLowerCase(); renderVoterRows(); });
    vt.filter.addEventListener('change', () => { state.filter = vt.filter.value; renderVoterRows(); });
    vt.search.value = '';
    state.q = '';
    state.filter = 'all';

    clear($('#tab-pemilih')).append(
      h('div', { class: 'stack' },
        h('div', { class: 'panel' },
          h('h2', { text: 'Tambah pemilih' }),
          h('div', { class: 'stack' },
            h('p', { class: 'muted', text: 'Tempel daftar pemilih, satu orang per baris: NIM lalu nama, dipisah koma, titik koma, atau tab. Dari Excel, salin dua kolom lalu tempel di sini. Bisa juga memilih berkas CSV.' }),
            vt.text, vt.preview,
            h('div', { class: 'row' }, vt.importBtn, vt.file),
            vt.result)),
        h('div', { class: 'panel' },
          h('div', { class: 'row between', style: 'margin-bottom:12px' },
            h('h2', { style: 'margin:0', text: 'Daftar pemilih' }),
            h('div', { class: 'row' },
              h('div', { style: 'width:240px' }, vt.search),
              h('div', { style: 'width:190px' }, vt.filter))),
          vt.summary,
          h('div', { class: 'table-wrap', style: 'margin-top:12px' },
            h('table', { class: 'table' },
              h('thead', null, h('tr', null,
                h('th', { text: 'NIM' }), h('th', { text: 'Nama' }), h('th', { text: 'Hadir' }),
                h('th', { text: 'Status' }), h('th', { text: 'Waktu memilih' }), h('th', { class: 'r', text: 'Aksi' }))),
              vt.body)))));
    updateImportPreview();
    renderVoterRows();
  }

  function updateImportPreview() {
    const rows = parseVoterText(vt.text.value);
    const noName = rows.filter((r) => !r.name).length;
    vt.preview.textContent = rows.length
      ? rows.length + ' baris terbaca' + (noName ? ', ' + noName + ' tanpa nama (akan ditolak).' : '.')
      : '';
  }

  function showImportResult(text, tone, details) {
    vt.result.className = 'note ' + tone;
    clear(vt.result).append(
      h('p', { text }),
      details.length ? h('ul', { style: 'margin:8px 0 0; padding-left:1.2em' }, details.map((d) => h('li', { text: d }))) : null);
    vt.result.hidden = false;
  }

  async function doImport() {
    const rows = parseVoterText(vt.text.value);
    if (!rows.length) { toast('Tempel daftar pemilih terlebih dahulu.', 'bad'); return; }
    vt.importBtn.disabled = true;
    try {
      const r = await call('voters_import', { rows });
      const parts = [r.inserted + ' pemilih ditambahkan'];
      if (r.skipped_existing) parts.push(r.skipped_existing + ' sudah terdaftar');
      if (r.duplicate_in_input) parts.push(r.duplicate_in_input + ' baris ganda');
      if (r.invalid.length) parts.push(r.invalid.length + ' baris tidak valid');
      const details = r.invalid.slice(0, 5).map((i) => (i.nim || '(kosong)') + ': ' + i.reason);
      if (r.invalid.length > 5) details.push('dan ' + (r.invalid.length - 5) + ' baris lainnya');
      showImportResult(parts.join(', ') + '.', r.invalid.length ? 'warn' : 'ok', details);
      if (r.inserted && !r.invalid.length) { vt.text.value = ''; vt.file.value = ''; }
      await loadVoters();
      renderVoterRows();
      updateImportPreview();
    } catch (e) { fail(e); } finally { vt.importBtn.disabled = false; }
  }

  function renderVoterRows() {
    const all = state.voters;
    const q = state.q;
    const list = all.filter((v) => {
      if (q && !(v.nim.toLowerCase().includes(q) || v.name.toLowerCase().includes(q))) return false;
      if (state.filter === 'voted') return v.has_voted;
      if (state.filter === 'not_voted') return !v.has_voted;
      if (state.filter === 'not_checked') return !v.checked_in;
      return true;
    });
    const voted = all.filter((v) => v.has_voted).length;
    const here = all.filter((v) => v.checked_in).length;
    vt.summary.textContent = all.length + ' pemilih, ' + voted + ' sudah memilih, ' + here + ' sudah hadir.' +
      (list.length !== all.length ? ' Menampilkan ' + list.length + '.' : '');

    clear(vt.body);
    if (!list.length) {
      vt.body.appendChild(h('tr', null, h('td', { colspan: '6', class: 'empty', text: all.length ? 'Tidak ada pemilih yang cocok.' : 'Belum ada pemilih. Tempel daftar di atas.' })));
      return;
    }
    list.forEach((v) => {
      const box = h('input', { type: 'checkbox', checked: v.checked_in, disabled: v.has_voted, 'aria-label': 'Hadir: ' + v.name });
      box.addEventListener('change', async () => {
        const want = box.checked;
        box.disabled = true;
        try {
          await call('voter_checkin', { id: v.id, checked_in: want });
          v.checked_in = want;
        } catch (e) { box.checked = !want; fail(e); }
        box.disabled = false;
        renderVoterRows();
      });
      vt.body.appendChild(h('tr', null,
        h('td', { class: 'num', text: v.nim }),
        h('td', { text: v.name }),
        h('td', null, box),
        h('td', null, h('span', { class: 'chip ' + (v.has_voted ? 'ok' : ''), text: v.has_voted ? 'Sudah memilih' : 'Belum memilih' })),
        h('td', { class: 'num', text: v.voted_at ? fmtTime(v.voted_at) : '-' }),
        h('td', { class: 'r' }, h('button', {
          class: 'btn secondary small', type: 'button', disabled: v.has_voted,
          onclick: () => removeVoter(v),
        }, 'Hapus'))));
    });
  }

  async function removeVoter(v) {
    const ok = await confirmDialog({ title: 'Hapus pemilih?', text: v.name + ' (' + v.nim + ') akan dihapus dari daftar pemilih.', confirm: 'Hapus pemilih', danger: true });
    if (!ok) return;
    try {
      await call('voter_delete', { id: v.id });
      state.voters = state.voters.filter((x) => x.id !== v.id);
      renderVoterRows();
      toast('Pemilih dihapus');
    } catch (e) { fail(e); }
  }

  // =====================================================================
  // Pengaturan
  // =====================================================================
  function renderSettings() {
    const s = state.overview.settings;
    const name = h('input', { id: 's-name', type: 'text', maxlength: '120', value: s.election_name });
    const start = h('input', { id: 's-start', type: 'datetime-local', value: toInputValue(s.start_at) });
    const end = h('input', { id: 's-end', type: 'datetime-local', value: toInputValue(s.end_at) });
    const checkin = h('input', { id: 's-checkin', type: 'checkbox', checked: s.require_checkin });
    const pub = h('input', { id: 's-public', type: 'checkbox', checked: s.results_public });
    const stop = h('input', { id: 's-stop', type: 'checkbox', checked: s.force_closed });
    const save = h('button', { class: 'btn', type: 'submit' }, 'Simpan pengaturan');

    const form = h('form', { class: 'panel stack', novalidate: true },
      h('h2', { style: 'margin:0', text: 'Pengaturan pemilihan' }),
      h('div', { class: 'field' }, h('label', { for: 's-name', text: 'Nama pemilihan' }), name),
      h('div', { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 's-start', text: 'Mulai (WIB)' }), start),
        h('div', { class: 'field' }, h('label', { for: 's-end', text: 'Selesai (WIB)' }), end)),
      h('p', { class: 'hint muted small', text: 'Pemungutan suara dibuka dan ditutup otomatis sesuai jadwal. Kosongkan kedua waktu untuk menutup pemilihan.' }),
      h('label', { class: 'check', for: 's-checkin' }, checkin,
        h('span', null, 'Pemilih harus ditandai hadir oleh panitia sebelum bisa memilih', h('span', { class: 'hint', text: 'Disarankan, karena masuk hanya memakai NIM. Panitia mencocokkan identitas pemilih di meja pendaftaran, lalu mencentang kolom Hadir di tab Pemilih.' }))),
      h('label', { class: 'check', for: 's-public' }, pub,
        h('span', null, 'Tampilkan perolehan suara di layar hasil tanpa login', h('span', { class: 'hint', text: 'Bila mati, perolehan suara hanya terlihat oleh panitia yang masuk. Jumlah pemilih yang sudah memilih tetap tampil.' }))),
      h('label', { class: 'check', for: 's-stop' }, stop,
        h('span', null, 'Hentikan pemungutan suara sekarang', h('span', { class: 'hint', text: 'Tombol darurat. Matikan untuk melanjutkan sesuai jadwal.' }))),
      h('div', null, save));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      save.disabled = true;
      try {
        const r = await call('settings_save', {
          election_name: name.value, start_at: fromInputValue(start.value), end_at: fromInputValue(end.value),
          require_checkin: checkin.checked, results_public: pub.checked, force_closed: stop.checked,
        });
        state.overview.settings = r.settings;
        state.status = r.status;
        renderHeader();
        toast('Pengaturan disimpan');
      } catch (e) { fail(e); }
      save.disabled = false;
    });

    const confirmInput = h('input', { type: 'text', id: 'reset-confirm', autocomplete: 'off', placeholder: 'RESET', 'aria-label': 'Ketik RESET untuk mengonfirmasi' });
    const resetBtn = h('button', { class: 'btn danger', type: 'button', disabled: true }, 'Reset suara');
    confirmInput.addEventListener('input', () => { resetBtn.disabled = confirmInput.value !== 'RESET'; });
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      try {
        await call('reset_election', { confirm: confirmInput.value });
        confirmInput.value = '';
        toast('Suara direset');
        await loadOverview();
      } catch (e) { fail(e); }
    });

    clear($('#tab-pengaturan')).append(
      h('div', { class: 'stack' }, form,
        h('div', { class: 'panel danger-zone stack' },
          h('h2', { style: 'margin:0', text: 'Reset data uji coba' }),
          h('p', { text: 'Menghapus semua suara dan menandai semua pemilih belum memilih. Daftar pemilih, kandidat, dan log audit tetap ada. Gunakan hanya sebelum pemilihan sebenarnya, setelah uji coba. Tidak bisa dijalankan saat pemungutan suara dibuka; hentikan dulu lewat opsi di atas.' }),
          h('div', { class: 'row' }, h('div', { style: 'width:200px' }, confirmInput), resetBtn),
          h('p', { class: 'hint muted small', text: 'Ketik RESET pada kolom untuk mengaktifkan tombol.' }))));
  }

  // =====================================================================
  // Laporan
  // =====================================================================
  function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // cegah eksekusi rumus di Excel
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCsv(filename, rows) {
    const text = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function printReport() {
    document.body.classList.add('print-report');
    const cleanup = () => { document.body.classList.remove('print-report'); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    window.print();
  }

  function renderReport() {
    const o = state.overview;
    const res = o.results;
    const votes = res.reduce((a, r) => a + r.total, 0);
    const lead = leaderOf(res);
    const closed = o.status === 'closed';
    const total = o.totals.voters;
    const voted = o.totals.voted;
    const pct = total ? Math.round((voted / total) * 1000) / 10 : 0;
    const stamp = fmtDateTime(new Date(clock.now()).toISOString());

    let conclusion;
    if (!votes) conclusion = 'Belum ada suara masuk.';
    else if (lead.tie) conclusion = 'Perolehan suara sementara seri antara ' + res.filter((r) => r.total === lead.max).map((r) => 'calon nomor ' + r.number + ' (' + r.name + ')').join(' dan ') + '.';
    else {
      const w = res.find((r) => r.id === lead.id);
      conclusion = closed
        ? 'Berdasarkan rekapitulasi, calon nomor ' + w.number + ', ' + w.name + ', memperoleh suara terbanyak dan ditetapkan sebagai wakil ketua terpilih.'
        : 'Rekapitulasi sementara: calon nomor ' + w.number + ', ' + w.name + ', memimpin. Pemungutan suara belum ditutup.';
    }

    const resultRows = res.map((r) => h('tr', null,
      h('td', { class: 'num', text: r.number }), h('td', { text: r.name }),
      h('td', { class: 'r num', text: r.total }),
      h('td', { class: 'r num', text: (votes ? Math.round((r.total / votes) * 1000) / 10 : 0) + '%' })));

    clear($('#tab-laporan')).append(
      h('div', { class: 'panel report' },
        h('div', { class: 'row no-print', style: 'margin-bottom:20px' },
          h('button', { class: 'btn', type: 'button', onclick: printReport }, 'Cetak atau simpan PDF'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => downloadCsv('hasil-pemilihan.csv', [['Nomor urut', 'Nama', 'Suara', 'Persen']]
            .concat(res.map((r) => [r.number, r.name, r.total, (votes ? Math.round((r.total / votes) * 1000) / 10 : 0) + '%']))
            .concat([['', 'Total suara', votes, '']])) }, 'Unduh hasil (CSV)'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => downloadCsv('daftar-pemilih.csv', [['NIM', 'Nama', 'Hadir', 'Sudah memilih', 'Waktu memilih (WIB)']]
            .concat(state.voters.map((v) => [v.nim, v.name, v.checked_in ? 'Ya' : 'Tidak', v.has_voted ? 'Ya' : 'Tidak', v.voted_at ? fmtDateTime(v.voted_at) : '']))) }, 'Unduh daftar pemilih (CSV)')),
        h('h2', { text: 'Berita acara ' + o.settings.election_name }),
        h('dl', { class: 'report-meta' },
          h('dt', { text: 'Jadwal' }), h('dd', { text: o.settings.start_at ? fmtDateTime(o.settings.start_at) + ' sampai ' + fmtDateTime(o.settings.end_at) : 'Belum diatur' }),
          h('dt', { text: 'Status' }), h('dd', { text: ({ open: 'Dibuka', not_started: 'Belum dimulai', closed: 'Ditutup', stopped: 'Dihentikan sementara', not_configured: 'Jadwal belum diatur' })[o.status] }),
          h('dt', { text: 'Pemilih terdaftar' }), h('dd', { text: String(total) }),
          h('dt', { text: 'Menggunakan hak pilih' }), h('dd', { text: voted + ' (' + pct + '%)' }),
          h('dt', { text: 'Tidak menggunakan hak pilih' }), h('dd', { text: String(total - voted) }),
          h('dt', { text: 'Dicetak pada' }), h('dd', { text: stamp })),
        votes !== voted ? h('div', { class: 'note bad', style: 'margin-bottom:16px', text: 'Jumlah suara (' + votes + ') berbeda dengan jumlah pemilih yang tercatat memilih (' + voted + '). Periksa log audit sebelum menetapkan hasil.' }) : null,
        h('div', { class: 'table-wrap', style: 'max-height:none' },
          h('table', { class: 'table' },
            h('thead', null, h('tr', null, h('th', { text: 'Nomor urut' }), h('th', { text: 'Calon wakil ketua' }), h('th', { class: 'r', text: 'Suara' }), h('th', { class: 'r', text: 'Persen' }))),
            h('tbody', null, resultRows, h('tr', null, h('td'), h('td', { text: 'Total suara' }), h('td', { class: 'r num', text: votes }), h('td'))))),
        h('p', { style: 'margin-top:16px', text: conclusion }),
        h('div', { class: 'sign' },
          h('div', { text: 'Ketua panitia' }),
          h('div', { text: 'Saksi atau pengawas' }))));
  }

  // =====================================================================
  // Log audit
  // =====================================================================
  const ACTION_LABEL = {
    admin_login: 'Panitia masuk', admin_login_failed: 'Percobaan masuk panitia gagal', voter_login: 'Pemilih masuk',
    voter_login_failed: 'NIM tidak terdaftar dicoba', vote_cast: 'Suara tercatat', settings_save: 'Pengaturan disimpan',
    candidate_create: 'Kandidat ditambahkan', candidate_update: 'Kandidat diubah', candidate_delete: 'Kandidat dihapus',
    voters_import: 'Pemilih diimpor', voter_delete: 'Pemilih dihapus', voter_checkin: 'Kehadiran pemilih diubah',
    reset_election: 'Suara direset',
  };

  function detailText(d) {
    if (!d) return '';
    return Object.keys(d).map((k) => k + ': ' + (d[k] !== null && typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k])).join(', ');
  }

  async function renderAudit() {
    const r = await call('audit_list');
    const refresh = h('button', { class: 'btn secondary small', type: 'button', onclick: () => renderAudit().catch(fail) }, 'Muat ulang');
    clear($('#tab-log')).append(
      h('div', { class: 'panel' },
        h('div', { class: 'row between', style: 'margin-bottom:12px' }, h('h2', { style: 'margin:0', text: 'Log audit' }), refresh),
        h('p', { class: 'muted small', style: 'margin-bottom:12px', text: 'Menampilkan 300 catatan terbaru. Log mencatat siapa yang memilih dan kapan, tetapi tidak pernah mencatat pilihannya.' }),
        r.entries.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, h('th', { text: 'Waktu' }), h('th', { text: 'Pelaku' }), h('th', { text: 'Aksi' }), h('th', { text: 'Detail' }))),
            h('tbody', null, r.entries.map((e) => h('tr', null,
              h('td', { class: 'num', text: fmtDateTime(e.at).replace(' WIB', '') + ' ' + fmtTime(e.at) }),
              h('td', { text: e.actor }),
              h('td', { text: ACTION_LABEL[e.action] || e.action }),
              h('td', { class: 'muted', text: detailText(e.detail) }))))))
          : h('p', { class: 'empty', text: 'Belum ada catatan.' })));
  }

  // ---------- Mulai ----------
  if (state.token) {
    enter().catch(() => signOut());
  } else {
    $('#pw').focus();
  }
})();
