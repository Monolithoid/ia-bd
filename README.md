# BD Assistant — Ligne Claire

Outil personnel pour finir des planches de bande dessinée belge.
Workflow : croquis papier → scan → upload → IA finit le travail → prévisualisation côte à côte.

**Deux actions :**
- **Encrage** — nettoie le trait en noir et blanc, style ligne claire (Hergé/Tintin)
- **Colorisation** — applique des couleurs à un encrage existant

**Stack :** AUTOMATIC1111 img2img + ControlNet · FastAPI · Google SSO · Coolify/Traefik · CPU uniquement

---

## Architecture

```
browser → Traefik → bd-webapp (FastAPI) → bd-a1111 (A1111 API)
                                                ↓
                                    /opt/ia/bd/models/   (SD 1.5 + ControlNet)
                                    /opt/ia/bd/outputs/  (historique)
                                    /opt/ia/bd/cn-cache/ (preprocesseurs)
```

| Service | Image | Port interne |
|---|---|---|
| `bd-a1111` | `monolithoid/bd-a1111` | `127.0.0.1:7860` |
| `bd-webapp` | `monolithoid/bd-webapp` | `127.0.0.1:8080` → `bd.DOMAIN` |

---

## Déploiement pas à pas

### 1. Google OAuth

1. Aller sur [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials
2. **Create Credentials** → OAuth 2.0 Client ID → Web application
3. Authorized redirect URIs : `https://bd.TON-DOMAINE.com/auth`
4. Copier **Client ID** et **Client Secret**

### 2. Docker Hub

Les images sont buildées et poussées automatiquement par GitHub Actions.  
Secrets à configurer dans **Settings → Secrets → Actions** du repo :

| Secret | Valeur |
|---|---|
| `DOCKERHUB_USERNAME` | `monolithoid` |
| `DOCKERHUB_TOKEN` | Docker Hub → Account Settings → Security → New Access Token |

Le premier push sur `main` déclenche le build (≈ 30-60 min pour `bd-a1111` à cause de PyTorch CPU).

### 3. Préparation du VPS

```bash
ssh root@TON-VPS
wget -O setup-vps.sh https://raw.githubusercontent.com/monolithoid/ia-bd/main/setup-vps.sh
bash setup-vps.sh
```

Ce script crée `/opt/ia/bd/{models,outputs,cn-cache}` et configure UFW.

### 4. Déploiement Coolify

1. **New Resource** → Docker Compose Raw → coller le contenu de `docker-compose.yml`  
   *(ou pointer vers ce dépôt GitHub)*
2. Configurer les **Environment Variables** :

| Variable | Exemple | Description |
|---|---|---|
| `DOMAIN` | `mon-domaine.com` | Domaine principal |
| `DOCKERHUB_USERNAME` | `monolithoid` | Username Docker Hub |
| `OAUTH_CLIENT_ID` | `123...apps.googleusercontent.com` | Google OAuth |
| `OAUTH_CLIENT_SECRET` | `GOCSPX-...` | Google OAuth |
| `SESSION_SECRET` | *(openssl rand -hex 32)* | Clé de chiffrement des sessions |
| `ALLOWED_EMAIL` | `toi@gmail.com` | Seule adresse Gmail autorisée |
| `SD_EXTRA_ARGS` | *(vide)* | Args supplémentaires pour A1111 |

3. Cliquer **Deploy**

### 5. Premier démarrage

A1111 télécharge ~5 Go de modèles au premier démarrage (SD 1.5 + deux modèles ControlNet) :

```bash
docker logs -f bd-a1111
```

Attendre les messages `[setup] OK : ...` puis `Startup time: ...` avant d'utiliser l'interface.

---

## Utilisation

1. Ouvrir `https://bd.TON-DOMAINE.com`
2. Se connecter via Google
3. Glisser/déposer le scan du croquis
4. Cliquer **Encrer** ou **Coloriser**
5. Patienter 10-30 min (CPU sans GPU)
6. Comparer original et résultat côte à côte

---

## Paramètres de génération

| Action | ControlNet | Denoising | Prompt principal |
|---|---|---|---|
| Encrage | Scribble HED | 0.70 | ligne claire, Hergé, B&W, crisp lines |
| Colorisation | Lineart Realistic | 0.50 | Tintin style, flat colors, vibrant |

Les images sont redimensionnées à **768 px max** côté serveur avant envoi à A1111.

---

## Performances (CPU, 22 Go RAM)

| Image | Étapes | Temps estimé |
|---|---|---|
| 512 × 512 | 20 | ~10-15 min |
| 768 × 768 | 20 | ~25-40 min |

Les générations lentes sont normales et acceptées par design.

---

## Mise à jour

```bash
# Déclencher un nouveau build
git commit --allow-empty -m "chore: rebuild" && git push

# Redéployer depuis Coolify : bouton Redeploy
```

---

## Dépannage

**A1111 ne démarre pas / erreur CUDA**  
→ Vérifier que `--use-cpu all --no-half --skip-torch-cuda-test` sont bien dans les args  
→ `docker logs bd-a1111`

**ControlNet model not found**  
→ Vérifier que `/opt/ia/bd/models/ControlNet/control_v11p_sd15_scribble.pth` existe  
→ Si absent : `docker restart bd-a1111` (relance le téléchargement)

**Erreur OAuth redirect_uri_mismatch**  
→ L'URI `https://bd.DOMAIN/auth` doit correspondre exactement à ce qui est configuré dans Google Cloud Console

**Session perdue après redéploiement**  
→ Normal — `SESSION_SECRET` fixe résout le problème (ne pas régénérer la clé entre déploiements)
