FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git wget curl \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Installe CPU PyTorch en premier (couche indépendante du code A1111)
# Prend ~5 min au build, puis mise en cache — ne se réexécute pas sauf changement de version
RUN pip install --no-cache-dir \
        torch==2.1.2 torchvision==0.16.2 \
        --index-url https://download.pytorch.org/whl/cpu

# Indique à A1111 quelle commande utiliser si torch doit être réinstallé
ENV TORCH_COMMAND="pip install torch==2.1.2 torchvision==0.16.2 --index-url https://download.pytorch.org/whl/cpu"

# Clone AUTOMATIC1111
RUN git clone --depth 1 \
        https://github.com/AUTOMATIC1111/stable-diffusion-webui \
        /app/stable-diffusion-webui

WORKDIR /app/stable-diffusion-webui

# Extension ControlNet
RUN git clone --depth 1 \
        https://github.com/Mikubill/sd-webui-controlnet \
        extensions/sd-webui-controlnet

# Pré-clone des sous-dépôts requis par A1111 au commit exact qu'il attend.
# Sans cela, launch.py les clone au démarrage — ce qui échoue dans un
# environnement sans accès réseau sortant ("No such device or address").
# Le script lit les URLs et hashes directement depuis launch_utils.py pour
# rester synchronisé avec la version d'A1111 clonée ci-dessus.
RUN python3 - <<'PYEOF'
import subprocess, re, os, sys

with open('modules/launch_utils.py') as f:
    src = f.read()

repo_urls = dict(re.findall(r"(\w+)_repo\s*=\s*os\.environ\.get\([^,]+,\s*['\"]([^'\"]+)['\"]\)", src))
commits   = dict(re.findall(r"(\w+)_commit_hash\s*=\s*os\.environ\.get\([^,]+,\s*['\"]([^'\"]+)['\"]\)", src))

dirs = {
    'stable_diffusion':    'stable-diffusion-stability-ai',
    'taming_transformers': 'taming-transformers',
    'k_diffusion':         'k-diffusion',
    'codeformer':          'CodeFormer',
    'blip':                'BLIP',
    'clip':                'CLIP',
    'openclip':            'open_clip',
}

os.makedirs('repositories', exist_ok=True)
errors = []

for key, dirname in dirs.items():
    url    = repo_urls.get(key)
    commit = commits.get(key)
    dest   = f'repositories/{dirname}'

    if not url:
        print(f'[skip] no URL for {key}', flush=True)
        continue
    if os.path.exists(dest):
        print(f'[skip] already exists: {dest}', flush=True)
        continue

    print(f'[clone] {url} -> {dest}', flush=True)
    r = subprocess.run(['git', 'clone', url, dest])
    if r.returncode != 0:
        errors.append(dirname)
        continue
    if commit:
        subprocess.run(['git', '-C', dest, 'checkout', commit], check=True)
    print(f'[ok] {dirname}', flush=True)

if errors:
    print(f'[error] failed: {errors}', file=sys.stderr)
    sys.exit(1)

print('All repositories pre-cloned successfully.')
PYEOF

# Pré-installation des dépendances Python d'A1111 pour éviter les pip install au runtime
RUN pip install --no-cache-dir -r requirements_versions.txt

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860
ENTRYPOINT ["/entrypoint.sh"]
