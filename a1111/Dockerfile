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

# Pré-clone des dépôts requis par A1111 et pré-installation des dépendances Python
# au moment du build. Sans cela, launch.py clone ces dépôts au démarrage du
# conteneur, ce qui échoue si le réseau n'est pas accessible (erreur
# "No such device or address"). timeout garantit que le build ne reste pas
# bloqué si le serveur démarre avant la fin du délai.
RUN timeout 300 python launch.py \
        --skip-torch-cuda-test \
        --use-cpu all \
        --no-half \
        --precision full \
        --no-half-vae; \
    exit 0

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 7860
ENTRYPOINT ["/entrypoint.sh"]
