import base64
import io
import os

import httpx
from authlib.integrations.starlette_client import OAuth
from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from PIL import Image
from starlette.middleware.sessions import SessionMiddleware

app = FastAPI(title="BD Assistant")
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ["SESSION_SECRET"],
    max_age=86400 * 7,
    same_site="lax",
)

oauth = OAuth()
oauth.register(
    name="google",
    client_id=os.environ["OAUTH_CLIENT_ID"],
    client_secret=os.environ["OAUTH_CLIENT_SECRET"],
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)

A1111_URL = os.environ.get("A1111_URL", "http://a1111:7860")
ALLOWED_EMAIL = os.environ.get("ALLOWED_EMAIL", "")
DOMAIN = os.environ.get("DOMAIN", "localhost")

MAX_DIM = 768   # pixels max après redimensionnement
TIMEOUT = 3600  # 60 min — suffisant pour CPU


def resize_to_b64(image_bytes: bytes) -> str:
    """Redimensionne à MAX_DIM px max, retourne base64 PNG."""
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    if max(w, h) > MAX_DIM:
        ratio = MAX_DIM / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


async def find_cn_model(pattern: str) -> str:
    """Retourne le premier modèle ControlNet dont le nom contient pattern."""
    try:
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get(f"{A1111_URL}/controlnet/model_list")
            for m in r.json().get("model_list", []):
                if pattern in m:
                    return m
    except Exception:
        pass
    return pattern  # fallback : A1111 fera le matching


async def call_img2img(payload: dict) -> str:
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.post(f"{A1111_URL}/sdapi/v1/img2img", json=payload)
        r.raise_for_status()
        return r.json()["images"][0]


# ── Auth ──────────────────────────────────────────────────────────────────────

@app.get("/login")
async def login(request: Request):
    redirect_uri = f"https://bd.{DOMAIN}/auth"
    return await oauth.google.authorize_redirect(request, redirect_uri)


@app.get("/auth")
async def auth(request: Request):
    token = await oauth.google.authorize_access_token(request)
    user = token.get("userinfo") or {}
    email = user.get("email", "")
    if ALLOWED_EMAIL and email != ALLOWED_EMAIL:
        return HTMLResponse("<h1>Accès refusé</h1>", status_code=403)
    request.session["user"] = {"email": email, "name": user.get("name", email)}
    return RedirectResponse("/")


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/")


# ── Pages ────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    if not request.session.get("user"):
        return RedirectResponse("/login")
    return HTMLResponse(HTML_PAGE.replace("{{USER}}", request.session["user"]["name"]))


# ── API ───────────────────────────────────────────────────────────────────────

@app.get("/api/status")
async def status():
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{A1111_URL}/sdapi/v1/memory")
            return {"ready": r.status_code == 200}
    except Exception:
        return {"ready": False}


