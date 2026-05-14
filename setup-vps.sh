#!/usr/bin/env bash
# setup-vps.sh — Préparation du VPS pour MonooBD
#
# Ce script couvre ce que Coolify ne gère pas :
#   - Arborescence des volumes host (/opt/ia/bd/)
#   - Règles firewall UFW
#
# Usage : sudo bash setup-vps.sh
# Prérequis : Ubuntu 22.04+ avec accès root, Coolify déjà installé

set -euo pipefail

DATA_DIR="/opt/ia/bd"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()    { echo -e "${GREEN}[✓]${NC} $*"; }
info()   { echo -e "${CYAN}[→]${NC} $*"; }
warn()   { echo -e "${YELLOW}[!]${NC} $*"; }
error()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }
section(){ echo -e "\n${CYAN}══ $* ══${NC}"; }

require_root() {
    [[ $EUID -eq 0 ]] || error "Ce script doit être exécuté en root : sudo bash $0"
}

create_directories() {
    section "Arborescence /opt/ia/bd"

    # Volumes A1111 — contenu lourd, persisté entre redémarrages
    local dirs=(
        "${DATA_DIR}/models/Stable-diffusion"  # modèle SD 1.5 (~4 Go)
        "${DATA_DIR}/models/ControlNet"         # modèles ControlNet (~3 Go)
        "${DATA_DIR}/models/VAE"
        "${DATA_DIR}/outputs"                   # images générées
        "${DATA_DIR}/cn-cache"                  # preprocesseurs HED / Lineart
        # Volume webapp — sessions utilisateur (pas de re-login après redémarrage)
        "${DATA_DIR}/sessions"
    )

    for d in "${dirs[@]}"; do
        mkdir -p "$d"
        log "Créé : $d"
    done

    chmod -R 755 "${DATA_DIR}"
    log "Permissions configurées."

    # Le conteneur webapp tourne en USER node (UID 1000).
    # Le dossier sessions doit lui appartenir pour que file-store puisse écrire.
    chown -R 1000:1000 "${DATA_DIR}/sessions"
    log "Propriétaire de sessions → 1000:1000 (node)."
}

configure_firewall() {
    section "Firewall UFW"
    if ! command -v ufw &>/dev/null; then
        apt-get install -y -q ufw
    fi

    ufw allow 22   comment "SSH"
    ufw allow 80   comment "HTTP (Traefik)"
    ufw allow 443  comment "HTTPS (Traefik)"
    ufw deny  7860 comment "A1111 API (interne Docker uniquement)"

    ufw --force enable
    log "UFW activé."
    ufw status verbose
}

main() {
    require_root

    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   MonooBD — Préparation VPS               ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
    echo ""

    create_directories
    configure_firewall

    echo ""
    echo -e "${GREEN}Préparation VPS terminée.${NC}"
    echo ""
    echo -e "${CYAN}Prochaines étapes :${NC}"
    echo "  1. Dans Coolify : New Resource → Docker Compose → ce dépôt"
    echo "  2. Configurer les variables d'environnement (voir README § Variables)"
    echo "  3. Cliquer Deploy"
    echo ""
    echo -e "${YELLOW}Note :${NC} Premier démarrage d'A1111 = téléchargement de ~5 Go de modèles."
    echo "  Suivre l'avancement : docker logs -f bd-a1111"
    echo ""
}

main "$@"
