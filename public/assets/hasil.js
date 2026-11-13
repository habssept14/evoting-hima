/* Layar hasil: partisipasi dan perolehan suara, diperbarui otomatis tiap 3 detik. */
(function () {
  'use strict';
  const { api, h, clear, $, fmtTime, statusChip, clock, leaderOf, fmtDuration } = App;

  const POLL_MS = 3000;
  const TOKEN_KEY = 'hima_admin_token';

  const store = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
    set(v) { try { sessionStorage.setItem(TOKEN_KEY, v); } catch (e) { /* abaikan */ } },
    del() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* abaikan */ } },
  };

  let data = null;
  let rowsKey = '';
  const rowEls = new Map();

  async function poll() {
    try {
      data = await api('live', { token: store.get() });
      clock.sync(data.server_time);
      $('#conn').textContent = '';
      render();
    } catch (e) {
      if (e.status === 401 && store.get()) { store.del(); return poll(); }
      $('#conn').textContent = 'Terputus. Mencoba lagi...';
    }
  }

  function render() {
    $('#election-name').textContent = data.election_name;
    document.title = 'Hasil: ' + data.election_name;
    clear($('#status-chip')).appendChild(statusChip(data.status));

    const pct = data.total_voters ? Math.round((data.voted / data.total_voters) * 100) : 0;
    $('#voted').textContent = data.voted;
    $('#total').textContent = data.total_voters;
    $('#part-pct').textContent = pct + '%';
    $('#part-fill').style.width = pct + '%';
    $('#part-track').setAttribute('aria-valuenow', String(pct));
    renderCountdown();

    const locked = !data.results_visible;
    $('#locked').hidden = !locked;
    $('#results').hidden = locked;
    if (!locked) renderResults();
  }

  function renderCountdown() {
    if (!data || !data.start_at) { $('#countdown').textContent = ''; return; }
    const now = clock.now();
    const start = new Date(data.start_at).getTime();
    const end = new Date(data.end_at).getTime();
    let text = '';
    if (data.status === 'open') text = 'Ditutup dalam ' + fmtDuration(end - now);
    else if (data.status === 'not_started') text = 'Dimulai dalam ' + fmtDuration(start - now);
    $('#countdown').textContent = text;
  }

  function renderResults() {
    const results = data.results || [];
    const box = $('#results');
    const key = results.map((r) => r.id).join('|');

    if (key !== rowsKey) {
      rowsKey = key;
      rowEls.clear();

      // Layout 2 kolom VS (Sovereign Dark)
      if (results.length === 2) {
        const els0 = {
          wrap: null, name: h('div', { class: 'live-cand-name' }),
          count: h('div', { class: 'live-count' }),
          pct: h('div', { class: 'live-pct' }),
          fill: h('div', { class: 'live-fill', style: 'width:0' }),
          tag: h('span', { class: 'tag', hidden: true }),
          badge: null,
        };
        const els1 = {
          wrap: null, name: h('div', { class: 'live-cand-name' }),
          count: h('div', { class: 'live-count' }),
          pct: h('div', { class: 'live-pct' }),
          fill: h('div', { class: 'live-fill f2', style: 'width:0' }),
          tag: h('span', { class: 'tag', hidden: true }),
          badge: null,
        };

        const buildCard = (r, els, idx) => {
          const photo = r.photo
            ? h('img', { src: r.photo, alt: 'Foto ' + r.name, style: 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 25%' })
            : h('span', { class: 'cand-initial', 'aria-hidden': 'true', text: (r.name.trim()[0] || '?').toUpperCase() });
          els.badge = h('div', { class: 'live-leading-badge', hidden: true }, '▲ Memimpin');
          const numEl = h('div', { class: 'live-cand-num', text: r.number });
          const card = h('div', { class: 'live-cand' },
            h('div', { class: 'live-cand-photo' },
              photo,
              h('div', { class: 'live-cand-overlay' }),
              numEl,
              els.badge),
            h('div', { class: 'live-cand-body' },
              els.name,
              h('div', { class: 'live-bar-meta' },
                els.count,
                h('div', null, els.tag, els.pct)),
              h('div', { class: 'live-track' }, els.fill)));
          els.wrap = card;
          return card;
        };

        // VS ornamen tengah
        const vsEl = h('div', { class: 'live-vs', 'aria-hidden': 'true' },
          h('div', { class: 'live-vs-line' }),
          h('div', { class: 'live-vs-hex' },
            h('svg', { width: '64', height: '64', viewBox: '0 0 64 64', fill: 'none' },
              h('polygon', { points: '32,4 58,18 58,46 32,60 6,46 6,18', stroke: 'rgba(0,212,255,0.4)', 'stroke-width': '1.5', fill: 'rgba(0,212,255,0.04)' }),
              h('polygon', { points: '32,12 52,23 52,41 32,52 12,41 12,23', stroke: 'rgba(0,212,255,0.2)', 'stroke-width': '1', fill: 'none' })),
            h('span', { class: 'live-vs-text', text: 'VS' })),
          h('div', { class: 'live-vs-line' }));

        const versus = h('div', { class: 'live-versus' },
          buildCard(results[0], els0, 0),
          vsEl,
          buildCard(results[1], els1, 1));

        rowEls.set(results[0].id, els0);
        rowEls.set(results[1].id, els1);
        clear(box).appendChild(versus);

      } else {
        // Fallback list biasa untuk < 2 atau > 2 kandidat
        const list = h('div', { class: 'res-list' });
        results.forEach((r) => {
          const els = {
            name: h('span', { class: 'res-name' }),
            tag: h('span', { class: 'tag', hidden: true }),
            count: h('span', { class: 'res-count' }),
            fill: h('div', { class: 'fill', style: 'width:0' }),
          };
          rowEls.set(r.id, els);
          list.appendChild(h('div', { class: 'res-row' },
            h('span', { class: 'numeral', 'aria-hidden': 'true', text: r.number }),
            h('div', null,
              h('div', { class: 'res-meta' }, h('span', null, els.name, els.tag), els.count),
              h('div', { class: 'track' }, els.fill))));
        });
        clear(box).appendChild(list);
      }
    }

    const sum = results.reduce((a, r) => a + r.total, 0);
    const lead = leaderOf(results);

    results.forEach((r) => {
      const els = rowEls.get(r.id);
      if (!els) return;
      const pct = sum ? Math.round((r.total / sum) * 100) : 0;
      const isLeading = lead.id === r.id;
      const isTie = lead.tie && r.total === lead.max;
      let tagText = '';
      if (isLeading) tagText = data.status === 'closed' ? 'Terpilih' : 'Memimpin';
      else if (isTie) tagText = 'Suara seri';

      // Update untuk layout VS (2 kolom)
      if (els.wrap) {
        els.name.textContent = r.name;
        els.count.textContent = r.total;
        els.pct.textContent = pct + '%';
        els.fill.style.width = pct + '%';
        els.tag.textContent = tagText;
        els.tag.hidden = !tagText;
        if (els.badge) {
          els.badge.hidden = !isLeading;
        }
        if (els.wrap) {
          els.wrap.classList.toggle('leading', isLeading);
        }
      } else {
        // Fallback list
        els.name.textContent = r.name;
        clear(els.count).append(String(r.total), h('small', { text: pct + '%' }));
        els.fill.style.width = pct + '%';
        els.tag.textContent = tagText;
        els.tag.hidden = !tagText;
      }
    });
  }

  // ---------- Masuk panitia (opsional) ----------
  $('#show-login').addEventListener('click', () => {
    $('#login-form').hidden = false;
    $('#pw').focus();
  });
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-err');
    err.hidden = true;
    try {
      const r = await api('admin-login', { body: { password: $('#pw').value } });
      store.set(r.token);
      $('#pw').value = '';
      $('#login-form').hidden = true;
      await poll();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  setInterval(() => { if (data) $('#clock').textContent = fmtTime(new Date(clock.now()).toISOString()) + ' WIB'; if (data) renderCountdown(); }, 1000);
  poll();
  setInterval(poll, POLL_MS);
})();
