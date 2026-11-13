'use strict';
const { db, respond, handle, getSettings, computeStatus } = require('../lib/common');

// Publik: info pemilihan dan profil kandidat untuk halaman pemilih.
exports.handler = handle('GET', async () => {
  const settings = await getSettings();
  const { data: candidates, error } = await db()
    .from('candidates')
    .select('id, number, name, photo, vision, mission')
    .order('number');
  if (error) throw error;

  return respond(200, {
    election_name: settings.election_name,
    status: computeStatus(settings),
    start_at: settings.start_at,
    end_at: settings.end_at,
    require_checkin: settings.require_checkin,
    server_time: new Date().toISOString(),
    candidates,
  });
});
