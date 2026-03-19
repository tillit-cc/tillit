#!/bin/bash
#
# TilliT Instance Reset
#
# Resets a TilliT server to a clean state: clears the database,
# regenerates RSA keys, and optionally reconfigures cloud services.
#
# Usage:
#   ./reset-instance.sh [options]
#
# Options:
#   --cloud-id <id>         Set Cloud ID for DDNS
#   --cloud-token <token>   Set Cloud Token for DDNS
#   --expo-token <token>    Set Expo push notification token
#   --no-confirm            Skip confirmation prompt
#   -h, --help              Show this help message
#
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
INSTALL_DIR="/opt/tillit"
DATA_DIR="/opt/tillit/data"
KEYS_DIR="/opt/tillit/keys"
TILLIT_USER="tillit"

# Options
CLOUD_ID=""
CLOUD_TOKEN=""
EXPO_TOKEN=""
NO_CONFIRM=false

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# --- OS detection ---

detect_os() {
    case "$(uname -s)" in
        Darwin) IS_MACOS=true; IS_LINUX=false ;;
        *)      IS_MACOS=false; IS_LINUX=true ;;
    esac
}

sed_inplace() {
    if [ "$IS_MACOS" = true ]; then sed -i '' "$@"; else sed -i "$@"; fi
}

# --- Argument parsing ---

print_usage() {
    echo "Usage: $0 [options]"
    echo ""
    echo "Resets a TilliT server to a clean state."
    echo ""
    echo "This will:"
    echo "  - Stop the TilliT service"
    echo "  - Delete the SQLite database (all users, rooms, messages)"
    echo "  - Regenerate RSA keys (invalidates all existing JWT tokens)"
    echo "  - Restart the service"
    echo ""
    echo "Options:"
    echo "  --cloud-id <id>         Set Cloud ID for DDNS (enables DDNS)"
    echo "  --cloud-token <token>   Set Cloud Token for DDNS authentication"
    echo "  --expo-token <token>    Set Expo push notification access token"
    echo "  --no-confirm            Skip confirmation prompt"
    echo "  -h, --help              Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                                          # Reset with confirmation"
    echo "  $0 --no-confirm                             # Reset without confirmation"
    echo "  $0 --cloud-id my-server --cloud-token xxx   # Reset and configure DDNS"
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --cloud-id)
            CLOUD_ID="$2"
            shift 2
            ;;
        --cloud-token)
            CLOUD_TOKEN="$2"
            shift 2
            ;;
        --expo-token)
            EXPO_TOKEN="$2"
            shift 2
            ;;
        --no-confirm)
            NO_CONFIRM=true
            shift
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            print_usage
            exit 1
            ;;
    esac
done

# --- Main ---

