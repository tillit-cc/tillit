#!/bin/bash
#
# TilliT Self-Hosted Installation Script (Bare-Metal)
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install-bare.sh | sudo bash
#
# This script installs TilliT directly on the system without Docker.
# Recommended for: Raspberry Pi OS, Debian, Ubuntu
#
set -e

# When piped via curl | bash, stdin is the script itself, not the terminal.
# Reopen stdin from /dev/tty so interactive read prompts work.
if [ ! -t 0 ] && [ -e /dev/tty ]; then
    exec < /dev/tty
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
INSTALL_DIR="/opt/tillit"
DATA_DIR="/opt/tillit/data"
KEYS_DIR="/opt/tillit/keys"
TILLIT_USER="tillit"
NODE_VERSION="22"
REPO_RAW="https://raw.githubusercontent.com/tillit-cc/tillit/main"
ENV_SAMPLE=".env.selfhosted.sample"

# Default values
ENABLE_TUNNEL=false
ENABLE_TOR=false
TUNNEL_MODE="" # quick, named
APP_PORT=3000

print_banner() {
    echo -e "${BLUE}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                                                           ║"
    echo "║        TilliT Self-Hosted Installer (Bare-Metal)          ║"
    echo "║                                                           ║"
    echo "║        End-to-End Encrypted Chat for Your Hardware        ║"
    echo "║                                                           ║"
    echo "╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
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
        Darwin)
            IS_MACOS=true; IS_LINUX=false
            OS_ID="macos"
            OS="macOS $(sw_vers -productVersion 2>/dev/null || echo '')"
            PKG_MANAGER="brew"
            PKG_UPDATE="brew update"
            PKG_INSTALL="brew install"
            log_info "Operating System: $OS"
            ;;
        *)
            IS_MACOS=false; IS_LINUX=true
            # Detect Linux distro
            if [ -f /etc/os-release ]; then
                . /etc/os-release
                OS=$NAME
                OS_ID=$ID
                OS_VERSION=$VERSION_ID
                log_info "Operating System: $OS $OS_VERSION"
            else
                log_warning "Cannot detect OS - proceeding with generic setup"
                OS_ID="unknown"
            fi

            case "$OS_ID" in
                debian|ubuntu|raspbian)
                    PKG_MANAGER="apt-get"
                    PKG_UPDATE="apt-get update"
                    PKG_INSTALL="apt-get install -y"
                    ;;
                fedora|centos|rhel)
                    PKG_MANAGER="dnf"
                    PKG_UPDATE="dnf check-update || true"
                    PKG_INSTALL="dnf install -y"
                    ;;
                *)
                    log_warning "Unknown package manager - assuming apt-get"
                    PKG_MANAGER="apt-get"
                    PKG_UPDATE="apt-get update"
                    PKG_INSTALL="apt-get install -y"
                    ;;
            esac
            ;;
    esac
}

sed_inplace() {
    if [ "$IS_MACOS" = true ]; then sed -i '' "$@"; else sed -i "$@"; fi
}

get_local_ip() {
    if [ "$IS_MACOS" = true ]; then
        ipconfig getifaddr en0 2>/dev/null ||
        ipconfig getifaddr en1 2>/dev/null ||
        ifconfig | grep 'inet ' | grep -v 127.0.0.1 | head -1 | awk '{print $2}' ||
        echo "localhost"
    else
        hostname -I | awk '{print $1}'
    fi
}

# --- End helpers ---

check_root() {
    if [ "$IS_MACOS" = true ]; then
        # macOS: running as current user is fine
        log_info "macOS detected — running as user $(whoami)"
    elif [ "$(id -u)" -ne 0 ]; then
        log_error "This script requires root on Linux. Re-run with:"
        echo "  sudo bash $0"
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
        armv7l)
            log_warning "Architecture: ARMv7 (32-bit) - may have limited support"
            ;;
        *)
            log_warning "Unknown architecture: $ARCH"
            ;;
    esac
}

