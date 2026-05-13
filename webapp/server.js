'use strict';

const express  = require('express');
const session  = require('express-session');
const FileStore = require('session-file-store')(session);
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const multer   = require('multer');
const sharp    = require('sharp');

const app = express();
app.set('trust proxy', 1); // Traefik termine le TLS

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const A1111_URL     = process.env.A1111_URL     || 'http://a1111:7860';
const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL  || '';
const DOMAIN        = process.env.DOMAIN         || 'localhost';
const PORT          = 8080;
const GEN_TIMEOUT   = 60 * 60 * 1000; // 60 min

// ── Session (persistée sur disque — survit aux redémarrages) ───────────────

app.use(session({
  store: new FileStore({
    path: '/data/sessions',
    ttl: 7 * 24 * 3600,   // 7 jours
    retries: 1,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' },
}));

// ── Passport / Google SSO ───────────────────────────────────────────────────

passport.use(new GoogleStrategy(
  {
    clientID:     process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    callbackURL:  `https://monoobd.${DOMAIN}/auth`,
  },
  (_at, _rt, profile, done) => {
    const email = profile.emails?.[0]?.value ?? '';
    if (ALLOWED_EMAIL && email !== ALLOWED_EMAIL) return done(null, false);
    done(null, { email, name: profile.displayName });
  },
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

const auth = (req, res, next) =>
  req.isAuthenticated() ? next() : res.redirect('/login');

// ── Auth routes ─────────────────────────────────────────────────────────────

app.get('/login', passport.authenticate('google', {
  scope: ['openid', 'email', 'profile'],
}));

app.get('/auth', passport.authenticate('google', {
  successRedirect: '/',
  failureRedirect: '/login',
}));

app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

// ── Pages ───────────────────────────────────────────────────────────────────

app.get('/', auth, (req, res) =>
  res.send(HTML.replace('{{USER}}', req.user.name)));

// ── API ──────────────────────────────────────────────────────────────────────

app.get('/api/status', async (_req, res) => {
  try {
    const r = await fetch(`${A1111_URL}/sdapi/v1/memory`,
      { signal: AbortSignal.timeout(5000) });
    res.json({ ready: r.ok });
  } catch {
    res.json({ ready: false });
  }
});

async function toB64(buffer, maxDim = 768) {
  const img  = sharp(buffer);
  const meta = await img.metadata();
  const scale = maxDim / Math.max(meta.width, meta.height);
  const out = scale < 1
    ? img.resize(Math.round(meta.width * scale), Math.round(meta.height * scale))
    : img;
  return (await out.png().toBuffer()).toString('base64');
}

async function findModel(pattern) {
  try {
    const r = await fetch(`${A1111_URL}/controlnet/model_list`,
      { signal: AbortSignal.timeout(10000) });
    const { model_list = [] } = await r.json();
    return model_list.find(m => m.includes(pattern)) ?? pattern;
  } catch {
    return pattern;
  }
}

async function img2img(payload) {
  const r = await fetch(`${A1111_URL}/sdapi/v1/img2img`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
    signal:  AbortSignal.timeout(GEN_TIMEOUT),
  });
  if (!r.ok) throw new Error(`A1111 ${r.status}: ${await r.text()}`);
  return (await r.json()).images[0];
}

app.post('/api/encrage', auth, upload.single('file'), async (req, res) => {
  try {
    const b64   = await toB64(req.file.buffer);
    const model = await findModel('scribble');
    res.json({ image: await img2img({
      init_images: [b64],
      prompt: 'manga line art, ligne claire style, Herge Tintin, black and white, '
            + 'crisp clean bold outlines, no color, ink drawing, '
            + 'professional Belgian comic book art, flat style',
      negative_prompt: 'color, blur, rough sketch, pencil marks, shading, '
                     + 'crosshatching, watermark, signature, low quality, noise, grain',
      steps: 20, cfg_scale: 7, denoising_strength: 0.7, sampler_name: 'Euler a',
      alwayson_scripts: { controlnet: { args: [{
        enabled: true, input_image: b64, module: 'scribble_hed', model,
        weight: 0.9, guidance_start: 0.0, guidance_end: 1.0,
      }]}},
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/colorisation', auth, upload.single('file'), async (req, res) => {
  try {
    const b64   = await toB64(req.file.buffer);
    const model = await findModel('lineart');
    res.json({ image: await img2img({
      init_images: [b64],
      prompt: 'Belgian comic book, Tintin Herge style, ligne claire, '
            + 'vibrant flat colors, bright primary colors, '
            + 'clean coloring, no shadows, professional colored illustration',
      negative_prompt: 'black and white, monochrome, dark, heavy shadows, '
                     + 'photorealistic, blurry, watermark, signature, low quality',
      steps: 20, cfg_scale: 7, denoising_strength: 0.5, sampler_name: 'Euler a',
      alwayson_scripts: { controlnet: { args: [{
        enabled: true, input_image: b64, module: 'lineart_realistic', model,
        weight: 0.8, guidance_start: 0.0, guidance_end: 1.0,
      }]}},
    }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`MonooBD :${PORT}`));

// ── HTML inline ────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MonooBD</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
header{background:#1e293b;padding:.875rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #334155}
.logo{font-size:1.25rem;font-weight:800;letter-spacing:-.5px}
.logo span{color:#f97316}
.meta{font-size:.8rem;color:#94a3b8}
.meta a{color:#fb923c;text-decoration:none;margin-left:.75rem}
.container{max-width:1100px;margin:2rem auto;padding:0 1.25rem}
.drop-zone{border:2px dashed #334155;border-radius:12px;padding:2.5rem 2rem;
  text-align:center;cursor:pointer;transition:border-color .2s,background .2s;background:#1e293b}
.drop-zone:hover,.drop-zone.over{border-color:#f97316;background:#1c1f30}
.drop-zone p{color:#64748b;font-size:.85rem;margin-top:.375rem}
.icon{color:#f97316}
input[type=file]{display:none}
.fname{font-size:.875rem;color:#fdba74;margin-top:.5rem;font-weight:500}
.actions{display:flex;gap:.75rem;margin-top:1.25rem;justify-content:center;flex-wrap:wrap}
button{padding:.625rem 1.75rem;border:none;border-radius:8px;font-size:.9rem;
  cursor:pointer;font-weight:600;transition:opacity .15s,transform .1s}
button:active{transform:scale(.97)}
button:disabled{opacity:.4;cursor:not-allowed}
.btn-ink{background:#1d4ed8;color:#fff}
.btn-ink:hover:not(:disabled){background:#2563eb}
.btn-col{background:#c2410c;color:#fff}
.btn-col:hover:not(:disabled){background:#ea580c}
.status{text-align:center;margin-top:1rem;font-size:.875rem;min-height:1.25rem;color:#94a3b8}
.status.loading{color:#fb923c}
.status.ok{color:#34d399}
.status.err{color:#f87171}
.spin{display:inline-block;width:10px;height:10px;border:2px solid currentColor;
  border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;
  margin-right:5px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.preview{display:none;margin-top:1.75rem;gap:1.25rem}
.preview.show{display:grid;grid-template-columns:1fr 1fr}
.panel{background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155}
.panel-title{padding:.5rem 1rem;font-size:.75rem;font-weight:600;color:#94a3b8;
  background:#0f172a;text-transform:uppercase;letter-spacing:.5px}
.panel img{width:100%;display:block;min-height:200px;background:#334155}
@media(max-width:640px){.preview.show{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div class="logo">Monoo<span>BD</span></div>
  <div class="meta">{{USER}}<a href="/logout">D&eacute;connexion</a></div>
</header>
<div class="container">
  <div class="drop-zone" id="dz">
    <input type="file" id="fi" accept="image/png,image/jpeg,image/webp">
    <svg class="icon" width="40" height="40" fill="none" stroke="currentColor"
         stroke-width="1.5" viewBox="0 0 24 24">
      <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M16 10l-4-4m0 0L8 10m4-4v12"/>
    </svg>
    <p>Glisse ton croquis ici ou <strong>clique pour parcourir</strong></p>
    <p>PNG &bull; JPG &bull; WebP &mdash; redimensionn&eacute; &agrave; 768&thinsp;px max c&ocirc;t&eacute; serveur</p>
    <div class="fname" id="fname"></div>
  </div>

  <div class="actions">
    <button class="btn-ink" id="bInk" disabled onclick="run('encrage')">
      &#9998;&nbsp;Encrer (B&amp;W ligne claire)
    </button>
    <button class="btn-col" id="bCol" disabled onclick="run('colorisation')">
      &#127912;&nbsp;Coloriser
    </button>
  </div>
  <div class="status" id="st"></div>

  <div class="preview" id="pv">
    <div class="panel">
      <div class="panel-title">Original</div>
      <img id="imgOrig" alt="Original">
    </div>
    <div class="panel">
      <div class="panel-title" id="resTitle">R&eacute;sultat</div>
      <img id="imgRes" alt="R&eacute;sultat">
    </div>
  </div>
</div>

<script>
var file=null;
var dz=document.getElementById('dz'),fi=document.getElementById('fi');
var bInk=document.getElementById('bInk'),bCol=document.getElementById('bCol');
var pv=document.getElementById('pv'),st=document.getElementById('st');
var imgOrig=document.getElementById('imgOrig'),imgRes=document.getElementById('imgRes');
var fname=document.getElementById('fname'),resTitle=document.getElementById('resTitle');

dz.onclick=function(){fi.click()};
dz.ondragover=function(e){e.preventDefault();dz.classList.add('over')};
dz.ondragleave=function(){dz.classList.remove('over')};
dz.ondrop=function(e){
  e.preventDefault();dz.classList.remove('over');
  if(e.dataTransfer.files[0])pick(e.dataTransfer.files[0]);
};
fi.onchange=function(){if(fi.files[0])pick(fi.files[0])};

function pick(f){
  file=f;
  fname.textContent=f.name;
  bInk.disabled=false;
  bCol.disabled=false;
  pv.classList.remove('show');
  setStatus('');
}

function setStatus(msg,cls){
  st.className='status '+(cls||'');
  st.innerHTML=(cls==='loading'?'<span class="spin"></span>':'')+msg;
}

async function run(action){
  if(!file)return;
  var r=new FileReader();
  r.onload=function(e){imgOrig.src=e.target.result};
  r.readAsDataURL(file);
  resTitle.textContent=action==='encrage'?'Encrage ligne claire':'Colorisation';
  bInk.disabled=true;bCol.disabled=true;
  pv.classList.remove('show');
  setStatus('G&eacute;n&eacute;ration en cours&hellip; peut prendre 10&ndash;30&nbsp;min sur CPU','loading');
  try{
    var fd=new FormData();
    fd.append('file',file);
    var resp=await fetch('/api/'+action,{method:'POST',body:fd});
    var data=await resp.json();
    if(data.error)throw new Error(data.error);
    imgRes.src='data:image/png;base64,'+data.image;
    pv.classList.add('show');
    setStatus('Termin&eacute; &#10003;','ok');
  }catch(e){
    setStatus('Erreur&nbsp;: '+e.message,'err');
  }finally{
    bInk.disabled=false;bCol.disabled=false;
  }
}

(async function pollReady(){
  var data=await fetch('/api/status').then(function(r){return r.json()}).catch(function(){return{ready:false}});
  if(!data.ready){
    setStatus('A1111 en cours de d&eacute;marrage&hellip;');
    setTimeout(pollReady,10000);
  }else{
    setStatus('');
  }
})();
</script>
</body>
</html>`;
