/* Halaman pemilih: masuk dengan NIM, lihat profil kandidat, kirim satu suara. */
(function () {
  'use strict';
  const { api, h, clear, $, fmtDateTime, fmtDuration, statusChip, clock } = App;

  const IDLE_MS = 120 * 1000;      // sesi ditutup bila tidak ada aktivitas
  const DONE_SECONDS = 8;          // layar "terima kasih" sebelum kembali ke awal
  const REFRESH_MS = 10 * 1000;    // sinkronisasi status pemilihan

  const STATUS_TEXT = {
    not_configured: 'Jadwal pemilihan belum diatur oleh panitia.',
    not_started: 'Pemungutan suara belum dimulai.',
    closed: 'Pemungutan suara sudah ditutup.',
    stopped: 'Pemungutan suara dihentikan sementara oleh panitia.',
  };

  const views = { login: $('#view-login'), ballot: $('#view-ballot'), done: $('#view-done') };
  const form = $('#login-form');
  const nimInput = $('#nim');
  const loginBtn = $('#login-btn');
  const loginMsg = $('#login-msg');

  let election = null;
  let session = null;      // { token, name }
  let idleTimer = null;
  let doneTimer = null;
  let loading = false;
  let lastLoad = 0;
  let uncertainVote = false;   // true bila pengiriman suara terputus di tengah jalan
  let statusNote = false;      // true bila pesan di bawah kolom NIM berasal dari status pemilihan

  function show(name) {
    Object.keys(views).forEach((k) => { views[k].hidden = k !== name; });
    window.scrollTo(0, 0);
  }

  function showMsg(text, tone) {
    statusNote = false;
    loginMsg.className = 'note' + (tone ? ' ' + tone : '');
    loginMsg.textContent = text;
    loginMsg.hidden = !text;
  }

  // ---------- Data pemilihan ----------
  async function loadElection() {
    if (loading) return;
    loading = true;
    try {
      election = await api('election');
      clock.sync(election.server_time);
      lastLoad = Date.now();
      renderHeader();
      renderFacts();
      updateLoginState();
    } catch (e) {
      if (!election) showMsg(e.message, 'bad');
    } finally {
      loading = false;
    }
  }

  function renderHeader() {
    $('#election-name').textContent = election.election_name;
    document.title = election.election_name;
    const chip = $('#status-chip');
    clear(chip).appendChild(statusChip(election.status));
  }

  function renderFacts() {
    const box = clear($('#facts'));
    if (!election.start_at || !election.end_at) return;
    box.appendChild(h('p', null, 'Mulai: ', h('strong', { text: fmtDateTime(election.start_at) })));
    box.appendChild(h('p', null, 'Selesai: ', h('strong', { text: fmtDateTime(election.end_at) })));
    box.appendChild(h('p', { id: 'countdown' }));
    renderCountdown();
  }

  function renderCountdown() {
    const el = $('#countdown');
    if (!election || !election.start_at) return;
    const now = clock.now();
    const start = new Date(election.start_at).getTime();
    const end = new Date(election.end_at).getTime();
    let text = '';
    let boxLabel = '';
    if (election.status === 'open') {
      text = 'Ditutup dalam ' + fmtDuration(end - now);
      boxLabel = fmtDuration(end - now);
    } else if (election.status === 'not_started') {
      text = 'Dimulai dalam ' + fmtDuration(start - now);
      boxLabel = fmtDuration(start - now);
    }
    if (el) el.textContent = text;

    // Update countdown box bergaya (sesuai preview Sovereign Dark)
    const box = $('#countdown-box');
    const val = $('#countdown-val');
    const lbl = $('#countdown-label');
    if (box) box.hidden = !boxLabel;
    if (val && boxLabel) val.textContent = boxLabel;
    if (lbl) lbl.textContent = election.status === 'open' ? 'Ditutup dalam' : 'Dimulai dalam';

    const flipped = (election.status === 'not_started' && now >= start) || (election.status === 'open' && now >= end);
    if (flipped && Date.now() - lastLoad > 2000) loadElection();
  }

  function updateLoginState() {
    if (session || !election) return;
    const open = election.status === 'open';
    const ready = open && election.candidates.length >= 2;
    nimInput.disabled = !ready;
    loginBtn.disabled = !ready;
    if (!open) { showMsg(STATUS_TEXT[election.status] || '', 'warn'); statusNote = true; }
    else if (!ready) { showMsg('Data kandidat belum lengkap. Hubungi panitia.', 'warn'); statusNote = true; }
    else if (statusNote) { showMsg(''); statusNote = false; }   // hanya hapus pesan status, bukan pesan galat
  }

  // ---------- Masuk ----------
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nim = nimInput.value.trim();
    if (!nim) { showMsg('Masukkan NIM Anda.', 'warn'); nimInput.focus(); return; }
    showMsg('');
    loginBtn.disabled = true;
    try {
      const r = await api('voter-login', { body: { nim } });
      session = { token: r.token, name: r.voter.name };
      lastLoad = 0;
      await loadElection();   // pastikan profil kandidat terbaru
      if (!election || election.candidates.length < 2) throw new Error('Data kandidat belum lengkap. Hubungi panitia.');
      startBallot();
    } catch (err) {
      session = null;
      showMsg(err.message, err.status === 401 || err.status === 409 ? 'warn' : 'bad');
      if (err.data && err.data.status) loadElection();
      nimInput.select();
    } finally {
      if (!session) updateLoginState();
    }
  });

  // ---------- Surat suara ----------
  function startBallot() {
    $('#greeting').textContent = 'Halo, ' + session.name + '. Pelajari profil kedua calon, lalu pilih satu. Suara yang sudah dikirim tidak dapat diubah.';
    const box = clear($('#cands'));
    election.candidates.forEach((c, idx) => box.appendChild(candidateCard(c, idx)));
    uncertainVote = false;
    show('ballot');
    $('#ballot-title').focus();
    resetIdle();
  }

  // Warna per kandidat: indeks 0 = solid cyan, indeks 1 = purple outline
  const CAND_COLORS = [
    { btn: 'btn large solid', numColor: '', fillColor: '' },
    { btn: 'btn large', numColor: '#a78bfa', fillColor: 'rgba(167,139,250,0.15)' },
  ];

  function candidateCard(c, idx) {
    const colorScheme = CAND_COLORS[idx] || CAND_COLORS[0];
    const photo = c.photo
      ? h('img', { src: c.photo, alt: 'Foto ' + c.name })
      : h('span', { class: 'initial', 'aria-hidden': 'true', text: (c.name.trim()[0] || '?').toUpperCase() });
    const missions = (c.mission || '').split('\n')
      .map((l) => l.replace(/^\s*(?:[-•*]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);

    // Numeral: kandidat 1 cyan (default), kandidat 2 purple
    const numeralStyle = colorScheme.numColor
      ? 'color:' + colorScheme.numColor + ';background:linear-gradient(135deg,#060d1c,' + colorScheme.fillColor + ')'
      : '';
    const numEl = h('span', { class: 'numeral', 'aria-hidden': 'true', text: c.number });
    if (numeralStyle) numEl.setAttribute('style', numeralStyle);

    // Tombol pilih: kandidat 1 solid, kandidat 2 purple outline
    const btnEl = h('button', { class: colorScheme.btn, type: 'button', onclick: () => confirmVote(c) }, 'Pilih nomor ' + c.number);
    if (colorScheme.numColor) {
      btnEl.style.borderColor = colorScheme.numColor;
      btnEl.style.color = colorScheme.numColor;
      btnEl.style.width = '100%';
    }

    return h('article', { class: 'cand', 'aria-label': 'Calon nomor ' + c.number + ', ' + c.name },
      h('div', { class: 'cand-photo' },
        photo,
        h('div', { class: 'cand-photo-overlay' }),
        numEl),
      h('div', { class: 'cand-body' },
        h('h2', { class: 'cand-name', text: c.name }),
        c.vision ? h('div', { class: 'cand-sec' }, h('h3', { text: 'Visi' }), h('p', { text: c.vision })) : null,
        missions.length ? h('div', { class: 'cand-sec' }, h('h3', { text: 'Misi' }), h('ul', null, missions.map((m) => h('li', { text: m })))) : null,
        btnEl));
  }

  // ---------- Konfirmasi dan kirim ----------
  function confirmVote(c) {
    resetIdle();
    const root = clear($('#modal-root'));
    const msg = h('div', { class: 'note bad', role: 'alert', hidden: true });
    const back = h('button', { class: 'btn secondary large', type: 'button', onclick: closeModal }, 'Ubah pilihan');
    const send = h('button', { class: 'btn large', type: 'button' }, 'Kirim suara');
    send.addEventListener('click', () => submitVote(c, send, back, msg));

    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'm-title' },
      h('div', { class: 'row', style: 'gap:24px; align-items:center; margin-bottom:20px' },
        h('div', { class: 'punch', 'aria-hidden': 'true' }, h('span', { class: 'punch-num', text: c.number })),
        h('div', null,
          h('p', { class: 'muted', text: 'Anda memilih' }),
          h('h2', { id: 'm-title', text: c.name }),
          h('p', { class: 'muted', text: 'Nomor urut ' + c.number })))
      , h('p', { text: 'Suara yang sudah dikirim tidak dapat diubah atau dibatalkan.' }),
      msg,
      h('div', { class: 'modal-actions' }, send, back));

    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key === 'Tab') {   // fokus tetap di dalam dialog
        const items = [back, send].filter((b) => !b.disabled);
        if (!items.length) return;
        const i = items.indexOf(document.activeElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
      }
    });
    root.appendChild(h('div', { class: 'modal-backdrop' }, dialog));
    back.focus();   // fokus awal di tombol aman
  }

  function closeModal() {
    clear($('#modal-root'));
    resetIdle();
  }

  async function submitVote(c, send, back, msg) {
    send.disabled = true;
    back.disabled = true;
    msg.hidden = true;
    send.textContent = 'Mengirim...';
    try {
      await api('vote', { token: session.token, body: { candidate_id: c.id } });
      closeModal();
      finish();
    } catch (err) {
      if (err.network || (err.status && err.status >= 500)) {
        uncertainVote = true;
        msg.textContent = err.message + ' Tekan Kirim suara untuk mencoba lagi.';
        msg.hidden = false;
        send.disabled = false;
        back.disabled = false;
        send.textContent = 'Kirim suara';
        send.focus();
        return;
      }
      closeModal();
      if (err.status === 409 && uncertainVote) {
        logout('Suara Anda kemungkinan sudah tercatat. Tanyakan ke panitia untuk memastikan.', 'warn');
      } else {
        logout(err.message, err.status === 409 ? 'warn' : 'bad');
      }
      loadElection();
    }
  }

  // ---------- Selesai dan reset ----------
  function finish() {
    const name = session ? session.name : '';
    session = null;                 // buang token segera
    clearTimeout(idleTimer);
    show('done');
    $('#done-title').focus();
    let left = DONE_SECONDS;
    const text = $('#done-text');
    const paint = () => {
      text.textContent = 'Terima kasih, ' + name + '. Layar kembali ke awal dalam ' + left + ' detik untuk pemilih berikutnya.';
    };
    paint();
    clearInterval(doneTimer);
    doneTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(doneTimer); logout(); } else paint();
    }, 1000);
  }

  function logout(message, tone) {
    clearInterval(doneTimer);
    clearTimeout(idleTimer);
    session = null;
    clear($('#modal-root'));
    nimInput.value = '';
    show('login');
    if (election) updateLoginState();
    if (message) showMsg(message, tone || 'warn');
    if (!nimInput.disabled) nimInput.focus();
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    if (!session) return;
    idleTimer = setTimeout(() => logout('Sesi ditutup karena tidak ada aktivitas. Masuk kembali untuk memilih.'), IDLE_MS);
  }
  ['pointerdown', 'keydown', 'scroll'].forEach((ev) => document.addEventListener(ev, () => { if (session) resetIdle(); }, { passive: true }));

  $('#cancel-btn').addEventListener('click', () => logout());
  $('#done-btn').addEventListener('click', () => logout());

  // ---------- Mulai ----------
  loadElection();
  setInterval(loadElection, REFRESH_MS);
  setInterval(renderCountdown, 1000);
  nimInput.focus();
})();
