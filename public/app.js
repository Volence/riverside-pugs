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

let state = null;

function show(id) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== id;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'POST',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return res;
}

async function refresh() {
  const meRes = await fetch('/api/me');
  if (meRes.status === 401) { $('whoami').textContent = ''; show('login'); return; }
  const me = await meRes.json();
  $('whoami').textContent = me.name;
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
  ws.onmessage = () => refresh();
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
}

setInterval(() => { if (state?.lobby) render(); }, 1000); // tick countdowns
connectWs();
initDevPanel();
refresh();
