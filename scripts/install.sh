#!/bin/bash
#
# TilliT Self-Hosted Installation Script (Docker)
#
# Usage (public repo):
#   curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | sudo bash
#
# Usage (private repo):
#   curl -H "Authorization: token <GITHUB_TOKEN>" -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | sudo GITHUB_TOKEN=<token> bash
#
# Or with the script already downloaded:
#   sudo GITHUB_TOKEN=<token> ./install.sh
#   sudo ./install.sh --token <token>
#
# Optional arguments:
#   --token <token>             GitHub token for private repo access
#   --http-port <port>          HTTP port for HTTP-only mode (default: 3000)
#   --https-port <port>         HTTPS port (default: 443)
#   --domain <domain>           Domain for HTTPS (enables HTTPS mode with Caddy)
#   --no-https                  Force HTTP-only mode
#   --tunnel                    Enable Cloudflare Tunnel mode
#   --tunnel-token <token>      Cloudflare Tunnel token (enables tunnel mode)
#   --tor                       Enable Tor Hidden Service mode
#
# This script will:
#   1. Install Docker if not present
#   2. Create /opt/tillit directory
#   3. Download docker-compose configuration (HTTP, HTTPS, or Tunnel mode)
#   4. Generate .env configuration interactively
#   5. Start TilliT service with auto-restart on boot
#
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/tillit"
REPO_RAW="https://raw.githubusercontent.com/tillit-cc/tillit/main"
COMPOSE_FILE="docker-compose.selfhosted.yml"
ENV_SAMPLE=".env.selfhosted.sample"

# Default values
ENABLE_HTTPS=false
ENABLE_TUNNEL=false
ENABLE_TOR=false
TUNNEL_TOKEN=""
TUNNEL_MODE="" # quick, named, token
APP_PORT=3000
HTTPS_PORT=443
DOMAIN=""

# Parse arguments
while [ $# -gt 0 ]; do
    case $1 in
        --token)
            GITHUB_TOKEN="$2"
            shift 2
            ;;
        --http-port)
            APP_PORT="$2"
            shift 2
            ;;
        --https-port)
            HTTPS_PORT="$2"
            shift 2
            ;;
        --domain)
            DOMAIN="$2"
            ENABLE_HTTPS=true
            shift 2
            ;;
        --no-https)
            ENABLE_HTTPS=false
            shift
            ;;
        --tunnel)
            ENABLE_TUNNEL=true
            shift
            ;;
        --tor)
            ENABLE_TOR=true
            shift
            ;;
        --tunnel-token)
            TUNNEL_TOKEN="$2"
            ENABLE_TUNNEL=true
            TUNNEL_MODE="token"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# Setup curl with optional auth header
curl_auth() {
    if [ -n "$GITHUB_TOKEN" ]; then
        curl -H "Authorization: token $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3.raw" "$@"
    else
        curl "$@"
    fi
}

print_banner() {
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                                                           ║"
    echo "║              TilliT Self-Hosted Installer                 ║"
    echo "║                                                           ║"
    echo "║        End-to-End Encrypted Chat for Your Hardware        ║"
    echo "║                                                           ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

log_info() {
    echo -e "${CYAN}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# --- OS detection and portable helpers ---

detect_os() {
    case "$(uname -s)" in
        Darwin) IS_MACOS=true; IS_LINUX=false ;;
        *)      IS_MACOS=false; IS_LINUX=true ;;
    esac
}

sed_inplace() {
    if [ "$IS_MACOS" = true ]; then sed -i '' "$@"; else sed -i "$@"; fi
}

get_local_ip() {
    local ip=""
    if [ "$IS_MACOS" = true ]; then
        ip=$(ipconfig getifaddr en0 2>/dev/null) ||
        ip=$(ipconfig getifaddr en1 2>/dev/null) ||
        ip=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v 127.0.0.1 | head -1 | awk '{print $2}')
    else
        ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi
    echo "${ip:-localhost}"
}

# --- End helpers ---

check_root() {
    if [ "$IS_MACOS" = true ]; then
        # Docker Desktop on macOS runs as the current user
        log_info "macOS detected — running as user $(whoami)"
    elif [ "$(id -u)" -ne 0 ]; then
        log_error "This script must be run as root (use sudo)"
        exit 1
    fi
}

check_architecture() {
    ARCH=$(uname -m)
    case $ARCH in
        aarch64|arm64)
            log_info "Architecture: ARM64 (Raspberry Pi / Apple Silicon)"
            ;;
        x86_64|amd64)
            log_info "Architecture: AMD64 (x86-64)"
            ;;
        *)
            log_warning "Unknown architecture: $ARCH - proceeding anyway"
            ;;
    esac
}