install_dependencies() {
    log_info "Installing system dependencies..."

    if [ "$IS_MACOS" = true ]; then
        # Check Homebrew
        if ! command -v brew &> /dev/null; then
            log_error "Homebrew is required but not installed."
            echo ""
            echo "  Install with:"
            echo '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
            echo ""
            exit 1
        fi

        # Check Xcode CLI tools (required for native compilation, e.g. better-sqlite3)
        if ! xcode-select -p &> /dev/null; then
            log_info "Installing Xcode Command Line Tools..."
            xcode-select --install
            echo "  Please complete the Xcode CLI Tools installation and re-run this script."
            exit 1
        fi

        brew install openssl curl git 2>/dev/null || true
    else
        $PKG_UPDATE
        $PKG_INSTALL curl wget git openssl ca-certificates
    fi

    log_success "System dependencies installed"
}

install_nodejs() {
    if command -v node &> /dev/null; then
        CURRENT_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$CURRENT_VERSION" -ge "$NODE_VERSION" ]; then
            log_success "Node.js $(node -v) is already installed"
            return
        fi
    fi

    log_info "Installing Node.js $NODE_VERSION LTS..."

    if [ "$IS_MACOS" = true ]; then
        # macOS: prefer nvm, fallback to brew
        if command -v nvm &> /dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
            [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
            nvm install $NODE_VERSION
            nvm use $NODE_VERSION
        else
            log_info "Installing nvm..."
            curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            export NVM_DIR="$HOME/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
            nvm install $NODE_VERSION
            nvm use $NODE_VERSION
        fi
    elif [ "$OS_ID" = "debian" ] || [ "$OS_ID" = "ubuntu" ] || [ "$OS_ID" = "raspbian" ]; then
        # Linux Debian/Ubuntu: NodeSource
        curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
        $PKG_INSTALL nodejs
    else
        # Other Linux: nvm fallback
        if command -v nvm &> /dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
            [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
            nvm install $NODE_VERSION
            nvm use $NODE_VERSION
        else
            log_info "Installing nvm..."
            curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            export NVM_DIR="$HOME/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
            nvm install $NODE_VERSION
            nvm use $NODE_VERSION
        fi
    fi

    log_success "Node.js $(node -v) installed"
}

install_pnpm() {
    if command -v pnpm &> /dev/null; then
        log_success "pnpm is already installed"
        return
    fi

    log_info "Installing pnpm..."
    npm install -g pnpm@9
    log_success "pnpm installed"
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
        # Linux: download binary directly
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

create_user() {
    if [ "$IS_MACOS" = true ]; then
        # macOS: run as current user, no system user creation
        TILLIT_USER="$USER"
        log_info "macOS: using current user '$TILLIT_USER'"
        return
    fi

    if id "$TILLIT_USER" &>/dev/null; then
        log_success "User '$TILLIT_USER' already exists"
    else
        log_info "Creating system user '$TILLIT_USER'..."
        useradd --system --shell /bin/false --home-dir $INSTALL_DIR --create-home $TILLIT_USER
        log_success "User created"
    fi
}

create_directories() {
    # On macOS without root, fallback to ~/tillit
    if [ "$IS_MACOS" = true ] && [ "$(id -u)" -ne 0 ] && [ ! -w "$(dirname "$INSTALL_DIR")" ]; then
        INSTALL_DIR="$HOME/tillit"
        DATA_DIR="$INSTALL_DIR/data"
        KEYS_DIR="$INSTALL_DIR/keys"
        log_info "Using user directory: $INSTALL_DIR"
    fi

    log_info "Creating directories..."

    mkdir -p $INSTALL_DIR
    mkdir -p $DATA_DIR
    mkdir -p $KEYS_DIR

    if [ "$IS_LINUX" = true ]; then
        chown -R $TILLIT_USER:$TILLIT_USER $INSTALL_DIR
    fi
    chmod 700 $KEYS_DIR

    log_success "Directories created"
}

download_release() {
    log_info "Downloading TilliT release..."

    cd $INSTALL_DIR

    # Download latest release from GitHub (when available)
    # For now, clone and build
    if [ -d "$INSTALL_DIR/src" ]; then
        log_warning "Source already exists - updating..."
        cd $INSTALL_DIR
        git pull
    else
        log_info "Cloning repository..."
        git clone --depth 1 https://github.com/tillit-cc/tillit.git $INSTALL_DIR/repo
        mv $INSTALL_DIR/repo/* $INSTALL_DIR/
        rm -rf $INSTALL_DIR/repo
    fi

    log_success "Source downloaded"
}

build_application() {
    log_info "Installing dependencies and building..."

    cd $INSTALL_DIR
    pnpm install --frozen-lockfile
    pnpm run build

    log_success "Application built"
}

generate_keys() {
    if [ -f "$KEYS_DIR/private.pem" ] && [ -f "$KEYS_DIR/public.pem" ]; then
        log_success "RSA keys already exist"
        return
    fi

    log_info "Generating RSA keys for JWT authentication..."

    # Generate 4096-bit RSA private key
    openssl genpkey -algorithm RSA -out "$KEYS_DIR/private.pem" -pkeyopt rsa_keygen_bits:4096

    # Extract public key
    openssl rsa -pubout -in "$KEYS_DIR/private.pem" -out "$KEYS_DIR/public.pem"

    # Set proper permissions
    chmod 600 "$KEYS_DIR/private.pem"
    chmod 644 "$KEYS_DIR/public.pem"
    if [ "$IS_LINUX" = true ]; then
        chown $TILLIT_USER:$TILLIT_USER "$KEYS_DIR/private.pem" "$KEYS_DIR/public.pem"
    fi

    log_success "RSA keys generated"
}

configure_network() {
    echo ""
    echo -e "${YELLOW}=== Network Configuration ===${NC}"
    echo ""
    echo "How do you want to access TilliT?"
    echo ""
    echo "  1) Tor hidden service (recommended) - plug & play, anonymous .onion address"
    echo "     Zero configuration. The TilliT app connects natively."
    echo "  2) Cloudflare Tunnel - no port forwarding needed"
    echo "     Quick tunnel for testing or named tunnel for production."
    echo "  3) HTTP only (port 3000) - for local network or behind existing proxy"
    echo ""

    read -p "Select option [1]: " network_option
    network_option=${network_option:-1}

    case "$network_option" in
        2)
            ENABLE_TUNNEL=true
            configure_tunnel_mode
            ;;
        3)
            read -p "HTTP port [3000]: " http_port_input
            APP_PORT=${http_port_input:-3000}
            log_success "HTTP enabled on port $APP_PORT"
            ;;
        *)
            ENABLE_TOR=true
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
    echo ""

    read -p "Select option [1]: " tunnel_option
    tunnel_option=${tunnel_option:-1}

    case "$tunnel_option" in
        2)
            TUNNEL_MODE="named"
            ;;
        *)
            TUNNEL_MODE="quick"
            ;;
    esac
}

setup_quick_tunnel() {
    log_info "Setting up quick tunnel..."
    install_cloudflared

    log_info "Starting cloudflared quick tunnel..."
    echo ""
    echo -e "${YELLOW}Starting quick tunnel - this will display the temporary URL below.${NC}"
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
        echo -e "  For a permanent URL, re-run with a named tunnel (option 2)."
    else
        log_warning "Could not detect tunnel URL - cloudflared may still be starting"
        log_info "Check logs: cat $tunnel_log"
        QUICK_TUNNEL_PID=$cf_pid
    fi

    # Install as persistent service
    if [ "$IS_MACOS" = true ]; then
        install_cloudflared_launchd "quick"
    else
        install_cloudflared_systemd "quick"
    fi
}

setup_named_tunnel() {
    log_info "Setting up named Cloudflare Tunnel..."
    install_cloudflared

    echo ""
    echo -e "${BLUE}This will guide you through creating a named Cloudflare Tunnel.${NC}"
    echo -e "${BLUE}You'll need a Cloudflare account with a domain.${NC}"
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
        read -p "Enter your tunnel ID (or press Enter to list tunnels): " tunnel_id
        if [ -z "$tunnel_id" ]; then
            cloudflared tunnel list
            echo ""
            read -p "Enter tunnel ID from the list above: " tunnel_id
        fi
    fi

    # Step 3: Route DNS
    echo ""
    echo -e "${YELLOW}Step 3: Configure DNS route${NC}"
    read -p "Enter your domain (e.g., chat.yourdomain.com): " tunnel_domain

    if [ -n "$tunnel_domain" ]; then
        cloudflared tunnel route dns tillit "$tunnel_domain"
        log_success "DNS route created: $tunnel_domain -> tunnel 'tillit'"
        TUNNEL_DOMAIN="$tunnel_domain"
    fi

    # Step 4: Create config file
    echo ""
    echo -e "${YELLOW}Step 4: Creating cloudflared configuration${NC}"

    local cf_config_dir
    if [ "$IS_MACOS" = true ]; then
        cf_config_dir="$HOME/.cloudflared"
    else
        cf_config_dir="/etc/cloudflared"
        mkdir -p "$cf_config_dir"
    fi

    # Determine credentials file location
    local cred_file
    if [ "$IS_MACOS" = true ]; then
        cred_file="$HOME/.cloudflared/${tunnel_id}.json"
    else
        cred_file="/root/.cloudflared/${tunnel_id}.json"
        # Copy credentials to system config dir if running as root
        if [ -f "/root/.cloudflared/${tunnel_id}.json" ] && [ "$cf_config_dir" != "/root/.cloudflared" ]; then
            cp "/root/.cloudflared/${tunnel_id}.json" "$cf_config_dir/"
            cred_file="$cf_config_dir/${tunnel_id}.json"
        fi
    fi

    cat > "$cf_config_dir/config.yml" << EOF
tunnel: tillit
credentials-file: $cred_file

ingress:
  - hostname: ${tunnel_domain}
    service: http://localhost:${APP_PORT}
  - service: http_status:404
EOF

    log_success "cloudflared config written to $cf_config_dir/config.yml"

    # Step 5: Install as service
    echo ""
    echo -e "${YELLOW}Step 5: Installing cloudflared as a service${NC}"

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

install_tor() {
    if command -v tor &>/dev/null; then
        log_success "Tor is already installed"
        return
    fi

    log_info "Installing Tor..."

    if [ "$IS_MACOS" = true ]; then
        if command -v brew &>/dev/null; then
            brew install tor
        else
            log_error "Homebrew is required to install Tor on macOS"
            exit 1
        fi
    else
        $PKG_UPDATE
        $PKG_INSTALL tor
    fi

    if command -v tor &>/dev/null; then
        log_success "Tor installed: $(tor --version | head -1)"
    else
        log_error "Failed to install Tor"
        exit 1
    fi
}

setup_tor_hidden_service() {
    log_info "Setting up Tor hidden service..."

    local tor_data_dir="/var/lib/tor/tillit_hidden_service"

    if [ "$IS_MACOS" = true ]; then
        tor_data_dir="$HOME/.tor/tillit_hidden_service"
        mkdir -p "$tor_data_dir"
        chmod 700 "$tor_data_dir"
    else
        mkdir -p "$tor_data_dir"
        chown debian-tor:debian-tor "$tor_data_dir"
        chmod 700 "$tor_data_dir"
    fi

    # Configure torrc
    local torrc="/etc/tor/torrc"
    if [ "$IS_MACOS" = true ]; then
        torrc="$(brew --prefix)/etc/tor/torrc"
    fi

    # Check if already configured
    if grep -q "tillit_hidden_service" "$torrc" 2>/dev/null; then
        log_info "Tor hidden service already configured in torrc"
    else
        # Backup torrc before modifying
        cp "$torrc" "${torrc}.bak.$(date +%s)" 2>/dev/null || true
        log_info "Adding hidden service configuration to $torrc"
        cat >> "$torrc" << EOF

# TilliT Hidden Service
HiddenServiceDir $tor_data_dir
HiddenServicePort 80 127.0.0.1:$APP_PORT
ExitRelay 0
ExitPolicy reject *:*
EOF
    fi

    # Restart Tor
    if [ "$IS_MACOS" = true ]; then
        brew services restart tor 2>/dev/null || tor &
    else
        systemctl enable tor
        systemctl restart tor
    fi

    # Wait for .onion address
    log_info "Waiting for Tor to generate .onion address..."
    for i in {1..60}; do
        if [ -f "$tor_data_dir/hostname" ]; then
            ONION_ADDRESS=$(cat "$tor_data_dir/hostname" | tr -d '[:space:]')
            log_success "Tor hidden service ready: http://$ONION_ADDRESS"
            return 0
        fi
        echo -n "."
        sleep 2
    done

    echo ""
    log_warning "Could not read .onion address yet — Tor may still be bootstrapping"
    log_info "Check later: cat $tor_data_dir/hostname"
}

configure_cloud_services() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║         TilliT Cloud Services             ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
    echo ""
    echo "TilliT Cloud provides:"
    echo "  - DDNS: automatic domain (your-id.tillit.cc)"
    echo "  - Push Notifications: via relay (no Expo token needed)"
    echo ""

    read -p "Enable TilliT Cloud services? (y/N): " enable_cloud_input
    if [ "$enable_cloud_input" = "y" ] || [ "$enable_cloud_input" = "Y" ]; then
        cloud_enabled=true
    else
        cloud_enabled=false
    fi

    if [ "$cloud_enabled" = true ]; then
        echo ""
        read -p "  Cloud ID (e.g., my-home-server): " CLOUD_ID
        read -p "  Cloud Token: " CLOUD_TOKEN
        echo ""

        # DDNS sub-option
        read -p "  Enable DDNS (automatic domain ${CLOUD_ID}.tillit.cc)? (Y/n): " enable_ddns_input
        enable_ddns_input=${enable_ddns_input:-Y}
        if [ "$enable_ddns_input" = "n" ] || [ "$enable_ddns_input" = "N" ]; then
            DDNS_ENABLED=false
        else
            DDNS_ENABLED=true
        fi

        # Push data mode
        echo ""
        echo "  Push notification data mode:"
        echo "    1) Privacy mode — generic \"New message\" (no metadata sent)"
        echo "    2) Detailed mode — include room/sender info (for quick navigation)"
        echo ""
        read -p "  Choose [1]: " push_data_option
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

configure_env() {
    if [ -f "$INSTALL_DIR/.env" ]; then
        log_warning ".env file already exists - keeping existing configuration"
        return
    fi

    log_info "Configuring TilliT..."

    # Download sample if building from source
    if [ -f "$INSTALL_DIR/$ENV_SAMPLE" ]; then
        cp "$INSTALL_DIR/$ENV_SAMPLE" "$INSTALL_DIR/.env"
    else
        curl -fsSL "$REPO_RAW/$ENV_SAMPLE" -o "$INSTALL_DIR/.env"
    fi

    # Update paths for bare-metal
    sed_inplace "s|SQLITE_DATA_DIR=/app/data|SQLITE_DATA_DIR=$DATA_DIR|" "$INSTALL_DIR/.env"
    sed_inplace "s|KEYS_DIR=/app/keys|KEYS_DIR=$KEYS_DIR|" "$INSTALL_DIR/.env"

    # Skip cloud services config if tunnel or tor mode is selected
    if [ "$ENABLE_TOR" = true ]; then
        log_info "Tor mode — cloud services skipped (maximum privacy)"
    elif [ "$ENABLE_TUNNEL" != true ]; then
        configure_cloud_services

        # Apply cloud settings to .env
        if [ -n "$CLOUD_ID" ] && [ "$CLOUD_ID" != "your-box-id" ]; then
            sed_inplace "s/CLOUD_ID=your-box-id/CLOUD_ID=$CLOUD_ID/" "$INSTALL_DIR/.env"
            sed_inplace "s/CLOUD_TOKEN=your-box-token/CLOUD_TOKEN=$CLOUD_TOKEN/" "$INSTALL_DIR/.env"
        fi
        if [ "$DDNS_ENABLED" = true ]; then
            sed_inplace "s/DDNS_ENABLED=false/DDNS_ENABLED=true/" "$INSTALL_DIR/.env"
        fi
        if [ "$PUSH_INCLUDE_DATA" = true ]; then
            sed_inplace "s/PUSH_INCLUDE_DATA=false/PUSH_INCLUDE_DATA=true/" "$INSTALL_DIR/.env"
        fi
    fi

    if [ "$IS_LINUX" = true ]; then
        chown $TILLIT_USER:$TILLIT_USER "$INSTALL_DIR/.env"
    fi
    chmod 600 "$INSTALL_DIR/.env"

    log_success "Configuration saved"
}

install_service() {
    if [ "$IS_MACOS" = true ]; then
        install_launchd_service
    else
        install_systemd_service
    fi
}

install_systemd_service() {
    log_info "Installing systemd service..."

    cat > /etc/systemd/system/tillit.service << EOF
[Unit]
Description=TilliT Chat Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$TILLIT_USER
Group=$TILLIT_USER
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$INSTALL_DIR/.env
Environment=DEPLOYMENT_MODE=selfhosted
Environment=NODE_ENV=production
Environment=SQLITE_DATA_DIR=$DATA_DIR
Environment=KEYS_DIR=$KEYS_DIR
Environment=PRIVATE_KEY_PATH=$KEYS_DIR/private.pem
Environment=PUBLIC_KEY_PATH=$KEYS_DIR/public.pem
ExecStart=/usr/bin/node $INSTALL_DIR/dist/main.js
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR $KEYS_DIR
PrivateTmp=true

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
    local plist_file="$plist_dir/cc.tillit.server.plist"
    local node_bin
    node_bin=$(command -v node)

    mkdir -p "$plist_dir"

    cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>cc.tillit.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$node_bin</string>
        <string>$INSTALL_DIR/dist/main.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>DEPLOYMENT_MODE</key>
        <string>selfhosted</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>SQLITE_DATA_DIR</key>
        <string>$DATA_DIR</string>
        <key>KEYS_DIR</key>
        <string>$KEYS_DIR</string>
        <key>PRIVATE_KEY_PATH</key>
        <string>$KEYS_DIR/private.pem</string>
        <key>PUBLIC_KEY_PATH</key>
        <string>$KEYS_DIR/public.pem</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$INSTALL_DIR/tillit.log</string>
    <key>StandardErrorPath</key>
    <string>$INSTALL_DIR/tillit.log</string>
</dict>
</plist>
EOF

    launchctl load "$plist_file" 2>/dev/null || true

    log_success "launchd service installed: $plist_file"
}

start_service() {
    log_info "Starting TilliT service..."

    if [ "$IS_MACOS" = true ]; then
        launchctl start cc.tillit.server 2>/dev/null || true
        sleep 3
        log_success "TilliT service started"
    else
        systemctl start tillit.service

        # Wait for startup
        sleep 3

        if systemctl is-active --quiet tillit.service; then
            log_success "TilliT service started"
        else
            log_error "Service failed to start - check: journalctl -u tillit.service"
            exit 1
        fi
    fi
}

wait_for_health() {
    log_info "Waiting for TilliT to be ready..."

    for i in {1..30}; do
        if curl -sf http://localhost:$APP_PORT/health > /dev/null 2>&1; then
            log_success "TilliT is running!"
            return 0
        fi
        echo -n "."
        sleep 2
    done

    echo ""
    if [ "$IS_MACOS" = true ]; then
        log_warning "Health check timeout - check: tail -f $INSTALL_DIR/tillit.log"
    else
        log_warning "Health check timeout - check: journalctl -u tillit.service -f"
    fi
}

print_summary() {
    LOCAL_IP=$(get_local_ip)

    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║           TilliT Installation Complete!                   ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "  ${BLUE}Installation directory:${NC} $INSTALL_DIR"
    echo -e "  ${BLUE}Data directory:${NC} $DATA_DIR"
    echo -e "  ${BLUE}Keys directory:${NC} $KEYS_DIR"
    echo -e "  ${BLUE}Local access:${NC} http://$LOCAL_IP:$APP_PORT"
    echo -e "  ${BLUE}Health check:${NC} http://$LOCAL_IP:$APP_PORT/health"

    if [ "$ENABLE_TOR" = true ]; then
        echo ""
        if [ -n "${ONION_ADDRESS:-}" ]; then
            echo -e "  ${GREEN}Onion URL:${NC} http://$ONION_ADDRESS"
        else
            echo -e "  ${YELLOW}Onion URL:${NC} pending (Tor still bootstrapping)"
        fi
        echo -e "  ${YELLOW}Note:${NC} The TilliT app connects natively (built-in Tor support)."
    elif [ "$ENABLE_TUNNEL" = true ]; then
        echo ""
        if [ "$TUNNEL_MODE" = "quick" ] && [ -n "$QUICK_TUNNEL_URL" ]; then
            echo -e "  ${GREEN}Quick tunnel:${NC} $QUICK_TUNNEL_URL"
            echo -e "  ${YELLOW}Note:${NC} This URL is temporary and changes on restart."
            echo -e "        For a permanent URL, re-run with a named tunnel (option 2)."
        elif [ "$TUNNEL_MODE" = "named" ] && [ -n "$TUNNEL_DOMAIN" ]; then
            echo -e "  ${GREEN}Tunnel domain:${NC} https://$TUNNEL_DOMAIN"
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

    if grep -q "DDNS_ENABLED=true" "$INSTALL_DIR/.env" 2>/dev/null; then
        BOX_ID=$(grep "CLOUD_ID=" "$INSTALL_DIR/.env" | cut -d'=' -f2)
        echo -e "  ${GREEN}DDNS enabled:${NC} https://$BOX_ID.tillit.cc"
        echo ""
    fi

    echo -e "  ${BLUE}Connect your TilliT mobile app to:${NC}"
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
        else
            echo -e "    ${GREEN}http://$LOCAL_IP:$APP_PORT${NC}"
        fi
    else
        echo -e "    ${GREEN}http://$LOCAL_IP:$APP_PORT${NC}"
    fi
    echo ""
}

# Main installation flow
main() {
    print_banner
    detect_os
    check_root
    check_architecture
    install_dependencies
    install_nodejs
    install_pnpm
    create_user
    create_directories
    configure_network
    download_release
    build_application
    generate_keys
    configure_env
    install_service
    start_service
    wait_for_health

    # Post-start: setup tunnel or tor if selected
    if [ "$ENABLE_TOR" = true ]; then
        install_tor
        setup_tor_hidden_service
    elif [ "$ENABLE_TUNNEL" = true ]; then
        if [ "$TUNNEL_MODE" = "quick" ]; then
            setup_quick_tunnel
        elif [ "$TUNNEL_MODE" = "named" ]; then
            setup_named_tunnel
        fi
    fi

    install_cli
    print_summary
}

install_cli() {
    log_info "Installing tillit CLI..."

    local cli_src="$INSTALL_DIR/scripts/tillit-cli.sh"

    if [ ! -f "$cli_src" ]; then
        log_warning "CLI script not found at $cli_src — skipping"
        return 0
    fi
    chmod +x "$cli_src"

    # Symlink to PATH
    if [ "$IS_MACOS" = true ] && [ "$(id -u)" -ne 0 ]; then
        mkdir -p "$HOME/.local/bin"
        ln -sf "$cli_src" "$HOME/.local/bin/tillit"
        if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
            log_warning "Add ~/.local/bin to your PATH for 'tillit' command"
        fi
    else
        ln -sf "$cli_src" /usr/local/bin/tillit
    fi

    log_success "tillit CLI installed (run 'tillit help' for usage)"
}

main "$@"
