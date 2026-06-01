const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const urlMod   = require('url');
const qs       = require('querystring');
const { WebSocketServer } = require('ws');

// Render utilise process.env.PORT, sinon 3001 par défaut
const PORT         = process.env.PORT || 3001;
const SCOPES       = 'user-read-currently-playing user-read-playback-state';

const CONFIG_FILE  = path.join(__dirname, 'spotify-config.json');
const PRESETS_FILE = path.join(__dirname, 'presets.json');

// ── DATA SPOTIFY ──
let cfg = { clientId:'', clientSecret:'', refreshToken:'', accessToken:'', tokenExpiry:0 };
if (fs.existsSync(CONFIG_FILE)) {
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')) }; } catch(e){}
}
function saveCfg() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg,null,2)); }

let currentTrack = null;
let isConnected  = false;

// ── DATA TRAIN / BUS ──
let state = { operator: 'SNCF', trainNumber: '', origin: '', terminus: '', eta: '', stops: [], departed: false, fin: false, pax: false };
let powered = false;

function loadPresets() {
  try { return fs.existsSync(PRESETS_FILE) ? JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) : []; } catch (e) { return []; }
}
function savePresets(presets) {
  try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8'); return true; } catch (e) { return false; }
}

const MIME = { 
  '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
  '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml'
};

// ── CONFIGURATION DES REQUÊTES SPOTIFY ──
function spotifyPost(pathname, body, headers={}) {
  return new Promise((res,rej) => {
    const b = typeof body === 'string' ? body : qs.stringify(body);
    const req = https.request({ 
      hostname: 'accounts.spotify.com', 
      path: pathname, 
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b), ...headers }
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ res(JSON.parse(d)); }catch(e){ res({}); } }); });
    req.on('error',rej); req.write(b); req.end();
  });
}

function spotifyGet(pathname, headers={}) {
  return new Promise((res,rej) => {
    const req = https.request({ 
      hostname: 'api.spotify.com', 
      path: pathname, 
      method: 'GET', 
      headers 
    }, r => {
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{
        if (r.statusCode === 204) return res({ status: 204, data: null });
        try { res({ status: r.statusCode, data: JSON.parse(d) }); } catch(e) { res({ status: r.statusCode, data: null }); }
      });
    });
    req.on('error',rej); req.end();
  });
}

async function doRefresh() {
  if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) return false;
  const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  try {
    const r = await spotifyPost('/api/token', { grant_type: 'refresh_token', refresh_token: cfg.refreshToken }, { Authorization: `Basic ${creds}` });
    if (r.access_token) {
      cfg.accessToken = r.access_token;
      cfg.tokenExpiry = Date.now() + (r.expires_in - 60) * 1000;
      if (r.refresh_token) cfg.refreshToken = r.refresh_token;
      saveCfg(); return true;
    }
  } catch(e){}
  return false;
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
    const r = await spotifyGet('/v1/me/player/currently-playing', { Authorization: `Bearer ${token}` });
    if (!r || r.status === 204 || !r.data || !r.data.item) {
      if (currentTrack !== null) { currentTrack = null; broadcast({ type: 'track', track: null }); }
      return;
    }
    const item = r.data.item;
    const track = {
      id: item.id, title: item.name, artist: item.artists.map(a=>a.name).join(', '), album: item.album.name,
      albumArt: item.album.images[0]?.url || '', duration: item.duration_ms, progress: r.data.progress_ms, isPlaying: r.data.is_playing
    };
    const isNew = !currentTrack || currentTrack.id !== track.id;
    currentTrack = track;
    broadcast({ type: isNew ? 'newtrack' : 'progress', track });
  } catch(e){}
}
setInterval(poll, 1000);

