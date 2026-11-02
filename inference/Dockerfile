# syntax=docker/dockerfile:1
FROM python:3.10-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# NumPy 1.x requis : torch 2.1.2 et diffusers 0.27.2 sont incompatibles avec NumPy 2.x
# Les dépendances pures-Python de torch/torchvision sont installées ici depuis PyPI :
# l'index PyTorch ne les sert pas toujours en wheel (ex. typing_extensions 4.16 en sdist
# seulement, dont le build exige flit_core, absent de cet index → échec du build).
RUN pip install --no-cache-dir "numpy<2" \
        typing-extensions filelock sympy networkx jinja2 fsspec requests "pillow==10.2.0"

# PyTorch CPU (couche indépendante — mise en cache si version inchangée)
RUN pip install --no-cache-dir \
        torch==2.1.2 torchvision==0.16.2 \
        --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /app
COPY server.py .

EXPOSE 8000
CMD ["python", "server.py"]
