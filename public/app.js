const $ = (id) => document.getElementById(id);
const CAMPAIGN_NAMES = {
  no_mercy: 'No Mercy',
  death_toll: 'Death Toll',
  dead_air: 'Dead Air',
  blood_harvest: 'Blood Harvest',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const RESULT_LABEL = { win: 'W', loss: 'L', draw: 'D' };

function fmtDate(iso) {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '';
}

function srDeltaHtml(d) {
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : '';
  return `<span class="delta ${cls}">${d > 0 ? '+' : ''}${d}</span>`;
}

function sparkline(values, w = 560, h = 80) {
  if (values.length < 2) return '<p class="note">Not enough matches for a graph yet.</p>';
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 5 - ((v - min) / span) * (h - 10)).toFixed(1)}`)
    .join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (res.status === 401 || res.status === 403) { location.hash = '#/'; refresh(); return null; }
  if (!res.ok) return null;
  return res.json();
}

let state = null;

function show(id) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== id;
}

async function api(path, opts = {}) {
  const init = { method: opts.method ?? 'POST' };
  if (opts.body) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  return fetch(path, init);
}

async function refresh() {
  const meRes = await fetch('/api/me');
  if (meRes.status === 401) { $('whoami').textContent = ''; show('login'); return; }
  const me = await meRes.json();
  $('whoami').innerHTML = `<a href="#/player/${esc(me.steamid)}">${esc(me.name)}</a>`;
  if (me.status !== 'active') { show('register'); return; }
  const stRes = await fetch('/api/state');
  if (!stRes.ok) { show('queue'); return; }
  state = await stRes.json();
  render();
}

function secondsLeft(deadline) {
  return Math.max(0, Math.round((deadline - Date.now()) / 1000));
}

function render() {
  if (location.hash !== '#/' && location.hash !== '') return;
  if (!state) return;
  const { queue, lobby, match } = state;
  if (match) {
    $('match-info').textContent =
      `Campaign: ${CAMPAIGN_NAMES[match.campaign] ?? match.campaign} — status: ${match.state}`;
    for (const [elId, team] of [['team-a', match.teamA], ['team-b', match.teamB]]) {
      $(elId).innerHTML = team.map((p) => `<li>${esc(p.name)}</li>`).join('');
    }
    show('match');
  } else if (lobby && lobby.phase === 'ready_check') {
    $('ready-timer').textContent = secondsLeft(lobby.deadline);
    $('ready-list').innerHTML = lobby.players
      .map((p) => `<li class="${lobby.ready.includes(p.steamid) ? 'ready' : ''}">${esc(p.name)}</li>`)
      .join('');
    show('ready');
  } else if (lobby && lobby.phase === 'map_vote') {
    $('vote-timer').textContent = secondsLeft(lobby.deadline);
    $('vote-options').innerHTML = lobby.options
      .map((c) => {
        const votes = lobby.votes[c] ?? 0;
        const cls = lobby.myVote === c ? 'btn voted' : 'btn';
        return `<button class="${cls}" data-campaign="${esc(c)}">${esc(CAMPAIGN_NAMES[c] ?? c)} (${votes})</button>`;
      })
      .join('');
    for (const btn of $('vote-options').querySelectorAll('button')) {
      btn.onclick = () => api('/api/lobby/vote', { body: { campaign: btn.dataset.campaign } }).then(refresh);
    }
    show('vote');
  } else {
    $('queue-count').textContent = queue.count;
    $('join-btn').hidden = queue.joined;
    $('leave-btn').hidden = !queue.joined;
    show('queue');
  }
}

$('register-btn').onclick = async () => {
  const res = await api('/api/register', { body: { code: $('invite-code').value.trim() } });
  if (!res.ok) $('register-error').textContent = 'Invalid invite code.';
  refresh();
};
$('join-btn').onclick = () => api('/api/queue/join').then(refresh);
$('leave-btn').onclick = () => api('/api/queue/leave').then(refresh);
$('ready-btn').onclick = () => api('/api/lobby/ready').then(refresh);

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = () => route();
  ws.onclose = () => setTimeout(connectWs, 2000);
}

async function initDevPanel() {
  const res = await fetch('/api/dev/enabled');
  if (!res.ok) return;
  $('devpanel').hidden = false;
  $('dev-login').onclick = () =>
    api('/api/dev/login', { body: { steamid: $('dev-steamid').value.trim() } }).then(refresh);
  $('dev-fill').onclick = () => api('/api/dev/fill').then(refresh);
  $('dev-ready').onclick = () => api('/api/dev/ready-all').then(refresh);
  $('dev-vote').onclick = () => api('/api/dev/vote-all').then(refresh);
  $('dev-clear').onclick = () => api('/api/dev/clear-matches').then(refresh);
  $('dev-sim').onclick = () => api('/api/dev/simulate-match').then(route);
}

function playerLink(p) {
  return `<a href="#/player/${esc(p.steamid)}">${esc(p.name)}</a>`;
}

async function renderLeaderboard() {
  const data = await fetchJson('/api/leaderboard');
  if (!data) return;
  $('lb-season').textContent = data.season.name;
  $('lb-body').innerHTML = data.rows.length === 0
    ? '<p class="note">No rated players yet.</p>'
    : `<table><thead><tr><th>#</th><th>Player</th><th>SR</th><th>W</th><th>L</th><th>Games</th></tr></thead><tbody>` +
      data.rows.map((r, i) =>
        `<tr><td>${i + 1}</td><td>${playerLink(r)}</td><td class="sr">${r.sr}</td><td>${r.wins}</td><td>${r.losses}</td><td>${r.games}</td></tr>`,
      ).join('') + '</tbody></table>';
  show('leaderboard');
}