// ── ROUTEUR PRINCIPAL (HUB / TRAIN / SPOTIFY) ──
const server = http.createServer(async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS,DELETE');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed = new urlMod.URL(req.url, `https://${req.headers.host}`);
  const pathname = parsed.pathname;
  const baseUrl = `https://${req.headers.host}`;
  const redirectUri = `${baseUrl}/callback`;

  // ── ROUTES AUTH SPOTIFY ──
  if (pathname === '/auth') {
    const p = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, scope: SCOPES, redirect_uri: redirectUri, show_dialog: 'true' });
    res.writeHead(302, { Location: `https://accounts.spotify.com/authorize?${p.toString()}` });
    return res.end();
  }

  if (pathname === '/callback') {
    const code = parsed.searchParams.get('code'), err = parsed.searchParams.get('error');
    if (err || !code) { res.writeHead(302, { Location: '/dashboard?error=denied' }); return res.end(); }
    const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    try {
      const r = await spotifyPost('/api/token', { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, { Authorization: `Basic ${creds}` });
      if (r.access_token) {
        cfg.accessToken = r.access_token;
        cfg.tokenExpiry = Date.now() + (r.expires_in - 60) * 1000;
        cfg.refreshToken = r.refresh_token;
        saveCfg();
        res.writeHead(302, { Location: '/dashboard?success=1' }); return res.end();
      }
    } catch(e){}
    res.writeHead(302, { Location: '/dashboard?error=token' }); return res.end();
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
        saveCfg();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // ── ROUTES API TRAIN / BUS (Pour le Stream Deck) ──
  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(state));
  }
  if (pathname === '/api/state' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try { state = JSON.parse(body); broadcast(state); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  if (pathname === '/api/power') {
    if (req.method === 'POST') {
      let body = ''; req.on('data', d => body += d); req.on('end', () => { try { const { power } = JSON.parse(body); powered = !!power; broadcast({ power: powered }); } catch(e){} });
    } else { powered = !powered; broadcast({ power: powered }); }
    console.log(`🔌 [STREAM DECK] Power -> URL : ${baseUrl}/api/power`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, power: powered }));
  }

  if (pathname === '/api/depart') {
    state.departed = true; state.pax = false; state.fin = false; broadcast(state);
    console.log(`🚂 [STREAM DECK] Départ -> URL : ${baseUrl}/api/depart`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/fin') {
    state.fin = true; state.pax = false; broadcast(state);
    console.log(`🏁 [STREAM DECK] Terminus -> URL : ${baseUrl}/api/fin`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/pax') {
    state.pax = !state.pax; broadcast(state);
    console.log(`👥 [STREAM DECK] Annonce PAX -> URL : ${baseUrl}/api/pax`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, pax: state.pax }));
  }
  
  if (pathname === '/api/next') {
    const cur = state.stops.findIndex(s => s.status === 'current');
    if (cur !== -1 && cur + 1 < state.stops.length) { state.stops[cur].status = 'passed'; state.stops[cur + 1].status = 'current'; }
    broadcast(state); console.log(`⏭️ [STREAM DECK] Suivante -> URL : ${baseUrl}/api/next`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/prev') {
    const cur = state.stops.findIndex(s => s.status === 'current');
    if (cur > 0) { state.stops[cur].status = 'upcoming'; state.stops[cur - 1].status = 'current'; }
    broadcast(state); console.log(`⏮️ [STREAM DECK] Précédente -> URL : ${baseUrl}/api/prev`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/presets' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(loadPresets()));
  }
  if (pathname === '/api/presets' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data)) { savePresets(data); } 
        else if (data && typeof data === 'object' && data.name) { const presets = loadPresets(); presets.push(data); savePresets(presets); } 
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, presets: loadPresets() }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  const delMatch = pathname.match(/^\/api\/presets\/(\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    const idx = parseInt(delMatch[1], 10); const presets = loadPresets();
    if (idx >= 0 && idx < presets.length) { presets.splice(idx, 1); savePresets(presets); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, presets }));
  }

// ── ROUTAGE DISTRIBUTION DES PAGES (HUB + DASHBOARDS) ──
  let fp;
  
  if (pathname === '/') {
      fp = path.join(__dirname, 'index.html');
  }
  else if (pathname === '/train') {
      fp = path.join(__dirname, 'dashboard.html');
  }
  else if (pathname === '/train-overlay') {
      fp = path.join(__dirname, 'overlay.html');
  }
  else if (pathname === '/dashboard') {
      fp = path.join(__dirname, 'nowplaying-dashboard.html');
  }
  else if (pathname === '/overlay') {
      fp = path.join(__dirname, 'nowplaying-overlay.html');
  }
  else {
      fp = path.join(__dirname, pathname);
  }

  const ext = path.extname(fp);
  if (!ext && fs.existsSync(fp + '.html')) fp += '.html';

  fs.readFile(fp, (err, data) => {
    if (err) { 
      // Si on arrive ici, c'est que le fichier est vraiment introuvable
      console.log("Erreur 404 - Fichier non trouvé : " + fp); 
      res.writeHead(404); 
      return res.end('Not found'); 
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' }); 
    res.end(data);
  });

// ── WEBSOCKETS HUB MIGRÉ RENDER ──
const wss = new WebSocketServer({ server });
function broadcast(data) {
  const m = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(m); });
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', track: currentTrack, connected: isConnected }));
  ws.send(JSON.stringify({ power: powered }));
  if (powered) ws.send(JSON.stringify(state));
});

// Garder le canal de communication WebSockets ouvert sur Render
setInterval(() => { wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'ping' })); }); }, 30000);

server.listen(PORT, () => { console.log(`🚀 HUB GLOBAL PRÊT SUR LE PORT ${PORT}`); });
