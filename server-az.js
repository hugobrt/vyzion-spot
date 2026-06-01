const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const urlMod   = require('url');
const qs       = require('querystring');
const { WebSocketServer } = require('ws');

// Configuration du Port unique (Render compatible)
const PORT         = process.env.PORT || 3001;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES       = 'user-read-currently-playing user-read-playback-state';

// Fichiers de configuration et de persistance
const CONFIG_FILE  = path.join(__dirname, 'spotify-config.json');
const PRESETS_FILE = path.join(__dirname, 'presets.json');

// ── DATA & CONFIGURATION SPOTIFY ──
let cfg = { clientId:'', clientSecret:'', refreshToken:'', accessToken:'', tokenExpiry:0 };
if (fs.existsSync(CONFIG_FILE)) {
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')) }; } catch(e){}
}
function saveCfg() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg,null,2)); }

let currentTrack = null;
let isConnected  = false;

// ── DATA & PRESETS TRAIN / BUS ──
let state = {
  operator: 'SNCF',
  trainNumber: '',
  origin: '',
  terminus: '',
  eta: '',
  stops: [],
  departed: false,
  fin: false,
  pax: false
};
let powered = false;

function loadPresets() {
  try {
    if (!fs.existsSync(PRESETS_FILE)) return [];
    const raw = fs.readFileSync(PRESETS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn('⚠️ Erreur lecture presets.json:', e.message);
    return [];
  }
}
function savePresets(presets) {
  try {
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.warn('⚠️ Erreur écriture presets.json:', e.message);
    return false;
  }
}

// ── FUSION DES TYPES MIME ──
const MIME = { 
  '.html':'text/html',
  '.css':'text/css',
  '.js':'application/javascript',
  '.json':'application/json',
  '.png':'image/png',
  '.svg':'image/svg+xml'
};

// ── FONCTIONS LOGIQUES DE L'API SPOTIFY (CORRIGÉES) ──
function httpsPost(hostname, pathname, body, headers={}) {
  return new Promise((res,rej) => {
    const b = typeof body === 'string' ? body : qs.stringify(body);
    const req = https.request({ hostname, path:pathname, method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(b),...headers}
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ res(JSON.parse(d)); }catch(e){ res({}); } }); });
    req.on('error',rej); req.write(b); req.end();
  });
}

function httpsGet(hostname, pathname, headers={}) {
  return new Promise((res,rej) => {
    const req = https.request({ hostname, path:pathname, method:'GET', headers }, r => {
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{
        if (r.statusCode===204){ res({status:204,data:null}); return; }
        try{ res({status:r.statusCode,data:JSON.parse(d)}); }catch(e){ res({status:r.statusCode,data:null}); }
      });
    });
    req.on('error',rej); req.end();
  });
}

async function doRefresh() {
  if (!cfg.refreshToken||!cfg.clientId||!cfg.clientSecret) return false;
  const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  try {
    const r = await httpsPost('accounts.spotify.com','/api/token',
      { grant_type:'refresh_token', refresh_token:cfg.refreshToken },
      { Authorization:`Basic ${creds}` });
    if (r.access_token) {
      cfg.accessToken  = r.access_token;
      cfg.tokenExpiry  = Date.now() + (r.expires_in-60)*1000;
      if (r.refresh_token) cfg.refreshToken = r.refresh_token;
      saveCfg(); return true;
    }
  } catch(e){}
  return false;
}

async function getToken() {
  if (cfg.accessToken && Date.now()<cfg.tokenExpiry) return cfg.accessToken;
  return (await doRefresh()) ? cfg.accessToken : null;
}

async function poll() {
  const token = await getToken();
  if (!token) { isConnected=false; return; }
  isConnected = true;
  try {
    const r = await httpsGet('api.spotify.com','/v1/me/player/currently-playing',{Authorization:`Bearer ${token}`});
    if (!r||r.status===204||!r.data||!r.data.item) {
      if (currentTrack!==null) { currentTrack=null; broadcast({type:'track',track:null}); }
      return;
    }
    const item = r.data.item;
    const track = {
      id:        item.id,
      title:     item.name,
      artist:    item.artists.map(a=>a.name).join(', '),
      album:     item.album.name,
      albumArt:  item.album.images[0]?.url||'',
      duration:  item.duration_ms,
      progress:  r.data.progress_ms,
      isPlaying: r.data.is_playing
    };
    const isNew = !currentTrack || currentTrack.id!==track.id;
    currentTrack = track;
    broadcast({ type: isNew?'newtrack':'progress', track });
  } catch(e){}
}
setInterval(poll, 1000);
setTimeout(poll, 500);