main() {
    echo -e "${BLUE}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║              TilliT Instance Reset                       ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"

    detect_os

    # Auto-detect install directory
    if [ "$IS_MACOS" = true ] && [ ! -d "$INSTALL_DIR" ] && [ -d "$HOME/tillit" ]; then
        INSTALL_DIR="$HOME/tillit"
        DATA_DIR="$INSTALL_DIR/data"
        KEYS_DIR="$INSTALL_DIR/keys"
        log_info "Using macOS install directory: $INSTALL_DIR"
    fi

    # Check root on Linux
    if [ "$IS_LINUX" = true ] && [ "$(id -u)" -ne 0 ]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi

    # Check if TilliT is installed
    if [ ! -f "$INSTALL_DIR/.env" ]; then
        log_error "TilliT not installed at $INSTALL_DIR"
        echo "  Run install.sh or install-bare.sh first."
        exit 1
    fi

    # Confirmation
    if [ "$NO_CONFIRM" != true ]; then
        echo -e "  ${YELLOW}WARNING: This will permanently delete:${NC}"
        echo "    - All users and their keys"
        echo "    - All rooms and messages"
        echo "    - All pending messages"
        echo "    - RSA keypair (all active sessions will be invalidated)"
        echo ""

        if [ -n "$CLOUD_ID" ]; then
            echo -e "  ${BLUE}Cloud services will be configured:${NC}"
            echo "    - Cloud ID: $CLOUD_ID"
            echo "    - DDNS: enabled"
            echo ""
        fi

        read -p "  Are you sure? Type 'yes' to confirm: " answer
        if [ "$answer" != "yes" ]; then
            echo ""
            log_info "Reset cancelled."
            exit 0
        fi
        echo ""
    fi

    # 1. Stop service
    log_info "Stopping TilliT service..."
    if [ "$IS_MACOS" = true ]; then
        launchctl stop cc.tillit.docker 2>/dev/null || true
        launchctl stop cc.tillit.server 2>/dev/null || true
    elif systemctl is-active --quiet tillit.service 2>/dev/null; then
        systemctl stop tillit.service
    fi
    log_success "Service stopped"

    # 2. Configure cloud services (if provided)
    if [ -n "$CLOUD_ID" ] && [ -n "$CLOUD_TOKEN" ]; then
        log_info "Configuring cloud services..."
        sed_inplace "s/DDNS_ENABLED=.*/DDNS_ENABLED=true/" "$INSTALL_DIR/.env"
        sed_inplace "s/CLOUD_ID=.*/CLOUD_ID=$CLOUD_ID/" "$INSTALL_DIR/.env"
        sed_inplace "s/CLOUD_TOKEN=.*/CLOUD_TOKEN=$CLOUD_TOKEN/" "$INSTALL_DIR/.env"
        log_success "Cloud services configured (DDNS enabled)"
    elif [ -n "$CLOUD_ID" ] || [ -n "$CLOUD_TOKEN" ]; then
        log_warning "Both --cloud-id and --cloud-token are required for DDNS. Skipping."
    fi

    # 3. Configure Expo token (if provided)
    if [ -n "$EXPO_TOKEN" ]; then
        log_info "Configuring push notifications..."
        sed_inplace "s/EXPO_ACCESS_TOKEN=.*/EXPO_ACCESS_TOKEN=$EXPO_TOKEN/" "$INSTALL_DIR/.env"
        log_success "Expo push token configured"
    fi

    # 4. Clear database
    log_info "Clearing database..."
    rm -f "$DATA_DIR/tillit.db"
    rm -f "$DATA_DIR/tillit.db-wal"
    rm -f "$DATA_DIR/tillit.db-shm"
    log_success "Database cleared"

    # 5. Regenerate RSA keys
    log_info "Generating new RSA-4096 key pair..."
    rm -f "$KEYS_DIR/private.pem" "$KEYS_DIR/public.pem"

    openssl genpkey -algorithm RSA -out "$KEYS_DIR/private.pem" -pkeyopt rsa_keygen_bits:4096
    openssl rsa -pubout -in "$KEYS_DIR/private.pem" -out "$KEYS_DIR/public.pem"

    chmod 600 "$KEYS_DIR/private.pem"
    chmod 644 "$KEYS_DIR/public.pem"
    chown $TILLIT_USER:$TILLIT_USER "$KEYS_DIR/private.pem" "$KEYS_DIR/public.pem" 2>/dev/null || true

    log_success "RSA keys generated"

    # 6. Start service
    log_info "Starting TilliT service..."
    if [ "$IS_MACOS" = true ]; then
        launchctl start cc.tillit.docker 2>/dev/null || true
        launchctl start cc.tillit.server 2>/dev/null || true
    else
        systemctl start tillit.service
    fi

    # 7. Health check
    sleep 5
    if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
        log_success "TilliT is running"
    else
        log_warning "Service started but health check failed — check logs"
    fi

    # Summary
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              Reset Complete                               ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${BLUE}Install Dir:${NC} $INSTALL_DIR"

    if grep -q "DDNS_ENABLED=true" "$INSTALL_DIR/.env" 2>/dev/null; then
        local box_id
        box_id=$(grep "CLOUD_ID=" "$INSTALL_DIR/.env" | cut -d'=' -f2)
        echo -e "  ${BLUE}DDNS Domain:${NC} https://$box_id.tillit.cc"
    fi

    echo ""
    echo "  The server has a fresh database and new keys."
    echo "  All users will need to re-register."
    echo ""
}

main