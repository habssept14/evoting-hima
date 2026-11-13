'use strict';
const {
  respond, handle, authAs, getSettings, computeStatus, count, getResults,
} = require('../lib/common');

// Data live untuk layar hasil dan dashboard.
// Partisipasi selalu terbuka; perolehan suara hanya untuk panitia (token admin)
// atau untuk semua orang bila panitia mengaktifkan "hasil publik".
exports.handler = handle('GET', async (event) => {
  const settings = await getSettings();
  const isAdmin = !!authAs(event, 'admin');
  const resultsVisible = isAdmin || settings.results_public;

  const [totalVoters, voted] = await Promise.all([
    count('voters'),
    count('voters', (q) => q.eq('has_voted', true)),
  ]);

  return respond(200, {
    election_name: settings.election_name,
    status: computeStatus(settings),
    start_at: settings.start_at,
    end_at: settings.end_at,
    server_time: new Date().toISOString(),
    total_voters: totalVoters,
    voted,
    results_visible: resultsVisible,
    results: resultsVisible ? await getResults() : null,
  });
});
