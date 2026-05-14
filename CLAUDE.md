# Conventions pour Claude Code

## Branches

- Ne jamais pousser directement sur `main`.
- Tout développement se fait sur une branche feature/fix dédiée.
- Ouvrir une pull request vers `main` une fois les changements prêts.

## Stack

- **inference/** : microserveur FastAPI + HuggingFace Diffusers (SD 1.5 + ControlNet)
- **webapp/** : interface web Node.js + Google SSO
- **docker-compose.yml** : stack complète (inference + webapp)
- **CI** : `.github/workflows/build.yml` — build & push sur Docker Hub à chaque merge sur `main`

## Déploiement

- Images Docker publiées sur Docker Hub : `monolithoid/bd-inference`, `monolithoid/bd-webapp`
- Déployé via Coolify sur VPS (pull depuis Docker Hub)
- Modèles HuggingFace cachés dans `/opt/ia/bd/models/hf-cache`