async function renderMatches() {
  const data = await fetchJson('/api/matches');
  if (!data) return;
  $('matches-body').innerHTML = data.matches.length === 0
    ? '<p class="note">No completed matches yet.</p>'
    : `<table><thead><tr><th>#</th><th>Campaign</th><th>Score</th><th>Winner</th><th>Ended</th></tr></thead><tbody>` +
      data.matches.map((m) =>
        `<tr><td><a href="#/match/${m.id}">${m.id}</a></td><td>${esc(CAMPAIGN_NAMES[m.campaign] ?? m.campaign)}</td>` +
        `<td>${m.teamAScore} — ${m.teamBScore}</td><td>${m.winner === 'draw' ? 'Draw' : `Team ${m.winner.toUpperCase()}`}</td>` +
        `<td>${esc(fmtDate(m.endedAt))}</td></tr>`,
      ).join('') + '</tbody></table>';
  show('matches-page');
}

async function renderMatchDetail(id) {
  const data = await fetchJson(`/api/matches/${encodeURIComponent(id)}`);
  if (!data) { $('match-detail-body').innerHTML = '<p class="note">Match not found.</p>'; show('match-detail'); return; }
  const { match, maps, players } = data;
  const teamTable = (team) =>
    `<table><thead><tr><th>Player</th><th>SI dmg</th><th>SI kills</th><th>Commons</th><th>FF</th><th>Revives</th><th>SR</th></tr></thead><tbody>` +
    players.filter((p) => p.team === team).map((p) =>
      `<tr><td>${playerLink(p)}</td><td>${p.siDamage}</td><td>${p.siKills}</td><td>${p.commonKills}</td><td>${p.ffDealt}</td><td>${p.revives}</td><td>${srDeltaHtml(p.srDelta)}</td></tr>`,
    ).join('') + '</tbody></table>';
  $('match-detail-body').innerHTML =
    `<h2>Match #${match.id} — ${esc(CAMPAIGN_NAMES[match.campaign] ?? match.campaign)}</h2>` +
    `<p>${match.teamAScore} — ${match.teamBScore} · ${match.winner === 'draw' ? 'Draw' : `Team ${match.winner.toUpperCase()} wins`} · ${esc(fmtDate(match.endedAt))}</p>` +
    `<table><thead><tr><th>Map</th><th>A</th><th>B</th></tr></thead><tbody>` +
    maps.map((m) => `<tr><td>${esc(m.map)}</td><td>${m.teamAScore}</td><td>${m.teamBScore}</td></tr>`).join('') +
    '</tbody></table>' +
    `<div class="teams"><div><h3>Team A</h3>${teamTable('a')}</div><div><h3>Team B</h3>${teamTable('b')}</div></div>`;
  show('match-detail');
}

async function renderProfile(steamid) {
  const data = await fetchJson(`/api/players/${encodeURIComponent(steamid)}`);
  if (!data) { $('profile-body').innerHTML = '<p class="note">Player not found.</p>'; show('profile'); return; }
  const { player, rating, totals, matches, history } = data;
  const avatar = player.avatar ? `<img class="avatar" src="${esc(player.avatar)}" alt="">` : '';
  $('profile-body').innerHTML =
    `<div class="profile-head">${avatar}<div><h2>${esc(player.name)}</h2>` +
    (rating
      ? `<p class="sr big">${rating.sr} SR</p><p>${rating.wins}W — ${rating.losses}L</p>`
      : '<p class="note">Unrated this season.</p>') +
    '</div></div>' +
    sparkline(history.map((h) => h.sr)) +
    `<h3>Season totals</h3><p>${totals.games} games · ${totals.siDamage} SI damage · ${totals.siKills} SI kills · ` +
    `${totals.commonKills} commons · ${totals.ffDealt} FF · ${totals.revives} revives</p>` +
    '<h3>Recent matches</h3>' +
    (matches.length === 0 ? '<p class="note">None yet.</p>'
      : `<table><thead><tr><th>#</th><th>Campaign</th><th></th><th>Score</th><th>SR</th><th>Ended</th></tr></thead><tbody>` +
        matches.map((m) =>
          `<tr><td><a href="#/match/${m.id}">${m.id}</a></td><td>${esc(CAMPAIGN_NAMES[m.campaign] ?? m.campaign)}</td>` +
          `<td class="result-${m.result}">${RESULT_LABEL[m.result]}</td><td>${m.teamAScore} — ${m.teamBScore}</td>` +
          `<td>${srDeltaHtml(m.srDelta)}</td><td>${esc(fmtDate(m.endedAt))}</td></tr>`,
        ).join('') + '</tbody></table>');
  show('profile');
}

function route() {
  const hash = location.hash || '#/';
  for (const a of document.querySelectorAll('header nav a')) {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  }
  if (hash === '#/') refresh();
  else if (hash === '#/leaderboard') renderLeaderboard();
  else if (hash === '#/matches') renderMatches();
  else if (hash.startsWith('#/match/')) renderMatchDetail(hash.slice('#/match/'.length));
  else if (hash.startsWith('#/player/')) renderProfile(hash.slice('#/player/'.length));
  else { location.hash = '#/'; }
}

window.addEventListener('hashchange', route);
setInterval(() => { if (location.hash === '#/' || location.hash === '') { if (state?.lobby) render(); } }, 1000);
connectWs();
initDevPanel();
route();
