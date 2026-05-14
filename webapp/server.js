'use strict';

const express   = require('express');
const session   = require('express-session');
const FileStore = require('session-file-store')(session);
const passport  = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const multer    = require('multer');
const sharp     = require('sharp');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const A1111_URL     = process.env.A1111_URL     || 'http://a1111:7860';
const ALLOWED_EMAIL = process.env.ALLOWED_EMAIL  || '';
const DOMAIN        = process.env.DOMAIN         || 'localhost';
const PORT          = 8080;
const GEN_TIMEOUT   = 60 * 60 * 1000;
const PROJECTS_DIR  = '/data/projects';

if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// ── Projets helpers ──────────────────────────────────────────────────────────

function loadProject(id) {
  const file = path.join(PROJECTS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveProject(project) {
  fs.writeFileSync(
    path.join(PROJECTS_DIR, `${project.id}.json`),
    JSON.stringify(project, null, 2),
  );
}

function listProjects() {
  return fs.readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
        return { id: p.id, name: p.name, createdAt: p.createdAt, renderCount: (p.renders || []).length };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Session ──────────────────────────────────────────────────────────────────

app.use(session({
  store: new FileStore({
    path: '/data/sessions',
    ttl: 7 * 24 * 3600,
    retries: 1,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' },
}));

// ── Passport / Google SSO ────────────────────────────────────────────────────

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

// ── Auth routes ──────────────────────────────────────────────────────────────

app.get('/login', passport.authenticate('google', {
  scope: ['openid', 'email', 'profile'],
}));

app.get('/auth', passport.authenticate('google', {
  successRedirect: '/',
  failureRedirect: '/login',
}));

app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

// ── Pages ────────────────────────────────────────────────────────────────────

app.get('/', auth, (req, res) =>
  res.send(HTML.replace('{{USER}}', req.user.name)));

// ── API : statut A1111 ───────────────────────────────────────────────────────

app.get('/api/status', async (_req, res) => {
  try {
    const r = await fetch(`${A1111_URL}/sdapi/v1/memory`,
      { signal: AbortSignal.timeout(5000) });
    res.json({ ready: r.ok });
  } catch {
    res.json({ ready: false });
  }
});

// ── API : infos session ──────────────────────────────────────────────────────

app.get('/api/session-info', auth, (req, res) => {
  res.json({ lastRenderPrompt: req.session.lastRenderPrompt || '' });
});

// ── API : projets ────────────────────────────────────────────────────────────

app.get('/api/projects', auth, (_req, res) => {
  res.json(listProjects());
});

app.post('/api/projects', auth, (req, res) => {
  const { name, projectPrompt = '' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  const project = {
    id: crypto.randomBytes(8).toString('hex'),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    projectPrompt,
    renders: [],
  };
  saveProject(project);
  res.json(project);
});

app.get('/api/projects/:id', auth, (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projet introuvable' });
  res.json(project);
});

app.patch('/api/projects/:id', auth, (req, res) => {
  const project = loadProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projet introuvable' });
  const { name, projectPrompt } = req.body;
  if (name !== undefined) project.name = name.trim();
  if (projectPrompt !== undefined) project.projectPrompt = projectPrompt;
  saveProject(project);
  res.json({ id: project.id, name: project.name, projectPrompt: project.projectPrompt });
});

app.delete('/api/projects/:id', auth, (req, res) => {
  const file = path.join(PROJECTS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Projet introuvable' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

// ── Helpers image ────────────────────────────────────────────────────────────

async function toB64(buffer, maxDim = 768) {
  const img  = sharp(buffer);
  const meta = await img.metadata();
  const scale = maxDim / Math.max(meta.width, meta.height);
  const out = scale < 1
    ? img.resize(Math.round(meta.width * scale), Math.round(meta.height * scale))
    : img;
  return (await out.png().toBuffer()).toString('base64');
}

async function toThumbnail(b64, maxDim = 200) {
  const buf  = Buffer.from(b64, 'base64');
  const img  = sharp(buf);
  const meta = await img.metadata();
  const scale = maxDim / Math.max(meta.width, meta.height);
  const out = scale < 1
    ? img.resize(Math.round(meta.width * scale), Math.round(meta.height * scale))
    : img;
  return 'data:image/png;base64,' + (await out.png().toBuffer()).toString('base64');
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

function buildPrompt(base, projectPrompt, renderPrompt) {
  let p = base;
  if (projectPrompt && projectPrompt.trim()) p += ', ' + projectPrompt.trim();
  if (renderPrompt  && renderPrompt.trim())  p += ', ' + renderPrompt.trim();
  return p;
}

// ── API : rendu ──────────────────────────────────────────────────────────────

app.post('/api/encrage', auth, upload.single('file'), async (req, res) => {
  try {
    const { projectId, renderPrompt = '' } = req.body;
    const project = projectId ? loadProject(projectId) : null;
    const b64   = await toB64(req.file.buffer);
    const model = await findModel('scribble');
    const prompt = buildPrompt(
      'manga line art, ligne claire style, Herge Tintin, black and white, '
      + 'crisp clean bold outlines, no color, ink drawing, '
      + 'professional Belgian comic book art, flat style',
      project ? project.projectPrompt : '',
      renderPrompt,
    );
    const resultB64 = await img2img({
      init_images: [b64],
      prompt,
      negative_prompt: 'color, blur, rough sketch, pencil marks, shading, '
                     + 'crosshatching, watermark, signature, low quality, noise, grain',
      steps: 20, cfg_scale: 7, denoising_strength: 0.7, sampler_name: 'Euler a',
      alwayson_scripts: { controlnet: { args: [{
        enabled: true, input_image: b64, module: 'scribble_hed', model,
        weight: 0.9, guidance_start: 0.0, guidance_end: 1.0,
      }]}},
    });
    if (project) {
      project.renders.push({
        id: crypto.randomBytes(6).toString('hex'),
        type: 'encrage',
        timestamp: new Date().toISOString(),
        renderPrompt,
        thumbnail: await toThumbnail(resultB64),
      });
      saveProject(project);
    }
    req.session.lastRenderPrompt = renderPrompt;
    res.json({ image: resultB64 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/colorisation', auth, upload.single('file'), async (req, res) => {
  try {
    const { projectId, renderPrompt = '' } = req.body;
    const project = projectId ? loadProject(projectId) : null;
    const b64   = await toB64(req.file.buffer);
    const model = await findModel('lineart');
    const prompt = buildPrompt(
      'Belgian comic book, Tintin Herge style, ligne claire, '
      + 'vibrant flat colors, bright primary colors, '
      + 'clean coloring, no shadows, professional colored illustration',
      project ? project.projectPrompt : '',
      renderPrompt,
    );
    const resultB64 = await img2img({
      init_images: [b64],
      prompt,
      negative_prompt: 'black and white, monochrome, dark, heavy shadows, '
                     + 'photorealistic, blurry, watermark, signature, low quality',
      steps: 20, cfg_scale: 7, denoising_strength: 0.5, sampler_name: 'Euler a',
      alwayson_scripts: { controlnet: { args: [{
        enabled: true, input_image: b64, module: 'lineart_realistic', model,
        weight: 0.8, guidance_start: 0.0, guidance_end: 1.0,
      }]}},
    });
    if (project) {
      project.renders.push({
        id: crypto.randomBytes(6).toString('hex'),
        type: 'colorisation',
        timestamp: new Date().toISOString(),
        renderPrompt,
        thumbnail: await toThumbnail(resultB64),
      });
      saveProject(project);
    }
    req.session.lastRenderPrompt = renderPrompt;
    res.json({ image: resultB64 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`MonooBD :${PORT}`));

// ── HTML inline ───────────────────────────────────────────────────────────────

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

/* Projets */
.project-bar{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:1rem 1.25rem;margin-bottom:1.25rem}
.project-bar h2{font-size:.75rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.625rem}
.project-row{display:flex;gap:.625rem;align-items:center;flex-wrap:wrap}
.project-row select{flex:1;min-width:160px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.5rem .75rem;font-size:.875rem}
.project-row select:focus{outline:none;border-color:#f97316}
btn-sm{padding:.5rem 1rem;border:none;border-radius:8px;font-size:.8rem;cursor:pointer;font-weight:600;transition:opacity .15s}
.btn-new{background:#16a34a;color:#fff;padding:.5rem 1rem;border:none;border-radius:8px;font-size:.8rem;cursor:pointer;font-weight:600}
.btn-new:hover{background:#15803d}
.btn-del{background:#7f1d1d;color:#fca5a5;padding:.5rem 1rem;border:none;border-radius:8px;font-size:.8rem;cursor:pointer;font-weight:600}
.btn-del:hover{background:#991b1b}
.prompt-field{margin-top:.75rem}
.prompt-field label{display:block;font-size:.75rem;color:#94a3b8;margin-bottom:.3rem;font-weight:600}
.prompt-field textarea{width:100%;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:.5rem .75rem;font-size:.85rem;resize:vertical;min-height:60px;font-family:inherit}
.prompt-field textarea:focus{outline:none;border-color:#f97316}
.prompt-field .hint{font-size:.7rem;color:#64748b;margin-top:.2rem}
.prompt-save-row{display:flex;justify-content:flex-end;margin-top:.4rem}
.btn-save{background:#1d4ed8;color:#fff;padding:.375rem .875rem;border:none;border-radius:6px;font-size:.78rem;cursor:pointer;font-weight:600}
.btn-save:hover{background:#2563eb}
.saved-flash{font-size:.75rem;color:#34d399;margin-left:.5rem;opacity:0;transition:opacity .3s}
.saved-flash.show{opacity:1}

/* Upload */
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

/* Historique */
.history{margin-top:1.75rem;display:none}
.history.show{display:block}
.history h3{font-size:.75rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:.75rem}
.history-grid{display:flex;gap:.625rem;flex-wrap:wrap}
.hist-thumb{position:relative;border-radius:8px;overflow:hidden;border:2px solid #334155;cursor:pointer;transition:border-color .2s}
.hist-thumb:hover{border-color:#f97316}
.hist-thumb img{width:100px;height:100px;object-fit:cover;display:block;background:#334155}
.hist-label{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.65);
  font-size:.6rem;color:#e2e8f0;padding:.2rem .3rem;text-align:center;line-height:1.2}

@media(max-width:640px){.preview.show{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div class="logo">Monoo<span>BD</span></div>
  <div class="meta">{{USER}}<a href="/logout">D&eacute;connexion</a></div>
</header>
<div class="container">

  <!-- Projets -->
  <div class="project-bar">
    <h2>Projet</h2>
    <div class="project-row">
      <select id="projSel" onchange="onProjectChange()">
        <option value="">-- Aucun projet --</option>
      </select>
      <button class="btn-new" onclick="openNewProject()">+ Nouveau</button>
      <button class="btn-del" id="btnDelProj" style="display:none" onclick="deleteProject()">Supprimer</button>
    </div>
    <div id="projPromptSection" style="display:none">
      <div class="prompt-field" style="margin-top:.875rem">
        <label>Prompt projet <span style="color:#64748b;font-weight:400">(appliqu&eacute; &agrave; tous les rendus)</span></label>
        <textarea id="projPrompt" rows="2" placeholder="Ex: style steampunk, palette chaude, personnages r&eacute;alistes..."></textarea>
        <div class="hint">Ce prompt s&apos;ajoute automatiquement &agrave; chaque rendu du projet.</div>
      </div>
      <div class="prompt-save-row">
        <button class="btn-save" onclick="saveProjectPrompt()">Enregistrer</button>
        <span class="saved-flash" id="savedFlash">Enregistr&eacute; &#10003;</span>
      </div>
    </div>
  </div>

  <!-- Upload -->
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

  <!-- Prompt rendu -->
  <div class="prompt-field" style="margin-top:.875rem">
    <label>Prompt rendu <span style="color:#64748b;font-weight:400">(optionnel, sp&eacute;cifique &agrave; ce rendu)</span></label>
    <textarea id="renderPrompt" rows="2" placeholder="Ex: personnage debout, fond for&ecirc;t, lumi&egrave;re dram atique..."></textarea>
    <div class="hint">Pr&eacute;-rempli avec le dernier prompt utilis&eacute;. Sera m&eacute;moris&eacute; pour le prochain rendu.</div>
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

  <!-- Historique rendus du projet -->
  <div class="history" id="history">
    <h3>Historique du projet</h3>
    <div class="history-grid" id="histGrid"></div>
  </div>

</div>

<script>
var file = null;
var currentProjectId = null;
var dz   = document.getElementById('dz');
var fi   = document.getElementById('fi');
var bInk = document.getElementById('bInk');
var bCol = document.getElementById('bCol');
var pv   = document.getElementById('pv');
var st   = document.getElementById('st');
var imgOrig  = document.getElementById('imgOrig');
var imgRes   = document.getElementById('imgRes');
var fname    = document.getElementById('fname');
var resTitle = document.getElementById('resTitle');
var projSel  = document.getElementById('projSel');
var projPromptSection = document.getElementById('projPromptSection');
var projPrompt = document.getElementById('projPrompt');
var renderPrompt = document.getElementById('renderPrompt');
var btnDelProj = document.getElementById('btnDelProj');
var savedFlash = document.getElementById('savedFlash');
var histDiv  = document.getElementById('history');
var histGrid = document.getElementById('histGrid');

// Drag & drop
dz.onclick = function(){ fi.click(); };
dz.ondragover = function(e){ e.preventDefault(); dz.classList.add('over'); };
dz.ondragleave = function(){ dz.classList.remove('over'); };
dz.ondrop = function(e){
  e.preventDefault(); dz.classList.remove('over');
  if(e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]);
};
fi.onchange = function(){ if(fi.files[0]) pick(fi.files[0]); };

function pick(f){
  file = f;
  fname.textContent = f.name;
  bInk.disabled = false;
  bCol.disabled = false;
  pv.classList.remove('show');
  setStatus('');
}

function setStatus(msg, cls){
  st.className = 'status ' + (cls || '');
  st.innerHTML = (cls === 'loading' ? '<span class="spin"></span>' : '') + msg;
}

// ── Projets ──────────────────────────────────────────────────────────────────

async function loadProjects(){
  var list = await fetch('/api/projects').then(function(r){ return r.json(); }).catch(function(){ return []; });
  var prev = projSel.value;
  while(projSel.options.length > 1) projSel.remove(1);
  list.forEach(function(p){
    var opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + ' (' + p.renderCount + ' rendu' + (p.renderCount !== 1 ? 's' : '') + ')';
    projSel.appendChild(opt);
  });
  if(prev) projSel.value = prev;
  return list;
}

async function onProjectChange(){
  currentProjectId = projSel.value || null;
  btnDelProj.style.display = currentProjectId ? '' : 'none';
  if(!currentProjectId){
    projPromptSection.style.display = 'none';
    histDiv.classList.remove('show');
    return;
  }
  projPromptSection.style.display = '';
  var proj = await fetch('/api/projects/' + currentProjectId).then(function(r){ return r.json(); }).catch(function(){ return null; });
  if(!proj) return;
  projPrompt.value = proj.projectPrompt || '';
  renderHistory(proj.renders || []);
}

function renderHistory(renders){
  histGrid.innerHTML = '';
  if(!renders.length){ histDiv.classList.remove('show'); return; }
  histDiv.classList.add('show');
  renders.slice().reverse().forEach(function(r){
    var div = document.createElement('div');
    div.className = 'hist-thumb';
    div.title = r.renderPrompt || r.type;
    var img = document.createElement('img');
    img.src = r.thumbnail;
    img.alt = r.type;
    var lbl = document.createElement('div');
    lbl.className = 'hist-label';
    lbl.textContent = r.type + (r.renderPrompt ? ' — ' + r.renderPrompt.slice(0, 20) : '');
    div.appendChild(img);
    div.appendChild(lbl);
    div.onclick = function(){ renderPrompt.value = r.renderPrompt || ''; };
    histGrid.appendChild(div);
  });
}

async function saveProjectPrompt(){
  if(!currentProjectId) return;
  await fetch('/api/projects/' + currentProjectId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPrompt: projPrompt.value }),
  });
  savedFlash.classList.add('show');
  setTimeout(function(){ savedFlash.classList.remove('show'); }, 2000);
}

async function openNewProject(){
  var name = window.prompt('Nom du projet :', 'Mon projet BD');
  if(!name || !name.trim()) return;
  var proj = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), projectPrompt: '' }),
  }).then(function(r){ return r.json(); });
  await loadProjects();
  projSel.value = proj.id;
  await onProjectChange();
}

async function deleteProject(){
  if(!currentProjectId) return;
  var name = projSel.options[projSel.selectedIndex].text;
  if(!window.confirm('Supprimer « ' + name + ' » et tous ses rendus ?')) return;
  await fetch('/api/projects/' + currentProjectId, { method: 'DELETE' });
  currentProjectId = null;
  projSel.value = '';
  await loadProjects();
  await onProjectChange();
}

// ── Rendu ─────────────────────────────────────────────────────────────────────

async function run(action){
  if(!file) return;
  var r = new FileReader();
  r.onload = function(e){ imgOrig.src = e.target.result; };
  r.readAsDataURL(file);
  resTitle.textContent = action === 'encrage' ? 'Encrage ligne claire' : 'Colorisation';
  bInk.disabled = true; bCol.disabled = true;
  pv.classList.remove('show');
  setStatus('G&eacute;n&eacute;ration en cours&hellip; peut prendre 10&ndash;30&nbsp;min sur CPU', 'loading');
  try {
    var fd = new FormData();
    fd.append('file', file);
    fd.append('renderPrompt', renderPrompt.value);
    if(currentProjectId) fd.append('projectId', currentProjectId);
    var resp = await fetch('/api/' + action, { method: 'POST', body: fd });
    var data = await resp.json();
    if(data.error) throw new Error(data.error);
    imgRes.src = 'data:image/png;base64,' + data.image;
    pv.classList.add('show');
    setStatus('Termin&eacute; &#10003;', 'ok');
    // Rafraîchir historique si projet actif
    if(currentProjectId){
      var proj = await fetch('/api/projects/' + currentProjectId).then(function(r){ return r.json(); }).catch(function(){ return null; });
      if(proj) renderHistory(proj.renders || []);
      // Mettre à jour le compteur dans le select
      await loadProjects();
      projSel.value = currentProjectId;
    }
  } catch(e) {
    setStatus('Erreur&nbsp;: ' + e.message, 'err');
  } finally {
    bInk.disabled = false; bCol.disabled = false;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async function init(){
  // Charger projets
  await loadProjects();

  // Pré-remplir prompt rendu depuis la session
  var info = await fetch('/api/session-info').then(function(r){ return r.json(); }).catch(function(){ return {}; });
  if(info.lastRenderPrompt) renderPrompt.value = info.lastRenderPrompt;

  // Statut A1111
  (async function pollReady(){
    var data = await fetch('/api/status').then(function(r){ return r.json(); }).catch(function(){ return { ready: false }; });
    if(!data.ready){
      setStatus('A1111 en cours de d&eacute;marrage&hellip;');
      setTimeout(pollReady, 10000);
    } else {
      setStatus('');
    }
  })();
})();
</script>
</body>
</html>`;