@app.post("/api/encrage")
async def encrage(request: Request, file: UploadFile = File(...)):
    if not request.session.get("user"):
        return JSONResponse({"error": "Non authentifié"}, status_code=401)

    image_b64 = resize_to_b64(await file.read())
    cn_model = await find_cn_model("scribble")

    payload = {
        "init_images": [image_b64],
        "prompt": (
            "manga line art, ligne claire style, Herge Tintin, "
            "black and white, crisp clean bold outlines, no color, "
            "ink drawing, professional Belgian comic book art, flat style"
        ),
        "negative_prompt": (
            "color, blur, rough sketch, pencil marks, shading, "
            "crosshatching, watermark, signature, low quality, noise, grain"
        ),
        "steps": 20,
        "cfg_scale": 7,
        "denoising_strength": 0.7,
        "sampler_name": "Euler a",
        "alwayson_scripts": {
            "controlnet": {
                "args": [{
                    "enabled": True,
                    "input_image": image_b64,
                    "module": "scribble_hed",
                    "model": cn_model,
                    "weight": 0.9,
                    "guidance_start": 0.0,
                    "guidance_end": 1.0,
                }]
            }
        },
    }
    try:
        return JSONResponse({"image": await call_img2img(payload)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/api/colorisation")
async def colorisation(request: Request, file: UploadFile = File(...)):
    if not request.session.get("user"):
        return JSONResponse({"error": "Non authentifié"}, status_code=401)

    image_b64 = resize_to_b64(await file.read())
    cn_model = await find_cn_model("lineart")

    payload = {
        "init_images": [image_b64],
        "prompt": (
            "Belgian comic book, Tintin Herge style, ligne claire, "
            "vibrant flat colors, bright primary colors, "
            "clean coloring, no shadows, professional colored illustration"
        ),
        "negative_prompt": (
            "black and white, monochrome, dark, heavy shadows, "
            "photorealistic, blurry, watermark, signature, low quality"
        ),
        "steps": 20,
        "cfg_scale": 7,
        "denoising_strength": 0.5,
        "sampler_name": "Euler a",
        "alwayson_scripts": {
            "controlnet": {
                "args": [{
                    "enabled": True,
                    "input_image": image_b64,
                    "module": "lineart_realistic",
                    "model": cn_model,
                    "weight": 0.8,
                    "guidance_start": 0.0,
                    "guidance_end": 1.0,
                }]
            }
        },
    }
    try:
        return JSONResponse({"image": await call_img2img(payload)})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ── HTML (inline) ─────────────────────────────────────────────────────────────

HTML_PAGE = """\
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BD Assistant — Ligne Claire</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#111827;color:#e5e7eb;min-height:100vh}
header{background:#1f2937;padding:.875rem 1.5rem;display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #374151}
h1{color:#f9fafb;font-size:1.2rem;font-weight:700}
.meta{font-size:.8rem;color:#9ca3af}
.meta a{color:#818cf8;text-decoration:none;margin-left:.75rem}
.container{max-width:1100px;margin:2rem auto;padding:0 1.25rem}
.drop-zone{border:2px dashed #374151;border-radius:12px;padding:2.5rem 2rem;
  text-align:center;cursor:pointer;transition:border-color .2s,background .2s;background:#1f2937}
.drop-zone:hover,.drop-zone.over{border-color:#818cf8;background:#1e1f3a}
.drop-zone p{color:#6b7280;font-size:.85rem;margin-top:.375rem}
svg.icon{color:#818cf8}
input[type=file]{display:none}
.fname{font-size:.875rem;color:#a5b4fc;margin-top:.5rem;font-weight:500}
.actions{display:flex;gap:.75rem;margin-top:1.25rem;justify-content:center;flex-wrap:wrap}
btn,button{padding:.625rem 1.75rem;border:none;border-radius:8px;font-size:.9rem;
  cursor:pointer;font-weight:600;transition:opacity .15s,transform .1s}
button:active{transform:scale(.97)}
button:disabled{opacity:.4;cursor:not-allowed}
.btn-ink{background:#1d4ed8;color:#fff}
.btn-ink:hover:not(:disabled){background:#2563eb}
.btn-col{background:#7c3aed;color:#fff}
.btn-col:hover:not(:disabled){background:#8b5cf6}
.status{text-align:center;margin-top:1rem;font-size:.875rem;min-height:1.25rem;color:#9ca3af}
.status.loading{color:#fbbf24}
.status.ok{color:#34d399}
.status.err{color:#f87171}
.spin{display:inline-block;width:10px;height:10px;border:2px solid currentColor;
  border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;
  margin-right:5px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}
.preview{display:none;margin-top:1.75rem;gap:1.25rem}
.preview.show{display:grid;grid-template-columns:1fr 1fr}
.panel{background:#1f2937;border-radius:12px;overflow:hidden;border:1px solid #374151}
.panel-title{padding:.5rem 1rem;font-size:.75rem;font-weight:600;color:#9ca3af;
  background:#111827;text-transform:uppercase;letter-spacing:.5px}
.panel img{width:100%;display:block;min-height:200px;background:#374151}
@media(max-width:640px){.preview.show{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <h1>&#127912; BD Assistant &mdash; Ligne Claire</h1>
  <div class="meta">{{USER}}<a href="/logout">Déconnexion</a></div>
</header>
<div class="container">
  <div class="drop-zone" id="dz">
    <input type="file" id="fi" accept="image/png,image/jpeg,image/webp">
    <svg class="icon" width="40" height="40" fill="none" stroke="currentColor"
         stroke-width="1.5" viewBox="0 0 24 24">
      <path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1M16 10l-4-4m0 0L8 10m4-4v12"/>
    </svg>
    <p>Glisse ton croquis ici ou <strong>clique pour parcourir</strong></p>
    <p>PNG &bull; JPG &bull; WebP &mdash; redimensionné à 768&thinsp;px max côté serveur</p>
    <div class="fname" id="fname"></div>
  </div>

  <div class="actions">
    <button class="btn-ink" id="bInk" disabled onclick="run('encrage')">&#9998;&nbsp;Encrer (B&amp;W ligne claire)</button>
    <button class="btn-col" id="bCol" disabled onclick="run('colorisation')">&#127912;&nbsp;Coloriser</button>
  </div>
  <div class="status" id="st"></div>

  <div class="preview" id="pv">
    <div class="panel">
      <div class="panel-title">Original</div>
      <img id="imgOrig" alt="Original">
    </div>
    <div class="panel">
      <div class="panel-title" id="resTitle">Résultat</div>
      <img id="imgRes" alt="Résultat">
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
dz.ondrop=function(e){e.preventDefault();dz.classList.remove('over');if(e.dataTransfer.files[0])pick(e.dataTransfer.files[0])};
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
  cls=cls||'';
  st.className='status '+cls;
  st.innerHTML=(cls==='loading'?'<span class="spin"></span>':'')+msg;
}

async function run(action){
  if(!file)return;
  var r=new FileReader();
  r.onload=function(e){imgOrig.src=e.target.result};
  r.readAsDataURL(file);
  resTitle.textContent=action==='encrage'?'Encrage ligne claire':'Colorisation';
  bInk.disabled=true;
  bCol.disabled=true;
  pv.classList.remove('show');
  setStatus('Génération en cours… peut prendre 10–30 min sur CPU','loading');
  try{
    var fd=new FormData();
    fd.append('file',file);
    var resp=await fetch('/api/'+action,{method:'POST',body:fd});
    var data=await resp.json();
    if(data.error)throw new Error(data.error);
    imgRes.src='data:image/png;base64,'+data.image;
    pv.classList.add('show');
    setStatus('Terminé ✓','ok');
  }catch(e){
    setStatus('Erreur : '+e.message,'err');
  }finally{
    bInk.disabled=false;
    bCol.disabled=false;
  }
}

// Sonde le statut d'A1111 au chargement de la page
(async function pollReady(){
  var data=await fetch('/api/status').then(function(r){return r.json()}).catch(function(){return{ready:false}});
  if(!data.ready){
    setStatus('A1111 en cours de démarrage…');
    setTimeout(pollReady,10000);
  }else{
    setStatus('');
  }
})();
</script>
</body>
</html>
"""
