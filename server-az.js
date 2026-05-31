const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const urlMod   = require('url');
const qs       = require('querystring');
const { WebSocketServer } = require('ws');

// Choix dynamique du port pour Render (ou 3001 en local)
const PORT = process.env.PORT || 3001;
const SCOPES       = 'user-read-currently-playing user-read-playback-state';
const CONFIG_FILE  = path.join(__dirname, 'spotify-config.json');

let cfg = { clientId:'', clientSecret:'', refreshToken:'', accessToken:'', tokenExpiry:0 };
if (fs.existsSync(CONFIG_FILE)) {
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')) }; } catch(e){}
}
function saveCfg() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg,null,2)); }

const MIME = { '.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json' };

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
    const r = await httpsPost('api.spotify.com','/api/token',
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

let currentTrack = null;
let isConnected  = false;

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

const server = http.createServer(async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method==='OPTIONS') { res.writeHead(204); return res.end(); }

  // Détection dynamique de l'hôte pour s'adapter aussi bien à Localhost qu'à l'URL Render
  const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const host = req.headers.host;
  const baseUri = `${protocol}://${host}`;
  const REDIRECT_URI = `${baseUri}/callback`;

  const parsed   = new urlMod.URL(req.url, baseUri);
  const pathname = parsed.pathname;

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

  let fp;
  if (pathname==='/'||pathname==='/dashboard') fp = path.join(__dirname,'nowplaying-dashboard.html');
  else if (pathname==='/overlay')              fp = path.join(__dirname,'nowplaying-overlay.html');
  else fp = path.join(__dirname, pathname);

  const ext = path.extname(fp)||'.html';
  fs.readFile(fp,(err,data)=>{
    if (err){ res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200,{'Content-Type':MIME[ext]||'text/plain'}); res.end(data);
  });
});

const wss = new WebSocketServer({ server });
function broadcast(data) {
  const m=JSON.stringify(data);
  wss.clients.forEach(c=>{ if(c.readyState===1) c.send(m); });
}
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type:'init', track:currentTrack, connected:isConnected }));
});

// Logs d'initialisation intelligents et propres
server.listen(PORT, () => {
    console.log("\n ==========================================");
    console.log("  🎵 Now Playing Overlay — Serveur Actif");
    console.log(" ==========================================");
    if (process.env.PORT) {
        console.log(`  Statut    : En ligne (Production Render)`);
        console.log(`  Port web  : ${PORT}`);
    } else {
        console.log(`  Statut    : Localhost (Développement)`);
        console.log(`  Dashboard : http://localhost:${PORT}`);
        console.log(`  Overlay   : http://localhost:${PORT}/overlay`);
    }
    console.log(" ==========================================\n");
});