install_docker() {
    if command -v docker &> /dev/null; then
        log_success "Docker is already installed"
        docker --version
    else
        if [ "$IS_MACOS" = true ]; then
            log_error "Docker Desktop is required but not installed."
            echo ""
            echo "  Install Docker Desktop for Mac:"
            echo "    brew install --cask docker"
            echo "  or download from: https://www.docker.com/products/docker-desktop/"
            echo ""
            echo "  After installing, launch Docker Desktop and re-run this script."
            exit 1
        fi

        log_info "Installing Docker..."
        curl -fsSL https://get.docker.com | sh

        # Start and enable Docker service
        systemctl start docker
        systemctl enable docker

        log_success "Docker installed successfully"
    fi

    # Verify Docker daemon is running
    if ! docker info &> /dev/null; then
        log_error "Docker daemon is not running."
        if [ "$IS_MACOS" = true ]; then
            echo "  Please start Docker Desktop and try again."
        fi
        exit 1
    fi

    # Check Docker Compose
    if docker compose version &> /dev/null; then
        log_success "Docker Compose is available"
    else
        log_error "Docker Compose plugin not found"
        exit 1
    fi
}

install_cloudflared() {
    if command -v cloudflared &>/dev/null; then
        log_success "cloudflared is already installed"
        return
    fi

    log_info "Installing cloudflared..."

    if [ "$IS_MACOS" = true ]; then
        if command -v brew &>/dev/null; then
            brew install cloudflared
        else
            local arch
            arch=$(uname -m)
            if [ "$arch" = "arm64" ]; then
                curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz" -o /tmp/cloudflared.tgz
            else
                curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz" -o /tmp/cloudflared.tgz
            fi
            tar xzf /tmp/cloudflared.tgz -C /tmp
            mv /tmp/cloudflared /usr/local/bin/cloudflared
            chmod +x /usr/local/bin/cloudflared
            rm -f /tmp/cloudflared.tgz
        fi
    else
        # Linux: use Cloudflare's package repo
        local arch
        arch=$(uname -m)
        if [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then
            curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" -o /tmp/cloudflared
        elif [ "$arch" = "armv7l" ]; then
            curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" -o /tmp/cloudflared
        else
            curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o /tmp/cloudflared
        fi
        mv /tmp/cloudflared /usr/local/bin/cloudflared
        chmod +x /usr/local/bin/cloudflared
    fi

    if command -v cloudflared &>/dev/null; then
        log_success "cloudflared installed: $(cloudflared --version)"
    else
        log_error "Failed to install cloudflared"
        exit 1
    fi
}

create_install_dir() {
    # On macOS without root, fallback to ~/tillit
    if [ "$IS_MACOS" = true ] && [ "$(id -u)" -ne 0 ] && [ ! -w "$(dirname "$INSTALL_DIR")" ]; then
        INSTALL_DIR="$HOME/tillit"
        log_info "Using user directory: $INSTALL_DIR"
    fi

    log_info "Creating installation directory: $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    log_success "Directory created"
}

download_files() {
    if [ "$ENABLE_TOR" = true ]; then
        log_info "Downloading Tor Docker Compose file..."
        curl_auth -fsSL "$REPO_RAW/docker-compose.tor.yml" -o "docker-compose.yml"
        log_success "Downloaded docker-compose.tor.yml as docker-compose.yml"

        COMPOSE_FILE="docker-compose.yml"
    elif [ "$ENABLE_TUNNEL" = true ] && [ "$TUNNEL_MODE" = "token" ]; then
        log_info "Downloading Tunnel Docker Compose file..."
        curl_auth -fsSL "$REPO_RAW/docker-compose.tunnel.yml" -o "docker-compose.yml"
        log_success "Downloaded docker-compose.tunnel.yml as docker-compose.yml"

        COMPOSE_FILE="docker-compose.yml"
    elif [ "$ENABLE_HTTPS" = true ]; then
        log_info "Downloading HTTPS Docker Compose file..."
        curl_auth -fsSL "$REPO_RAW/docker-compose.https.yml" -o "docker-compose.yml"
        log_success "Downloaded docker-compose.https.yml as docker-compose.yml"

        COMPOSE_FILE="docker-compose.yml"
    else
        log_info "Downloading Docker Compose file..."
        curl_auth -fsSL "$REPO_RAW/$COMPOSE_FILE" -o "docker-compose.yml"
        log_success "Downloaded $COMPOSE_FILE as docker-compose.yml"

        COMPOSE_FILE="docker-compose.yml"
    fi

    log_info "Downloading environment sample..."
    curl_auth -fsSL "$REPO_RAW/$ENV_SAMPLE" -o "$ENV_SAMPLE"
    log_success "Downloaded $ENV_SAMPLE"
}

configure_cloud_services() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║         TilliT Cloud Services             ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════╝${NC}"
    echo ""
    echo "TilliT Cloud provides:"
    echo "  - DDNS: automatic domain (your-id.tillit.cc)"
    echo "  - Push Notifications: via relay (no Expo token needed)"
    echo ""

    if [ "$ENABLE_HTTPS" = true ]; then
        echo -e "${YELLOW}⭐ HTTPS mode — TilliT Cloud credentials are required for DNS-based certificates.${NC}"
        echo ""
        cloud_enabled=true
    else
        read -p "Enable TilliT Cloud services? (y/N): " enable_cloud_input < /dev/tty
        if [ "$enable_cloud_input" = "y" ] || [ "$enable_cloud_input" = "Y" ]; then
            cloud_enabled=true
        else
            cloud_enabled=false
        fi
    fi

    if [ "$cloud_enabled" = true ]; then
        echo ""
        read -p "  Cloud ID (e.g., my-home-server): " CLOUD_ID < /dev/tty
        read -p "  Cloud Token: " CLOUD_TOKEN < /dev/tty
        echo ""

        # DDNS sub-option
        if [ "$ENABLE_HTTPS" = true ]; then
            # DDNS required for HTTPS
            DDNS_ENABLED=true
            if [ -z "$DOMAIN" ]; then
                DOMAIN="${CLOUD_ID}.tillit.cc"
                echo -e "  Domain set to: ${GREEN}$DOMAIN${NC}"
            fi
        else
            read -p "  Enable DDNS (automatic domain ${CLOUD_ID}.tillit.cc)? (Y/n): " enable_ddns_input < /dev/tty
            enable_ddns_input=${enable_ddns_input:-Y}
            if [ "$enable_ddns_input" = "n" ] || [ "$enable_ddns_input" = "N" ]; then
                DDNS_ENABLED=false
            else
                DDNS_ENABLED=true
            fi
        fi

        # Push data mode
        echo ""
        echo "  Push notification data mode:"
        echo "    1) Privacy mode — generic \"New message\" (no metadata sent)"
        echo "    2) Detailed mode — include room/sender info (for quick navigation)"
        echo ""
        read -p "  Choose [1]: " push_data_option < /dev/tty
        push_data_option=${push_data_option:-1}

        if [ "$push_data_option" = "2" ]; then
            PUSH_INCLUDE_DATA=true
        else
            PUSH_INCLUDE_DATA=false
        fi

        echo ""
        log_success "Cloud services configured"
    else
        DDNS_ENABLED=false
        PUSH_INCLUDE_DATA=false
        log_info "Cloud services disabled — you can enable them later by editing .env"
    fi
}

