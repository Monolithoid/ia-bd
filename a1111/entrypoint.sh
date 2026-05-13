#!/usr/bin/env bash
# Entrypoint A1111 — télécharge les modèles manquants puis lance le serveur
set -euo pipefail

MODELS_DIR=/app/stable-diffusion-webui/models
SD_DIR="${MODELS_DIR}/Stable-diffusion"
CN_DIR="${MODELS_DIR}/ControlNet"

download_if_missing() {
    local dest="$1" url="$2" label="$3" size="${4:-}"
    if [ -f "$dest" ]; then
        echo "[setup] Déjà présent : ${label}"
        return
    fi
    mkdir -p "$(dirname "$dest")"
    echo "[setup] Téléchargement : ${label}${size:+ (~${size} Mo)}…"
    wget -q --show-progress -O "${dest}.tmp" "$url"
    mv "${dest}.tmp" "$dest"
    echo "[setup] OK : ${label}"
}

echo "[setup] Vérification des modèles…"

# Modèle Stable Diffusion 1.5 (base)
download_if_missing \
    "${SD_DIR}/v1-5-pruned-emaonly.safetensors" \
    "https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors" \
    "SD 1.5 (base model)" "3976"

# ControlNet Scribble — encrage à partir d'un croquis
download_if_missing \
    "${CN_DIR}/control_v11p_sd15_scribble.pth" \
    "https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_scribble.pth" \
    "ControlNet Scribble" "1445"

# ControlNet Lineart — guidage pour la colorisation
download_if_missing \
    "${CN_DIR}/control_v11p_sd15_lineart.pth" \
    "https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_lineart.pth" \
    "ControlNet Lineart" "1445"

echo "[setup] Modèles OK. Démarrage d'AUTOMATIC1111 (mode CPU)…"

exec python launch.py \
    --api \
    --listen \
    --port 7860 \
    --skip-torch-cuda-test \
    --use-cpu all \
    --no-half \
    --precision full \
    --no-half-vae \
    --opt-split-attention \
    ${SD_EXTRA_ARGS:-}
