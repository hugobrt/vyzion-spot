const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const urlMod = require('url');
const qs = require('querystring');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;
const SCOPES = 'user-read-currently-playing user-read-playback-state';
const CONFIG_FILE = path.join(__dirname, 'spotify-config.json');
const PRESETS_FILE = path.join(__dirname, 'presets.json');
const PLANNING_FILE = path.join(__dirname, 'planning.json');
const RAPPORTS_FILE = path.join(__dirname, 'rapports.json');
const TWITCHCFG_FILE = path.join(__dirname, 'twitch-server.json');

// ── DATA SPOTIFY ──
let cfg = { clientId: '', clientSecret: '', refreshToken: '', accessToken: '', tokenExpiry: 0 };
if (fs.existsSync(CONFIG_FILE)) { try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch(e) {} }
function saveCfg() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
let currentTrack = null;
let isConnected = false;

// ── DATA TRAIN BUS ──
let state = { operator: 'SNCF', trainNumber: '', origin: '', terminus: '', eta: '', stops: [], departed: false, fin: false, pax: false };
let powered = false;

// ── ETS2 TELEMETRY ──
let ets2Data = { active: false };
let ets2LastUpdate = 0;
const ETS2_TIMEOUT = 5000; // 5s sans données = inactif

// ── DATA PLANNING ──
let planningData = [];
if (fs.existsSync(PLANNING_FILE)) { try { planningData = JSON.parse(fs.readFileSync(PLANNING_FILE, 'utf8')); } catch(e) {} }
function savePlanning() { try { fs.writeFileSync(PLANNING_FILE, JSON.stringify(planningData, null, 2)); } catch(e) {} }

// ── DATA RAPPORTS ──
let rapportsData = [];
if (fs.existsSync(RAPPORTS_FILE)) { try { rapportsData = JSON.parse(fs.readFileSync(RAPPORTS_FILE, 'utf8')); } catch(e) {} }
function saveRapports() { try { fs.writeFileSync(RAPPORTS_FILE, JSON.stringify(rapportsData, null, 2)); } catch(e) {} }

// ── CONFIG TWITCH SERVEUR ──
let twitchCfg = { clientId: '', clientSecret: '', userId: '', username: '' };
if (fs.existsSync(TWITCHCFG_FILE)) { try { twitchCfg = { ...twitchCfg, ...JSON.parse(fs.readFileSync(TWITCHCFG_FILE, 'utf8')) }; } catch(e) {} }
function saveTwitchCfg() { fs.writeFileSync(TWITCHCFG_FILE, JSON.stringify(twitchCfg, null, 2)); }
let twitchAppToken = null;
let twitchTokenExpiry = 0;

function loadPresets() { try { return fs.existsSync(PRESETS_FILE) ? JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) : []; } catch(e) { return []; } }
function savePresets(presets) { try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8'); return true; } catch(e) { return false; } }

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ── REQUÊTES VERS SERVEUR SPOTIFY ──
function spotifyPost(pathname, body, headers) {
  return new Promise((res, rej) => {
    const b = typeof body === 'string' ? body : qs.stringify(body);
    const req = https.request({ hostname: 'accounts.spotify.com', path: pathname, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b), ...headers } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch(e) { res({}); } });
    });
    req.on('error', rej); req.write(b); req.end();
  });
}
function spotifyGet(pathname, headers) {
  return new Promise((res, rej) => {
    const req = https.request({ hostname: 'api.spotify.com', path: pathname, method: 'GET', headers }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode === 204) return res({ status: 204, data: null });
        try { res({ status: r.statusCode, data: JSON.parse(d) }); } catch(e) { res({ status: r.statusCode, data: null }); }
      });
    });
    req.on('error', rej); req.end();
  });
}
async function doRefresh() {
  if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) return false;
  const creds = Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
  try {
    const r = await spotifyPost('/api/token', { grant_type: 'refresh_token', refresh_token: cfg.refreshToken }, { Authorization: 'Basic ' + creds });
    if (r.access_token) { cfg.accessToken = r.access_token; cfg.tokenExpiry = Date.now() + (r.expires_in - 60) * 1000; }
    if (r.refresh_token) cfg.refreshToken = r.refresh_token;
    saveCfg(); return true;
  } catch(e) { return false; }
}
async function getToken() {
  if (cfg.accessToken && Date.now() < cfg.tokenExpiry) return cfg.accessToken;
  return (await doRefresh()) ? cfg.accessToken : null;
}
async function poll() {
  const token = await getToken();
  if (!token) { isConnected = false; return; }
  isConnected = true;
  try {
    const r = await spotifyGet('/v1/me/player/currently-playing', { Authorization: 'Bearer ' + token });
    if (!r || r.status === 204 || !r.data || !r.data.item) {
      if (currentTrack !== null) { currentTrack = null; broadcast({ type: 'track', track: null }); }
      return;
    }
    const item = r.data.item;
    const track = { id: item.id, title: item.name, artist: item.artists.map(a => a.name).join(', '), album: item.album.name, albumArt: item.album.images[0]?.url, duration: item.duration_ms, progress: r.data.progress_ms, isPlaying: r.data.is_playing };
    const isNew = !currentTrack || currentTrack.id !== track.id;
    currentTrack = track;
    broadcast({ type: isNew ? 'newtrack' : 'progress', track });
  } catch(e) {}
}
setInterval(poll, 1000);