configure_network() {
    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║              Network Configuration                        ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "  How do you want to access TilliT?"
    echo ""
    echo -e "  ${GREEN}1)${NC} 🧅 ${GREEN}Tor Hidden Service${NC}  ${DIM}— Plug & Play / Recommended${NC}"
    echo -e "     Anonymous .onion address, zero configuration needed."
    echo -e "     No port forwarding, no DNS, no accounts. The TilliT app"
    echo -e "     connects natively via built-in Tor support."
    echo ""
    echo -e "  ${GREEN}2)${NC} 🚀 ${GREEN}Cloudflare Tunnel${NC}  ${DIM}— Easy / Starter${NC}"
    echo -e "     No port forwarding, no certificates to manage."
    echo -e "     Quick tunnel (testing) or named tunnel (production)."
    echo ""
    echo -e "  ${GREEN}3)${NC} ⭐ ${YELLOW}HTTPS with Let's Encrypt${NC}  ${DIM}— Premium / TilliT Cloud${NC}"
    echo -e "     Automatic SSL certificates via DNS validation."
    echo -e "     ${YELLOW}Requires TilliT Cloud credentials (Cloud ID + Token).${NC}"
    echo ""
    echo -e "  ${GREEN}4)${NC} 🔧 ${DIM}HTTP only${NC}  ${DIM}— Advanced / Expert${NC}"
    echo -e "     Plain HTTP on a custom port. For local network,"
    echo -e "     or if you have your own reverse proxy / VPN."
    echo ""

    read -p "  Select option [1]: " network_option < /dev/tty
    network_option=${network_option:-1}

    case "$network_option" in
        2)
            ENABLE_TUNNEL=true
            configure_tunnel_mode
            ;;
        3)
            ENABLE_HTTPS=true

            echo ""
            echo -e "  ${YELLOW}⭐ HTTPS mode requires TilliT Cloud for DNS-based certificates.${NC}"
            echo -e "  You will be asked for your Cloud ID and Token in the next step."
            echo ""
            echo -e "  ${DIM}Caddy reverse proxy terminates TLS and forwards to TilliT internally.${NC}"
            echo -e "  ${DIM}TilliT always runs on port 3000 inside Docker (not exposed).${NC}"
            echo ""
            echo -e "  ${DIM}  Client ──HTTPS──→ :HTTPS_PORT ──→ Caddy ──→ TilliT :3000${NC}"
            echo ""

            read -p "  HTTPS_PORT (public, clients connect here) [443]: " https_port_input < /dev/tty
            HTTPS_PORT=${https_port_input:-443}

            echo ""
            log_success "HTTPS :$HTTPS_PORT → Caddy → TilliT :3000"
            ;;
        4)
            ENABLE_HTTPS=false

            read -p "  HTTP port [3000]: " http_port_input < /dev/tty
            APP_PORT=${http_port_input:-3000}

            log_success "HTTP enabled on port $APP_PORT"
            ;;
        *)
            ENABLE_TOR=true

            echo ""
            echo -e "  ${DIM}Tor hidden service maps .onion:80 → TilliT:3000 via Docker network.${NC}"
            echo -e "  ${DIM}The .onion address is auto-generated on first start and persisted.${NC}"
            echo ""
            echo -e "  ${DIM}  Client ──Tor──→ .onion:80 ──→ tor container ──→ TilliT :3000${NC}"
            echo ""

            log_success "Tor Hidden Service mode selected"
            ;;
    esac
}

