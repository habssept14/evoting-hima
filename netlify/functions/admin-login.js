'use strict';
const {
  respond, parseBody, handle, safeEqual, signToken, audit, recentCount, ConfigError,
} = require('../lib/common');

const TOKEN_TTL = 8 * 60 * 60; // 8 jam
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.handler = handle('POST', async (event) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new ConfigError('ADMIN_PASSWORD belum diatur di Netlify.');

  const body = parseBody(event);
  if (body === null) return respond(400, { error: 'Format permintaan tidak valid.' });

  if ((await recentCount('admin_login_failed', 10)) >= 5) {
    return respond(429, { error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 10 menit.' });
  }

  const password = String(body.password || '');
  if (!safeEqual(password, expected)) {
    await audit('system', 'admin_login_failed');
    await sleep(600);
    return respond(401, { error: 'Kata sandi salah.' });
  }

  await audit('admin', 'admin_login');
  return respond(200, { token: signToken({ role: 'admin' }, TOKEN_TTL), expires_in: TOKEN_TTL });
});