// ── TWITCH TOKEN APP ──
async function getTwitchAppToken() {
  if (twitchAppToken && Date.now() < twitchTokenExpiry) return twitchAppToken;
  if (!twitchCfg.clientId || !twitchCfg.clientSecret) return null;
  return new Promise(resolve => {
    const body = `client_id=${twitchCfg.clientId}&client_secret=${twitchCfg.clientSecret}&grant_type=client_credentials`;
    const req = https.request({ hostname: 'id.twitch.tv', path: '/oauth2/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.access_token) { twitchAppToken = json.access_token; twitchTokenExpiry = Date.now() + (json.expires_in - 300) * 1000; resolve(twitchAppToken); }
          else resolve(null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}
function twitchApiGet(apiPath, token, clientId) {
  return new Promise(resolve => {
    const req = https.request({ hostname: 'api.twitch.tv', path: apiPath, method: 'GET', headers: { 'Authorization': 'Bearer ' + token, 'Client-Id': clientId } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

// ── TWITCH SUIVI STREAM EN COURS ──
let streamState = { live: false, streamId: null, startedAt: null, title: '', gameName: '', followersAtStart: 0, viewerSnapshots: [], chatMessages: 0, topChatters: {} };

async function pollTwitchStream() {
  if (!twitchCfg.clientId || !twitchCfg.userId) return;
  const token = await getTwitchAppToken();
  if (!token) return;
  const streams = await twitchApiGet(`/helix/streams?user_id=${twitchCfg.userId}`, token, twitchCfg.clientId);
  const isLive = !!streams?.data?.[0];
  if (isLive && !streamState.live) {
    const s = streams.data[0];
    const follows = await twitchApiGet(`/helix/channels/followers?broadcaster_id=${twitchCfg.userId}&first=1`, token, twitchCfg.clientId);
    streamState = { live: true, streamId: s.id, startedAt: s.started_at, title: s.title, gameName: s.game_name, followersAtStart: follows?.total || 0, viewerSnapshots: [{ ts: Date.now(), count: s.viewer_count }], chatMessages: 0, topChatters: {} };
    console.log('[rapport] Stream démarré:', s.title);
  } else if (isLive && streamState.live) {
    const s = streams.data[0];
    streamState.viewerSnapshots.push({ ts: Date.now(), count: s.viewer_count });
    streamState.title = s.title; streamState.gameName = s.game_name;
  } else if (!isLive && streamState.live) {
    await generateRapport();
    streamState.live = false;
  }
}
setInterval(pollTwitchStream, 2 * 60 * 1000);

async function generateRapport() {
  const token = await getTwitchAppToken();
  let newFollowers = 0;
  if (token && twitchCfg.userId) {
    const follows = await twitchApiGet(`/helix/channels/followers?broadcaster_id=${twitchCfg.userId}&first=1`, token, twitchCfg.clientId);
    newFollowers = Math.max(0, (follows?.total || 0) - streamState.followersAtStart);
  }
  const snaps = streamState.viewerSnapshots;
  const avgViewers = snaps.length ? Math.round(snaps.reduce((s, v) => s + v.count, 0) / snaps.length) : 0;
  const peakViewers = snaps.length ? Math.max(...snaps.map(v => v.count)) : 0;
  const durationMs = streamState.startedAt ? Date.now() - new Date(streamState.startedAt).getTime() : 0;
  const topChatters = Object.entries(streamState.topChatters).sort((a, b) => b[1] - a[1]).slice(0, 5).map(u => u[0]);
  const rapport = { id: Date.now().toString(36), startedAt: streamState.startedAt || new Date().toISOString(), endedAt: new Date().toISOString(), title: streamState.title || 'Stream', gameName: streamState.gameName || '', durationMs, avgViewers, peakViewers, newFollowers, chatMessages: streamState.chatMessages || 0, topChatters };
  rapportsData.unshift(rapport);
  if (rapportsData.length > 50) rapportsData = rapportsData.slice(0, 50);
  saveRapports();
  console.log('[rapport] Généré:', rapport.title, '| avg', avgViewers, 'viewers,', newFollowers, 'follows');
  broadcast({ type: 'rapportready', rapport });
}

// ── ROUTEUR ──
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = new urlMod.URL(req.url, `https://${req.headers.host}`);
  const pathname = parsed.pathname;
  const baseUrl = `https://${req.headers.host}`;
  const redirectUri = baseUrl + '/callback';

  // ── ROUTES AUTH SPOTIFY ──
  if (pathname === '/auth') {
    const p = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, scope: SCOPES, redirect_uri: redirectUri, show_dialog: true });
    res.writeHead(302, { Location: 'https://accounts.spotify.com/authorize?' + p.toString() }); return res.end();
  }
  if (pathname === '/callback') {
    const code = parsed.searchParams.get('code'), err = parsed.searchParams.get('error');
    if (err || !code) { res.writeHead(302, { Location: '/dashboard?error=denied' }); return res.end(); }
    const creds = Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64');
    try {
      const r = await spotifyPost('/api/token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, { Authorization: 'Basic ' + creds });
      if (r.access_token) { cfg.accessToken = r.access_token; cfg.tokenExpiry = Date.now() + (r.expires_in - 60) * 1000; cfg.refreshToken = r.refresh_token; saveCfg(); }
      res.writeHead(302, { Location: '/dashboard?success=1' }); return res.end();
    } catch(e) { res.writeHead(302, { Location: '/dashboard?error=token' }); return res.end(); }
  }
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ connected: isConnected, hasCredentials: !!(cfg.clientId && cfg.clientSecret), hasToken: !!cfg.refreshToken, track: currentTrack }));
  }
  if (pathname === '/api/config' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        if (d.clientId) cfg.clientId = d.clientId.trim();
        if (d.clientSecret) cfg.clientSecret = d.clientSecret.trim();
        saveCfg(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }

  // ── ROUTES API TRAIN BUS ──
  if (pathname === '/api/state' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(state)); }
  if (pathname === '/api/state' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => { try { state = JSON.parse(body); broadcast(state); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); } catch(e) { res.writeHead(400); res.end('Bad JSON'); } });
    return;
  }
  if (pathname === '/api/power') {
    if (req.method === 'POST') {
      let body = ''; req.on('data', d => body += d);
      req.on('end', () => { try { const p = JSON.parse(body); powered = !!p.power; broadcast({ power: powered }); } catch(e) { powered = !powered; broadcast({ power: powered }); } });
    } else { powered = !powered; broadcast({ power: powered }); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, power: powered }));
  }
  if (pathname === '/api/depart') { state.departed = true; state.pax = false; state.fin = false; broadcast(state); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
  if (pathname === '/api/fin') { state.fin = true; state.pax = false; broadcast(state); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
  if (pathname === '/api/pax') { state.pax = !state.pax; broadcast(state); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, pax: state.pax })); }
  if (pathname === '/api/next') {
    const cur = state.stops.findIndex(s => s.status === 'current');
    if (cur !== -1 && cur + 1 < state.stops.length) { state.stops[cur].status = 'passed'; state.stops[cur + 1].status = 'current'; broadcast(state); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }
  if (pathname === '/api/prev') {
    const cur = state.stops.findIndex(s => s.status === 'current');
    if (cur > 0) { state.stops[cur].status = 'upcoming'; state.stops[cur - 1].status = 'current'; broadcast(state); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }
  if (pathname === '/api/presets' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(loadPresets())); }
  if (pathname === '/api/presets' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data)) { savePresets(data); } else if (data && typeof data === 'object' && data.name) { const presets = loadPresets(); presets.push(data); savePresets(presets); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, presets: loadPresets() }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }
  const delMatch = pathname.match(/^\/api\/presets\/(\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    const idx = parseInt(delMatch[1], 10); const presets = loadPresets();
    if (idx >= 0 && idx < presets.length) { presets.splice(idx, 1); savePresets(presets); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, presets }));
  }

  // ── ROUTES PLANNING ──
  if (pathname === '/api/planning' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(planningData)); }
  if (pathname === '/api/planning' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed)) { res.writeHead(400); return res.end('Expected array'); }
        planningData = parsed; savePlanning();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, count: planningData.length }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }
  const planDelMatch = pathname.match(/^\/api\/planning\/([a-z0-9]+)$/);
  if (planDelMatch && req.method === 'DELETE') {
    const id = planDelMatch[1]; planningData = planningData.filter(s => s.id !== id); savePlanning();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }

  // ── ROUTES RAPPORTS ──
  if (pathname === '/api/twitch-config' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        if (d.clientId) twitchCfg.clientId = d.clientId.trim();
        if (d.clientSecret) twitchCfg.clientSecret = d.clientSecret.trim();
        if (d.userId) twitchCfg.userId = d.userId.trim();
        if (d.username) twitchCfg.username = d.username.trim();
        saveTwitchCfg(); twitchAppToken = null;
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }
  if (pathname === '/api/rapports' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(rapportsData)); }
  if (pathname === '/api/rapports' && req.method === 'DELETE') { rapportsData = []; saveRapports(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
  const rapportDelMatch = pathname.match(/^\/api\/rapports\/([a-z0-9]+)$/);
  if (rapportDelMatch && req.method === 'DELETE') {
    const id = rapportDelMatch[1]; rapportsData = rapportsData.filter(r => r.id !== id); saveRapports();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }
  if (pathname === '/api/rapports/test' && req.method === 'POST') {
    const titles = ['Session GTA RP', 'Nuit IRL', 'Ranked Warzone', 'Just Chatting', 'Horror Night'];
    const games  = ['GTA V', 'IRL', 'Warzone 2.0', 'Just Chatting', 'Phasmophobia'];
    const i = Math.floor(Math.random() * titles.length);
    const test = { id: Date.now().toString(36), startedAt: new Date(Date.now() - (2 + Math.random() * 3) * 3600000).toISOString(), endedAt: new Date().toISOString(), title: titles[i], gameName: games[i], durationMs: Math.floor((2 + Math.random() * 4) * 3600000), avgViewers: Math.floor(8 + Math.random() * 40), peakViewers: Math.floor(20 + Math.random() * 80), newFollowers: Math.floor(Math.random() * 15), chatMessages: Math.floor(50 + Math.random() * 500), topChatters: ['darkwolf42', 'lazer_hbr', 'trainspotter99', 'vyzfan', 'raideurxl'].slice(0, 3 + Math.floor(Math.random() * 3)) };
    rapportsData.unshift(test);
    if (rapportsData.length > 50) rapportsData = rapportsData.slice(0, 50);
    saveRapports();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rapport: test }));
  }

  // ── ROUTES ETS2 TELEMETRY ──
  if (pathname === '/api/telemetry' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const d = JSON.parse(body);
        ets2Data = d; ets2LastUpdate = Date.now();
        broadcast({ type: 'telemetry', data: d });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    });
    return;
  }
  if (pathname === '/api/telemetry' && req.method === 'GET') {
    const active = ets2Data.active && (Date.now() - ets2LastUpdate < ETS2_TIMEOUT);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...ets2Data, active }));
  }

  // ── SERVIR LES PAGES ──
  let fp;
  if (pathname === '/') fp = path.join(__dirname, 'index.html');
  else if (pathname === '/train') fp = path.join(__dirname, 'dashboard.html');
  else if (pathname === '/train-overlay') fp = path.join(__dirname, 'overlay.html');
  else if (pathname === '/dashboard') fp = path.join(__dirname, 'nowplaying-dashboard.html');
  else if (pathname === '/overlay') fp = path.join(__dirname, 'nowplaying-overlay.html');
  else if (pathname === '/off') fp = path.join(__dirname, 'off.html');
  else if (pathname === '/pbl') fp = path.join(__dirname, 'planningpublic.html');
  else if (pathname === '/stats') fp = path.join(__dirname, 'twitch_stats.html');
  else if (pathname === '/planning') fp = path.join(__dirname, 'planningstream.html');
  else if (pathname === '/rapport') fp = path.join(__dirname, 'rapport.html');
  else if (pathname === '/ets2') fp = path.join(__dirname, 'ets2_overlay.html');
  else fp = path.join(__dirname, pathname);

  const ext = path.extname(fp);
  if (!ext && !fs.existsSync(fp)) fp += '.html';
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
});

// ── WEBSOCKETS ──
const wss = new WebSocketServer({ server });
function broadcast(data) { const m = JSON.stringify(data); wss.clients.forEach(c => { if (c.readyState === 1) c.send(m); }); }
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', track: currentTrack, connected: isConnected }));
  ws.send(JSON.stringify({ power: powered }));
  if (powered) ws.send(JSON.stringify(state));
  // Envoyer l'état telemetry ETS2 si actif
  const ets2Active = ets2Data.active && (Date.now() - ets2LastUpdate < ETS2_TIMEOUT);
  if (ets2Active) ws.send(JSON.stringify({ type: 'telemetry', data: ets2Data }));
});
setInterval(() => { wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'ping' })); }); }, 30000);

// ── KEEP-ALIVE ──
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  const proto = SELF_URL.startsWith('https') ? https : http;
  proto.get(SELF_URL + '/api/state', res => { console.log('keep-alive ping', res.statusCode); res.resume(); }).on('error', e => console.warn('keep-alive erreur', e.message));
}, 4 * 60 * 1000);

server.listen(PORT, () => console.log(`SERVEUR PRÊT SUR LE PORT ${PORT}`));