configure_tunnel_mode() {
    echo ""
    echo -e "${YELLOW}=== Cloudflare Tunnel Setup ===${NC}"
    echo ""
    echo "  1) Quick tunnel (testing - temporary URL, no account needed)"
    echo "  2) Named tunnel (production - your domain, requires Cloudflare account)"
    echo "  3) I already have a tunnel token"
    echo ""

    read -p "Select option [1]: " tunnel_option < /dev/tty
    tunnel_option=${tunnel_option:-1}

    case "$tunnel_option" in
        2)
            TUNNEL_MODE="named"
            ;;
        3)
            TUNNEL_MODE="token"
            echo ""
            read -p "Enter your Cloudflare Tunnel token: " TUNNEL_TOKEN < /dev/tty
            if [ -z "$TUNNEL_TOKEN" ]; then
                log_error "Tunnel token is required"
                exit 1
            fi
            ;;
        *)
            TUNNEL_MODE="quick"
            ;;
    esac
}

setup_quick_tunnel() {
    log_info "Setting up quick tunnel..."
    install_cloudflared

    # Quick tunnel uses HTTP-only compose (TilliT on port 3000)
    # cloudflared runs on the host, not in Docker
    log_info "Starting cloudflared quick tunnel..."
    echo ""
    echo -e "${YELLOW}Starting quick tunnel - this will display the temporary URL below.${NC}"
    echo -e "${YELLOW}Press Ctrl+C to stop the tunnel (TilliT will keep running).${NC}"
    echo ""

    # Run cloudflared in background, capture output to find URL
    local tunnel_log="$INSTALL_DIR/cloudflared-quick.log"
    cloudflared tunnel --url "http://localhost:$APP_PORT" > "$tunnel_log" 2>&1 &
    local cf_pid=$!

    # Wait for URL to appear in logs
    local tunnel_url=""
    for i in {1..30}; do
        if [ -f "$tunnel_log" ]; then
            tunnel_url=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$tunnel_log" 2>/dev/null | head -1)
            if [ -n "$tunnel_url" ]; then
                break
            fi
        fi
        sleep 1
    done

    if [ -n "$tunnel_url" ]; then
        QUICK_TUNNEL_URL="$tunnel_url"
        QUICK_TUNNEL_PID=$cf_pid
        log_success "Quick tunnel active at: $tunnel_url"
        echo ""
        echo -e "  ${YELLOW}Note:${NC} This URL is temporary and changes on restart."
        echo -e "  For a permanent URL, re-run with a named tunnel (option 2) or token (option 3)."
    else
        log_warning "Could not detect tunnel URL - cloudflared may still be starting"
        log_info "Check logs: cat $tunnel_log"
        QUICK_TUNNEL_PID=$cf_pid
    fi
}

setup_named_tunnel() {
    log_info "Setting up named Cloudflare Tunnel..."
    install_cloudflared

    echo ""
    echo -e "${CYAN}This will guide you through creating a named Cloudflare Tunnel.${NC}"
    echo -e "${CYAN}You'll need a Cloudflare account with a domain.${NC}"
    echo ""

    # Step 1: Login
    echo -e "${YELLOW}Step 1: Authenticate with Cloudflare${NC}"
    echo "A browser window will open. Log in and authorize cloudflared."
    echo ""
    read -p "Press Enter to continue..."
    cloudflared tunnel login

    # Step 2: Create tunnel
    echo ""
    echo -e "${YELLOW}Step 2: Creating tunnel 'tillit'${NC}"
    local create_output
    create_output=$(cloudflared tunnel create tillit 2>&1)
    echo "$create_output"

    # Extract tunnel ID
    local tunnel_id
    tunnel_id=$(echo "$create_output" | grep -o '[0-9a-f\-]\{36\}' | head -1)

    if [ -z "$tunnel_id" ]; then
        log_warning "Could not extract tunnel ID. The tunnel may already exist."
        echo ""
        read -p "Enter your tunnel ID (or press Enter to list tunnels): " tunnel_id < /dev/tty
        if [ -z "$tunnel_id" ]; then
            cloudflared tunnel list
            echo ""
            read -p "Enter tunnel ID from the list above: " tunnel_id < /dev/tty
        fi
    fi

    # Step 3: Route DNS
    echo ""
    echo -e "${YELLOW}Step 3: Configure DNS route${NC}"
    read -p "Enter your domain (e.g., chat.yourdomain.com): " tunnel_domain < /dev/tty

    if [ -n "$tunnel_domain" ]; then
        cloudflared tunnel route dns tillit "$tunnel_domain"
        log_success "DNS route created: $tunnel_domain -> tunnel 'tillit'"
        TUNNEL_DOMAIN="$tunnel_domain"
    fi

    # Step 4: Install as service
    echo ""
    echo -e "${YELLOW}Step 4: Installing cloudflared as a service${NC}"

    # Create config file for cloudflared
    local cf_config_dir
    if [ "$IS_MACOS" = true ]; then
        cf_config_dir="$HOME/.cloudflared"
    else
        cf_config_dir="/etc/cloudflared"
        mkdir -p "$cf_config_dir"
    fi

    cat > "$cf_config_dir/config.yml" << EOF
tunnel: tillit
credentials-file: $HOME/.cloudflared/${tunnel_id}.json

ingress:
  - hostname: ${tunnel_domain}
    service: http://localhost:${APP_PORT}
  - service: http_status:404
EOF

    log_success "cloudflared config written to $cf_config_dir/config.yml"

    # Install cloudflared service
    if [ "$IS_MACOS" = true ]; then
        install_cloudflared_launchd "named"
    else
        install_cloudflared_systemd "named"
    fi
}

