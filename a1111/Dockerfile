# syntax=docker/dockerfile:1
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        git wget curl \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Fail fast instead of hanging on credential prompts
ENV GIT_TERMINAL_PROMPT=0

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
# Le GITHUB_TOKEN est injecté via un secret BuildKit (jamais persisté dans
# l'image) pour s'authentifier sur github.com et contourner les repos
# privés ou les rate-limits des runners GitHub Actions.
COPY pre_clone_repos.py /tmp/pre_clone_repos.py
RUN --mount=type=secret,id=github_token \
    TOKEN=$(cat /run/secrets/github_token 2>/dev/null || echo "") && \
    [ -n "$TOKEN" ] && git config --global \
        url."https://x-access-token:${TOKEN}@github.com/".insteadOf \
        "https://github.com/" || true && \
    python3 /tmp/pre_clone_repos.py

# Pré-installation des dépendances Python d'A1111
RUN pip install --no-cache-dir -r requirements_versions.txt

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860
ENTRYPOINT ["/entrypoint.sh"]