// ── ROUTEUR HTTP CENTRALISÉ ──
const server = http.createServer(async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS,DELETE');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = new urlMod.URL(req.url,`http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  // ── [ROUTES API : SPOTIFY CORRIGÉES] ──
  if (pathname==='/auth') {
    const p = new urlMod.URLSearchParams({ response_type:'code', client_id:cfg.clientId, scope:SCOPES, redirect_uri:REDIRECT_URI, show_dialog:'true' });
    res.writeHead(302,{Location:`https://accounts.spotify.com/authorize?${p}`}); return res.end();
  }

  if (pathname==='/callback') {
    const code=parsed.searchParams.get('code'), err=parsed.searchParams.get('error');
    if (err||!code){ res.writeHead(302,{Location:'/dashboard?error=denied'}); return res.end(); }
    const creds = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    try {
      const r = await httpsPost('accounts.spotify.com','/api/token',
        { grant_type:'authorization_code', code, redirect_uri:REDIRECT_URI },
        { Authorization:`Basic ${creds}` });
      if (r.access_token) {
        cfg.accessToken  = r.access_token;
        cfg.tokenExpiry  = Date.now()+(r.expires_in-60)*1000;
        cfg.refreshToken = r.refresh_token;
        saveCfg();
        res.writeHead(302,{Location:'/dashboard?success=1'}); return res.end();
      }
    } catch(e){}
    res.writeHead(302,{Location:'/dashboard?error=token'}); return res.end();
  }

  if (pathname==='/api/status') {
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ connected:isConnected, hasCredentials:!!(cfg.clientId&&cfg.clientSecret), hasToken:!!cfg.refreshToken, track:currentTrack }));
  }

  if (pathname==='/api/config' && req.method==='POST') {
    let body=''; req.on('data',d=>body+=d);
    req.on('end',()=>{
      try {
        const d=JSON.parse(body);
        if (d.clientId)     cfg.clientId     = d.clientId.trim();
        if (d.clientSecret) cfg.clientSecret = d.clientSecret.trim();
        saveCfg();
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
      } catch(e){ res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  // ── [ROUTES API : TRAIN / BUS] ──
  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state));
  }

  if (pathname === '/api/state' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        state = JSON.parse(body);
        broadcast(state);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  if (pathname === '/api/power' && req.method === 'POST') {
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { power } = JSON.parse(body);
        powered = !!power;
        broadcast({ power: powered });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, power: powered }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  if (pathname === '/api/fin' && (req.method === 'GET' || req.method === 'POST')) {
    state.fin = true; state.pax = false;
    broadcast(state);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/depart' && (req.method === 'GET' || req.method === 'POST')) {
    state.departed = true; state.pax = false;
    broadcast(state);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/pax' && (req.method === 'GET' || req.method === 'POST')) {
    state.pax = !state.pax;
    broadcast(state);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, pax: state.pax }));
  }

  if (pathname === '/api/next' && (req.method === 'POST' || req.method === 'GET')) {
    const cur = state.stops.findIndex(s => s.status === 'current');
    if (cur !== -1 && cur + 1 < state.stops.length) {
      state.stops[cur].status = 'passed';
      state.stops[cur + 1].status = 'current';
    }
    broadcast(state);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true }));
  }

  if (pathname === '/api/prev' && (req.method === 'POST' || req.method === 'GET')) {
    const cur = state.stops.findIndex(s => s.status === 'current');
    if (cur > 0) {
      state.stops[cur].status = 'upcoming';
      state.stops[cur - 1].status = 'current';
    }
    broadcast(state);
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
        else if (data && typeof data === 'object' && data.name) {
          const presets = loadPresets(); presets.push(data); savePresets(presets);
        } else { res.writeHead(400); return res.end('Bad payload'); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, presets: loadPresets() }));
      } catch(e) { res.writeHead(400); res.end('Bad JSON'); }
    }); return;
  }

  const delMatch = pathname.match(/^\/api\/presets\/(\d+)$/);
  if (delMatch && req.method === 'DELETE') {
    const idx = parseInt(delMatch[1], 10);
    const presets = loadPresets();
    if (idx >= 0 && idx < presets.length) { presets.splice(idx, 1); savePresets(presets); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, presets }));
  }

  // ── [DISTRIBUTION DES FICHIERS STATIQUES] ──
  let fp;
  if (pathname === '/') {
    fp = path.join(__dirname, 'index.html');
  } else if (pathname === '/dashboard') {
    fp = path.join(__dirname, 'nowplaying-dashboard.html');
  } else if (pathname === '/overlay') {
    fp = path.join(__dirname, 'nowplaying-overlay.html');
  } else if (pathname === '/train' || pathname === '/train-dashboard') {
    fp = path.join(__dirname, 'dashboard.html');
  } else if (pathname === '/train-overlay') {
    fp = path.join(__dirname, 'overlay.html');
  } else {
    fp = path.join(__dirname, pathname);
  }

  const ext = path.extname(fp)||'.html';
  fs.readFile(fp,(err,data)=>{
    if (err){ res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200,{'Content-Type':MIME[ext]||'text/plain'}); res.end(data);
  });
});

// ── DOUBLE ROUTAGE ET SELECTION WEBSOCKET ──
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const m=JSON.stringify(data);
  wss.clients.forEach(c=>{ if(c.readyState===1) c.send(m); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type:'init', track:currentTrack, connected:isConnected }));
  ws.send(JSON.stringify({ power: powered }));
  if (powered) ws.send(JSON.stringify(state));
});

// PING DE MAINTIEN EN VIE AUTOMATIQUE (Anti-Timeout Render)
setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'ping' }));
    }
  });
}, 30000);

// DÉMARRAGE
server.listen(PORT, ()=>{
  console.log(`\n🚀 SERVEUR CENTRALISÉ RECORRIGÉ (Port ${PORT})`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(` 🎵 SPOTIFY : http://localhost:${PORT}/dashboard`);
  console.log(` 🚂 TRAIN / BUS : http://localhost:${PORT}/train`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