install_cloudflared_systemd() {
    local mode="$1" # quick or named

    log_info "Installing cloudflared systemd service..."

    if [ "$mode" = "named" ]; then
        cat > /etc/systemd/system/cloudflared-tillit.service << EOF
[Unit]
Description=Cloudflare Tunnel for TilliT
After=network-online.target tillit.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel run tillit
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    else
        cat > /etc/systemd/system/cloudflared-tillit.service << EOF
[Unit]
Description=Cloudflare Quick Tunnel for TilliT
After=network-online.target tillit.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel --url http://localhost:${APP_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    fi

    systemctl daemon-reload
    systemctl enable cloudflared-tillit.service
    systemctl start cloudflared-tillit.service

    log_success "cloudflared systemd service installed and started"
}

install_cloudflared_launchd() {
    local mode="$1" # quick or named
    local plist_dir="$HOME/Library/LaunchAgents"
    local plist_file="$plist_dir/com.cloudflare.tillit-tunnel.plist"
    local cf_bin
    cf_bin=$(command -v cloudflared)

    mkdir -p "$plist_dir"

    if [ "$mode" = "named" ]; then
        cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflare.tillit-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>$cf_bin</string>
        <string>--no-autoupdate</string>
        <string>tunnel</string>
        <string>run</string>
        <string>tillit</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/cloudflared.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/cloudflared.log</string>
</dict>
</plist>
EOF
    else
        cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cloudflare.tillit-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>$cf_bin</string>
        <string>--no-autoupdate</string>
        <string>tunnel</string>
        <string>--url</string>
        <string>http://localhost:$APP_PORT</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/cloudflared.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/cloudflared.log</string>
</dict>
</plist>
EOF
    fi

    launchctl load "$plist_file" 2>/dev/null || true

    log_success "cloudflared launchd service installed: $plist_file"
}

configure_env() {
    if [ -f ".env" ]; then
        echo ""
        echo -e "${YELLOW}Existing configuration found in .env${NC}"
        echo ""
        echo "  1) Keep existing configuration"
        echo "  2) Create new configuration (backup old as .env.backup)"
        echo ""
        read -p "Select option [1]: " config_option < /dev/tty
        config_option=${config_option:-1}

        if [ "$config_option" = "2" ]; then
            log_info "Backing up existing .env to .env.backup"
            cp .env .env.backup
            rm .env
        else
            log_info "Using existing configuration"
            # Load DDNS settings from existing .env for network config
            CLOUD_ID=$(grep "^CLOUD_ID=" .env | cut -d'=' -f2)
            CLOUD_TOKEN=$(grep "^CLOUD_TOKEN=" .env | cut -d'=' -f2)
            DDNS_ENABLED=$(grep "^DDNS_ENABLED=" .env | cut -d'=' -f2)

            # Check if HTTPS requires DDNS
            if [ "$ENABLE_HTTPS" = true ]; then
                if [ -z "$CLOUD_ID" ] || [ "$CLOUD_ID" = "your-box-id" ]; then
                    log_error "HTTPS requires DDNS to be configured"
                    log_info "Please select option 2 to create new configuration with DDNS"
                    exit 1
                fi
                DOMAIN="${CLOUD_ID}.tillit.cc"
                echo -e "Domain: ${GREEN}$DOMAIN${NC}"
            fi

            # Apply network settings
            apply_network_config
            return
        fi
    fi

    log_info "Configuring TilliT..."

    # Start with sample
    cp "$ENV_SAMPLE" .env

    # Tor mode and Tunnel mode with token: skip cloud services
    if [ "$ENABLE_TOR" = true ]; then
        log_info "Tor mode — cloud services skipped (maximum privacy)"
    elif [ "$ENABLE_TUNNEL" = true ] && [ "$TUNNEL_MODE" = "token" ]; then
        # Write tunnel token to .env
        sed_inplace "s/# CLOUDFLARE_TUNNEL_TOKEN=/CLOUDFLARE_TUNNEL_TOKEN=$TUNNEL_TOKEN/" .env
        log_success "Tunnel token configured"
    elif [ "$ENABLE_TUNNEL" != true ]; then
        # Configure cloud services (DDNS + push relay)
        configure_cloud_services

        # Apply cloud settings to .env
        if [ -n "$CLOUD_ID" ] && [ "$CLOUD_ID" != "your-box-id" ]; then
            sed_inplace "s/CLOUD_ID=your-box-id/CLOUD_ID=$CLOUD_ID/" .env
            sed_inplace "s/CLOUD_TOKEN=your-box-token/CLOUD_TOKEN=$CLOUD_TOKEN/" .env
        fi
        if [ "$DDNS_ENABLED" = true ]; then
            sed_inplace "s/DDNS_ENABLED=false/DDNS_ENABLED=true/" .env
        fi
        if [ "$PUSH_INCLUDE_DATA" = true ]; then
            sed_inplace "s/PUSH_INCLUDE_DATA=false/PUSH_INCLUDE_DATA=true/" .env
        fi
    fi

    # Apply network settings to .env
    apply_network_config

    log_success "Configuration saved to .env"
}

