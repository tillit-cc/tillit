#!/bin/bash
#
# TilliT First-Boot Installation Script
#
# This script runs on the Raspberry Pi at first boot via a systemd one-shot service.
# It is placed on the SD card boot partition by rpi-setup.sh and registered
# by the patched firstrun.sh (which runs before networking is available).
#
# The systemd service (tillit-install.service) ensures this script only runs
# AFTER the network is online. On success it touches /var/lib/tillit-installed
# and disables itself. On failure it leaves no marker so it retries on next reboot.
#
# All output goes to /var/log/tillit-install.log for debugging.
#
set -euo pipefail

LOGFILE="/var/log/tillit-install.log"
INSTALL_DIR="/opt/tillit"
REPO_RAW="https://raw.githubusercontent.com/tillit-cc/tillit/main"
ENV_FILE="/usr/local/share/tillit-firstboot.env"

# ── Logging ──────────────────────────────────────────────────────────────────

exec > >(tee -a "$LOGFILE") 2>&1

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "===== TilliT First-Boot Installation Starting ====="

# ── Load user configuration ──────────────────────────────────────────────────

NETWORK_MODE="http"
CLOUD_ID=""
CLOUD_TOKEN=""
DDNS_ENABLED="false"
PUSH_INCLUDE_DATA="false"
CLOUDFLARE_TUNNEL_TOKEN=""
APP_PORT="3000"

if [ -f "$ENV_FILE" ]; then
    log "Loading configuration from $ENV_FILE"
    # shellcheck source=/dev/null
    . "$ENV_FILE"
    log "  NETWORK_MODE=$NETWORK_MODE"
    log "  CLOUD_ID=${CLOUD_ID:+(set)}"
    log "  DDNS_ENABLED=$DDNS_ENABLED"
else
    log "No configuration file found at $ENV_FILE — using defaults"
fi

# ── Wait for network ─────────────────────────────────────────────────────────

wait_for_network() {
    log "Waiting for network connectivity..."
    local attempt=0
    local max_attempts=60
    while [ $attempt -lt $max_attempts ]; do
        if curl -sf --max-time 5 https://get.docker.com > /dev/null 2>&1; then
            log "Network is available"
            return 0
        fi
        attempt=$((attempt + 1))
        log "  Attempt $attempt/$max_attempts — no network yet..."
        sleep 5
    done
    log "ERROR: Network not available after $max_attempts attempts"
    return 1
}

wait_for_network

# ── Install Docker ───────────────────────────────────────────────────────────

install_docker() {
    if command -v docker &> /dev/null; then
        log "Docker is already installed: $(docker --version)"
        return 0
    fi

    log "Installing Docker..."
    curl -fsSL https://get.docker.com | sh

    systemctl start docker
    systemctl enable docker

    log "Docker installed: $(docker --version)"

    # Add the primary non-root user to docker group
    local primary_user
    primary_user=$(awk -F: '$3 >= 1000 && $3 < 65534 { print $1; exit }' /etc/passwd)
    if [ -n "$primary_user" ]; then
        usermod -aG docker "$primary_user"
        log "Added user '$primary_user' to docker group"
    fi
}

install_docker

# Verify Docker Compose is available
if ! docker compose version &> /dev/null; then
    log "ERROR: Docker Compose plugin not available"
    exit 1
fi
log "Docker Compose available: $(docker compose version)"

# ── Create install directory ─────────────────────────────────────────────────

log "Creating installation directory: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# ── Download files ───────────────────────────────────────────────────────────

