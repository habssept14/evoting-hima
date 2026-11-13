/* Utilitas bersama: pemanggil API, elemen DOM, format tanggal, jam server. */
(function () {
  'use strict';

  const TZ = 'Asia/Jakarta';

  async function api(path, opts) {
    const o = opts || {};
    const headers = {};
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    let res;
    try {
      res = await fetch('/api/' + path, {
        method: o.method || (o.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      const err = new Error('Tidak dapat terhubung ke server. Periksa koneksi internet.');
      err.network = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* abaikan */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Permintaan gagal (' + res.status + ').');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // h('div', {class: 'x', onclick: fn}, 'teks', childNode, ...)
  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === false || v === null || v === undefined) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach((x) => append(el, x));
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  const $ = (sel, root) => (root || document).querySelector(sel);

  // ---------- Format ----------
  function fmtDateTime(iso) {
    if (!iso) return '-';
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso)).replace(/\./g, ':').replace(',', '') + ' WIB';
  }
  function fmtTime(iso) {
    if (!iso) return '-';
    return new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .format(new Date(iso)).replace(/\./g, ':');
  }
  // ISO -> nilai untuk <input type="datetime-local"> dalam WIB
  function toInputValue(iso) {
    if (!iso) return '';
    const p = new Intl.DateTimeFormat('sv-SE', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
    return p.replace(' ', 'T');
  }
  // nilai <input type="datetime-local"> (dianggap WIB) -> ISO
  function fromInputValue(v) {
    if (!v) return null;
    return new Date(v + ':00+07:00').toISOString();
  }
  function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const hh = Math.floor((s % 86400) / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (d > 0) return d + ' hari ' + hh + ' jam';
    if (hh > 0) return hh + ' jam ' + mm + ' menit';
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  const STATUS = {
    open:          { label: 'Sedang Dibuka',        tone: 'ok'   },
    not_started:   { label: 'Belum Dimulai',         tone: 'warn' },
    closed:        { label: 'Sudah Ditutup',         tone: 'bad'  },
    stopped:       { label: 'Dihentikan Sementara',  tone: 'bad'  },
    not_configured:{ label: 'Jadwal Belum Diatur',   tone: 'warn' },
  };
  function statusChip(status) {
    const s = STATUS[status] || { label: '—', tone: '' };
    return h('span', { class: ('chip' + (s.tone ? ' ' + s.tone : '')).trim(), text: s.label });
  }

  // Jam server: selisih antara jam server dan jam perangkat ini.
  const clock = {
    offset: 0,
    sync(serverIso) { if (serverIso) this.offset = new Date(serverIso).getTime() - Date.now(); },
    now() { return Date.now() + this.offset; },
  };

  // Kandidat dengan suara terbanyak (null bila belum ada suara atau seri).
  function leaderOf(results) {
    if (!results || !results.length) return { id: null, tie: false, max: 0 };
    const max = Math.max.apply(null, results.map((r) => r.total));
    if (max === 0) return { id: null, tie: false, max: 0 };
    const top = results.filter((r) => r.total === max);
    return top.length === 1 ? { id: top[0].id, tie: false, max } : { id: null, tie: true, max };
  }

  let toastTimer;
  function toast(message, tone) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const el = h('div', { class: 'toast' + (tone === 'bad' ? ' bad' : ''), role: 'status', text: message });
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 3500);
  }

  window.App = { api, h, clear, $, fmtDateTime, fmtTime, toInputValue, fromInputValue, fmtDuration, STATUS, statusChip, clock, leaderOf, toast };
})();