apply_network_config() {
    # Remove old network config lines if present
    sed_inplace '/^# Network Configuration/d' .env 2>/dev/null || true
    sed_inplace '/^DOMAIN=/d' .env 2>/dev/null || true
    sed_inplace '/^HTTPS_PORT=/d' .env 2>/dev/null || true
    sed_inplace '/^HTTP_PORT=/d' .env 2>/dev/null || true

    # Add network settings to .env
    echo "" >> .env
    echo "# Network Configuration (set by install.sh)" >> .env
    if [ "$ENABLE_HTTPS" = true ]; then
        echo "DOMAIN=$DOMAIN" >> .env
        echo "HTTPS_PORT=$HTTPS_PORT" >> .env
        log_info "Network: HTTPS on port $HTTPS_PORT"
    else
        echo "APP_PORT=$APP_PORT" >> .env
        log_info "Network: HTTP on port $APP_PORT"
    fi
}

start_service() {
    log_info "Pulling TilliT Docker image..."
    docker compose -f "$COMPOSE_FILE" pull

    log_info "Starting TilliT service..."
    docker compose -f "$COMPOSE_FILE" up -d

    log_success "TilliT service started"
}

wait_for_health() {
    if [ "$ENABLE_HTTPS" = true ]; then
        # HTTPS mode: no HTTP port exposed, health check via node inside the container
        log_info "Waiting for TilliT to be ready..."

        local node_health="node -e \"require('http').get('http://localhost:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))\""

        for i in {1..30}; do
            if docker compose -f "$COMPOSE_FILE" exec -T tillit sh -c "$node_health" > /dev/null 2>&1; then
                log_success "TilliT is running!"
                return 0
            fi
            echo -n "."
            sleep 2
        done

        echo ""
        log_warning "Health check timeout"
        echo ""
        echo -e "  ${DIM}Troubleshooting:${NC}"
        echo -e "  ${DIM}  Check logs:    docker compose -f $INSTALL_DIR/$COMPOSE_FILE logs${NC}"
        echo -e "  ${DIM}  Check status:  docker compose -f $INSTALL_DIR/$COMPOSE_FILE ps${NC}"
        echo ""
    else
        log_info "Waiting for TilliT to be ready on port $APP_PORT..."

        for i in {1..30}; do
            if curl -sf "http://localhost:$APP_PORT/health" > /dev/null 2>&1; then
                log_success "TilliT is running! (http://localhost:$APP_PORT/health)"
                return 0
            fi
            echo -n "."
            sleep 2
        done

        echo ""
        log_warning "Health check timeout on http://localhost:$APP_PORT/health"
        echo ""
        echo -e "  ${DIM}Troubleshooting:${NC}"
        echo -e "  ${DIM}  Check logs:    docker compose -f $INSTALL_DIR/$COMPOSE_FILE logs${NC}"
        echo -e "  ${DIM}  Check status:  docker compose -f $INSTALL_DIR/$COMPOSE_FILE ps${NC}"
        echo ""
    fi
}

wait_for_domain() {
    if [ "$ENABLE_HTTPS" != true ]; then
        return 0
    fi

    log_info "Waiting for HTTPS to be reachable..."
    log_info "This may take 1-2 minutes for DNS propagation and certificate generation"

    # Build HTTPS URL with port if not standard
    if [ "$HTTPS_PORT" = "443" ]; then
        HTTPS_URL="https://$DOMAIN"
    else
        HTTPS_URL="https://$DOMAIN:$HTTPS_PORT"
    fi

    for i in {1..60}; do
        if curl -sf --max-time 10 "$HTTPS_URL/health" > /dev/null 2>&1; then
            log_success "HTTPS ready: $HTTPS_URL"
            return 0
        fi
        echo -n "."
        sleep 5
    done

    echo ""
    log_warning "HTTPS not yet reachable (this is normal for new domains)"
    log_info "The service is running - HTTPS will work once DNS propagates and certificate is issued"
    log_info "Check logs: docker compose -f $INSTALL_DIR/$COMPOSE_FILE logs"
}

wait_for_onion() {
    log_info "Waiting for Tor to generate .onion address (this may take up to 60 seconds)..."

    for i in {1..60}; do
        ONION_ADDRESS=$(docker compose -f "$COMPOSE_FILE" exec -T tor cat /var/lib/tor/hidden_service/hostname 2>/dev/null) || true
        if [ -n "$ONION_ADDRESS" ]; then
            ONION_ADDRESS=$(echo "$ONION_ADDRESS" | tr -d '[:space:]')
            log_success "Tor hidden service ready: http://$ONION_ADDRESS"
            return 0
        fi
        echo -n "."
        sleep 2
    done

    echo ""
    log_warning "Could not read .onion address yet — Tor may still be bootstrapping"
    log_info "Check later: docker compose -f $INSTALL_DIR/$COMPOSE_FILE exec tor cat /var/lib/tor/hidden_service/hostname"
}