download_compose() {
    if [ "$NETWORK_MODE" = "tor" ]; then
        log "Downloading docker-compose.tor.yml..."
        curl -fsSL "$REPO_RAW/docker-compose.tor.yml" -o "docker-compose.yml"
        log "Downloading Dockerfile.tor..."
        curl -fsSL "$REPO_RAW/Dockerfile.tor" -o "Dockerfile.tor"
    elif [ "$NETWORK_MODE" = "tunnel" ] && [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
        log "Downloading docker-compose.tunnel.yml..."
        curl -fsSL "$REPO_RAW/docker-compose.tunnel.yml" -o "docker-compose.yml"
    else
        log "Downloading docker-compose.selfhosted.yml..."
        curl -fsSL "$REPO_RAW/docker-compose.selfhosted.yml" -o "docker-compose.yml"
    fi
    log "Docker Compose file downloaded"

    # Download mDNS sidecar files (used by all compose modes)
    log "Downloading Dockerfile.mdns..."
    curl -fsSL "$REPO_RAW/Dockerfile.mdns" -o "Dockerfile.mdns"
    mkdir -p "$INSTALL_DIR/scripts"
    log "Downloading mdns-entrypoint.sh..."
    curl -fsSL "$REPO_RAW/scripts/mdns-entrypoint.sh" -o "scripts/mdns-entrypoint.sh"
    chmod +x "scripts/mdns-entrypoint.sh"
    log "mDNS files downloaded"
}

download_env() {
    log "Downloading .env.selfhosted.sample..."
    curl -fsSL "$REPO_RAW/.env.selfhosted.sample" -o ".env"
    log "Environment file downloaded"
}

download_compose
download_env

# ── Apply configuration ──────────────────────────────────────────────────────

apply_config() {
    log "Applying configuration to .env..."

    # Network mode
    if [ "$NETWORK_MODE" = "tunnel" ] && [ -n "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
        sed -i "s|# CLOUDFLARE_TUNNEL_TOKEN=|CLOUDFLARE_TUNNEL_TOKEN=$CLOUDFLARE_TUNNEL_TOKEN|" .env
        log "  Cloudflare Tunnel token configured"
    fi

    # Cloud services
    if [ -n "$CLOUD_ID" ] && [ "$CLOUD_ID" != "your-box-id" ]; then
        sed -i "s|CLOUD_ID=your-box-id|CLOUD_ID=$CLOUD_ID|" .env
        log "  Cloud ID set"
    fi
    if [ -n "$CLOUD_TOKEN" ] && [ "$CLOUD_TOKEN" != "your-box-token" ]; then
        sed -i "s|CLOUD_TOKEN=your-box-token|CLOUD_TOKEN=$CLOUD_TOKEN|" .env
        log "  Cloud Token set"
    fi

    # DDNS
    if [ "$DDNS_ENABLED" = "true" ]; then
        sed -i "s|DDNS_ENABLED=false|DDNS_ENABLED=true|" .env
        log "  DDNS enabled"
    fi

    # Push data mode
    if [ "$PUSH_INCLUDE_DATA" = "true" ]; then
        sed -i "s|PUSH_INCLUDE_DATA=false|PUSH_INCLUDE_DATA=true|" .env
        log "  Push data mode: detailed"
    fi

    # APP_PORT
    if [ "$APP_PORT" != "3000" ]; then
        sed -i "s|APP_PORT=3000|APP_PORT=$APP_PORT|" .env
        log "  APP_PORT set to $APP_PORT"
    fi

    log "Configuration applied"
}

apply_config

# ── Pull and start ───────────────────────────────────────────────────────────

log "Pulling Docker images..."
docker compose pull

log "Starting TilliT..."
docker compose up -d

# ── Install systemd service for auto-start ───────────────────────────────────

install_tillit_service() {
    log "Installing TilliT systemd service..."

    cat > /etc/systemd/system/tillit.service << 'EOF'
[Unit]
Description=TilliT Chat Server (Docker)
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/tillit
ExecStart=/usr/bin/docker compose -f docker-compose.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.yml down

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable tillit.service
    log "TilliT systemd service installed and enabled"
}

install_tillit_service

# ── Install CLI ──────────────────────────────────────────────────────────────

install_cli() {
    log "Installing TilliT CLI..."

    local cli_url="$REPO_RAW/scripts/tillit-cli.sh"
    mkdir -p "$INSTALL_DIR/scripts"
    curl -fsSL "$cli_url" -o "$INSTALL_DIR/scripts/tillit-cli.sh"
    chmod +x "$INSTALL_DIR/scripts/tillit-cli.sh"
    ln -sf "$INSTALL_DIR/scripts/tillit-cli.sh" /usr/local/bin/tillit

    log "TilliT CLI installed (/usr/local/bin/tillit)"
}

install_cli

# ── Health check ─────────────────────────────────────────────────────────────

health_check() {
    log "Running health check..."
    local attempt=0
    local max_attempts=30

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf --max-time 5 "http://localhost:$APP_PORT/health" > /dev/null 2>&1; then
            log "Health check passed — TilliT is running on port $APP_PORT"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done

    log "WARNING: Health check did not pass after $max_attempts attempts"
    log "TilliT may still be starting. Check with: docker compose -f $INSTALL_DIR/docker-compose.yml logs"
    return 0  # Don't fail the installation — the containers are running
}

health_check

# ── Tor .onion address ──────────────────────────────────────────────────────

if [ "$NETWORK_MODE" = "tor" ]; then
    log "Waiting for Tor to generate .onion address..."
    for i in $(seq 1 60); do
        onion_addr=$(docker compose exec -T tor cat /var/lib/tor/hidden_service/hostname 2>/dev/null) || true
        if [ -n "$onion_addr" ]; then
            onion_addr=$(echo "$onion_addr" | tr -d '[:space:]')
            log "Tor hidden service ready: http://$onion_addr"
            break
        fi
        sleep 2
    done
    if [ -z "${onion_addr:-}" ]; then
        log "WARNING: Could not read .onion address yet — Tor may still be bootstrapping"
        log "Check later: docker compose -f $INSTALL_DIR/docker-compose.yml exec tor cat /var/lib/tor/hidden_service/hostname"
    fi
fi

# ── Cleanup ──────────────────────────────────────────────────────────────────

cleanup() {
    log "Cleaning up boot partition files..."

    # Remove firstboot files from boot partition (both legacy and Bookworm paths)
    local boot_paths=("/boot/firmware" "/boot")
    for bp in "${boot_paths[@]}"; do
        rm -f "$bp/tillit-firstboot.sh" 2>/dev/null || true
        rm -f "$bp/tillit-firstboot.env" 2>/dev/null || true
    done

    # Remove the env file from /usr/local/share
    rm -f "$ENV_FILE" 2>/dev/null || true

    log "Cleanup complete"
}

cleanup

# ── Done ─────────────────────────────────────────────────────────────────────

log "===== TilliT First-Boot Installation Complete ====="
log ""
log "TilliT is running at: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):$APP_PORT"
log "Management CLI: tillit status / tillit logs / tillit help"
log ""