install_service() {
    if [ "$IS_MACOS" = true ]; then
        install_launchd_service
    else
        install_systemd_service
    fi
}

install_systemd_service() {
    log_info "Installing systemd service for auto-start..."

    cat > /etc/systemd/system/tillit.service << EOF
[Unit]
Description=TilliT Chat Server (Docker)
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/docker compose -f $COMPOSE_FILE up -d
ExecStop=/usr/bin/docker compose -f $COMPOSE_FILE down

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable tillit.service

    log_success "Systemd service installed and enabled"
}

install_launchd_service() {
    log_info "Installing launchd service for auto-start..."

    local plist_dir="$HOME/Library/LaunchAgents"
    local plist_file="$plist_dir/cc.tillit.docker.plist"
    local docker_bin
    docker_bin=$(command -v docker)

    mkdir -p "$plist_dir"

    cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>cc.tillit.docker</string>
    <key>ProgramArguments</key>
    <array>
        <string>$docker_bin</string>
        <string>compose</string>
        <string>-f</string>
        <string>$INSTALL_DIR/$COMPOSE_FILE</string>
        <string>up</string>
        <string>-d</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/tillit-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/tillit-launchd.log</string>
</dict>
</plist>
EOF

    launchctl load "$plist_file" 2>/dev/null || true

    log_success "launchd service installed: $plist_file"
}

print_summary() {
    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║           TilliT Installation Complete!                   ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${CYAN}Installation directory:${NC} $INSTALL_DIR"

    if [ "$ENABLE_TOR" = true ]; then
        echo -e "  ${CYAN}Local access:${NC} http://$LOCAL_IP:$APP_PORT"
        echo -e "  ${CYAN}Health check:${NC} http://$LOCAL_IP:$APP_PORT/health"
        echo ""
        if [ -n "${ONION_ADDRESS:-}" ]; then
            echo -e "  ${GREEN}Onion URL:${NC} http://$ONION_ADDRESS"
        else
            echo -e "  ${YELLOW}Onion URL:${NC} pending (check: docker compose exec tor cat /var/lib/tor/hidden_service/hostname)"
        fi
        echo ""
        echo -e "  ${YELLOW}Note:${NC} The .onion address is persistent across restarts."
        echo -e "        The TilliT app connects natively (built-in Tor support)."
    elif [ "$ENABLE_TUNNEL" = true ]; then
        echo -e "  ${CYAN}Local access:${NC} http://$LOCAL_IP:$APP_PORT"
        echo -e "  ${CYAN}Health check:${NC} http://$LOCAL_IP:$APP_PORT/health"
        echo ""

        if [ "$TUNNEL_MODE" = "quick" ] && [ -n "$QUICK_TUNNEL_URL" ]; then
            echo -e "  ${GREEN}Quick tunnel:${NC} $QUICK_TUNNEL_URL"
            echo -e "  ${YELLOW}Note:${NC} This URL is temporary and changes on restart."
            echo -e "        For a permanent URL, re-run with a named tunnel or token."
        elif [ "$TUNNEL_MODE" = "named" ] && [ -n "$TUNNEL_DOMAIN" ]; then
            echo -e "  ${GREEN}Tunnel domain:${NC} https://$TUNNEL_DOMAIN"
        elif [ "$TUNNEL_MODE" = "token" ]; then
            echo -e "  ${GREEN}Cloudflare Tunnel:${NC} active (configure Public Hostname in Cloudflare dashboard)"
            echo -e "  ${CYAN}Dashboard:${NC} https://one.dash.cloudflare.com/ > Networks > Tunnels"
        fi
    elif [ "$ENABLE_HTTPS" = true ]; then
        # Build display URL with port if not standard
        if [ "$HTTPS_PORT" = "443" ]; then
            HTTPS_DISPLAY="https://$DOMAIN"
        else
            HTTPS_DISPLAY="https://$DOMAIN:$HTTPS_PORT"
        fi

        echo -e "  ${CYAN}Public access (HTTPS):${NC} ${GREEN}$HTTPS_DISPLAY${NC}"
        echo ""
        echo -e "  ${YELLOW}Note:${NC} HTTPS certificate is generated on first request"
    else
        echo -e "  ${CYAN}Local access:${NC} http://$LOCAL_IP:$APP_PORT"
        echo -e "  ${CYAN}Health check:${NC} http://$LOCAL_IP:$APP_PORT/health"

        if [ "$DDNS_ENABLED" = true ]; then
            echo ""
            echo -e "  ${GREEN}DDNS enabled:${NC} http://$CLOUD_ID.tillit.cc:$APP_PORT"
            echo -e "  ${YELLOW}Note:${NC} For HTTPS, re-run install.sh and choose option 2"
        fi
    fi

    echo ""
    echo -e "  ${YELLOW}Management:${NC}"
    echo "    tillit status    — Check service status"
    echo "    tillit config    — Configure settings"
    echo "    tillit logs      — View logs"
    echo "    tillit update    — Update to latest version"
    echo "    tillit help      — All available commands"
    echo ""

    echo -e "  ${CYAN}Connect your TilliT mobile app to:${NC}"
    if [ "$ENABLE_TOR" = true ]; then
        if [ -n "${ONION_ADDRESS:-}" ]; then
            echo -e "    ${GREEN}http://$ONION_ADDRESS${NC}"
        else
            echo -e "    ${GREEN}Your .onion address (see above)${NC}"
        fi
    elif [ "$ENABLE_TUNNEL" = true ]; then
        if [ "$TUNNEL_MODE" = "quick" ] && [ -n "$QUICK_TUNNEL_URL" ]; then
            echo -e "    ${GREEN}$QUICK_TUNNEL_URL${NC}"
        elif [ "$TUNNEL_MODE" = "named" ] && [ -n "$TUNNEL_DOMAIN" ]; then
            echo -e "    ${GREEN}https://$TUNNEL_DOMAIN${NC}"
        elif [ "$TUNNEL_MODE" = "token" ]; then
            echo -e "    ${GREEN}Your configured tunnel domain (see Cloudflare dashboard)${NC}"
        fi
    elif [ "$ENABLE_HTTPS" = true ]; then
        echo -e "    ${GREEN}$HTTPS_DISPLAY${NC}"
    else
        echo -e "    ${GREEN}http://$LOCAL_IP:$APP_PORT${NC}"
    fi
    echo ""

    if [ "$NEEDS_PATH_SETUP" = true ]; then
        # Detect user shell rc file
        local rc_file=".bashrc"
        local rc_path="$HOME/.bashrc"
        case "$(basename "${SHELL:-/bin/bash}")" in
            zsh)  rc_file=".zshrc"; rc_path="$HOME/.zshrc" ;;
            bash) rc_file=".bashrc"; rc_path="$HOME/.bashrc" ;;
            fish) rc_file=".config/fish/config.fish"; rc_path="$HOME/.config/fish/config.fish" ;;
        esac

        echo -e "  ${YELLOW}The tillit command is not in your PATH.${NC}"
        read -p "  Add ~/.local/bin to PATH in ~/$rc_file? (Y/n): " add_path_input < /dev/tty
        add_path_input=${add_path_input:-Y}

        if [ "$add_path_input" != "n" ] && [ "$add_path_input" != "N" ]; then
            echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc_path"
            export PATH="$HOME/.local/bin:$PATH"
            log_success "PATH updated in ~/$rc_file (active in new terminals)"
        else
            echo ""
            echo "  To add it manually later:"
            echo "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/$rc_file"
            echo ""
        fi
    fi
}

# Main installation flow
main() {
    print_banner
    detect_os
    LOCAL_IP=$(get_local_ip)
    check_root
    check_architecture
    install_docker
    create_install_dir

    # Configure network mode (HTTP, HTTPS, Tunnel, or Tor) - must be done before download_files
    # Skip interactive config if already set via CLI arguments
    if [ "$ENABLE_TOR" = true ]; then
        log_info "Tor Hidden Service enabled via CLI"
    elif [ "$ENABLE_TUNNEL" = true ] && [ -n "$TUNNEL_TOKEN" ]; then
        log_info "Cloudflare Tunnel enabled via CLI with token"
    elif [ "$ENABLE_HTTPS" = true ]; then
        log_info "HTTPS enabled via CLI with domain: $DOMAIN"
    else
        configure_network
    fi

    download_files
    configure_env
    start_service
    wait_for_health

    # Post-start actions depending on network mode
    if [ "$ENABLE_TOR" = true ]; then
        wait_for_onion
    elif [ "$ENABLE_TUNNEL" = true ]; then
        if [ "$TUNNEL_MODE" = "quick" ]; then
            setup_quick_tunnel
        elif [ "$TUNNEL_MODE" = "named" ]; then
            setup_named_tunnel
        fi
        # token mode: cloudflared runs inside Docker, nothing extra to do
    elif [ "$ENABLE_HTTPS" = true ]; then
        wait_for_domain
    fi

    install_service
    install_cli
    print_summary
}

install_cli() {
    log_info "Installing tillit CLI..."

    local cli_src="$INSTALL_DIR/scripts/tillit-cli.sh"
    local cli_url="$REPO_RAW/scripts/tillit-cli.sh"

    # Download CLI script if not present (Docker install)
    if [ ! -f "$cli_src" ]; then
        mkdir -p "$INSTALL_DIR/scripts"
        curl_auth -fsSL "$cli_url" -o "$cli_src"
    fi
    chmod +x "$cli_src"

    # Symlink to PATH
    if [ "$IS_MACOS" = true ] && [ "$(id -u)" -ne 0 ]; then
        # macOS without root: use ~/.local/bin
        mkdir -p "$HOME/.local/bin"
        ln -sf "$cli_src" "$HOME/.local/bin/tillit"
        if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
            NEEDS_PATH_SETUP=true
        fi
    else
        ln -sf "$cli_src" /usr/local/bin/tillit
    fi

    log_success "tillit CLI installed (run 'tillit help' for usage)"
}

main "$@"
