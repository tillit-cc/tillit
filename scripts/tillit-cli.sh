#!/bin/bash
#
# TilliT CLI — Management tool for TilliT self-hosted servers
#
# Usage:
#   tillit <command> [options]
#
# Commands:
#   start                  Start the service
#   stop                   Stop the service
#   restart                Restart the service
#   status                 Show service status and health info
#   logs [-f] [-n N]       View logs (default: follow mode)
#   config                 Interactive configuration menu
#   config list            Show all settings
#   config get <KEY>       Read a configuration value
#   config set KEY=VALUE   Set a configuration value
#   onion                  Show .onion address (Tor mode only)
#   update                 Update to the latest version
#   help                   Show this help message
#   version                Show CLI version
#
set -euo pipefail

CLI_VERSION="1.0.0"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ──────────────────────────────────────────────
# Auto-detection
# ──────────────────────────────────────────────

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
    if [ "$IS_MACOS" = true ]; then
        ipconfig getifaddr en0 2>/dev/null ||
        ipconfig getifaddr en1 2>/dev/null ||
        ifconfig | grep 'inet ' | grep -v 127.0.0.1 | head -1 | awk '{print $2}' ||
        echo "localhost"
    else
        hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost"
    fi
}

detect_install_dir() {
    if [ -n "${TILLIT_DIR:-}" ] && [ -d "$TILLIT_DIR" ]; then
        INSTALL_DIR="$TILLIT_DIR"
    elif [ -d "/opt/tillit" ]; then
        INSTALL_DIR="/opt/tillit"
    elif [ -d "$HOME/tillit" ]; then
        INSTALL_DIR="$HOME/tillit"
    else
        echo -e "${RED}Error: TilliT installation not found.${NC}"
        echo ""
        echo "  Looked in:"
        echo "    - \$TILLIT_DIR (not set)"
        echo "    - /opt/tillit"
        echo "    - ~/tillit"
        echo ""
        echo "  Install TilliT first:"
        if [ "$IS_MACOS" = true ]; then
            echo "    curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | bash"
        else
            echo "    curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/install.sh | sudo bash"
        fi
        exit 1
    fi
}

detect_deploy_mode() {
    local strict="${1:-true}"
    # Docker mode: compose file present
    if find_compose_file >/dev/null 2>&1; then
        DEPLOY_MODE="docker"
    elif [ -f "$INSTALL_DIR/dist/main.js" ]; then
        DEPLOY_MODE="bare"
    elif [ "$strict" = "true" ]; then
        echo -e "${RED}Error: Cannot detect deployment mode in $INSTALL_DIR${NC}"
        echo "  No docker-compose file or dist/main.js found."
        exit 1
    else
        DEPLOY_MODE="unknown"
    fi
}

find_compose_file() {
    # Check for compose files in priority order
    for f in "docker-compose.yml" "docker-compose.yaml" "docker-compose.selfhosted.yml" "docker-compose.https.yml" "docker-compose.tunnel.yml" "docker-compose.tor.yml"; do
        if [ -f "$INSTALL_DIR/$f" ]; then
            echo "$f"
            return 0
        fi
    done
    return 1
}

get_health_port() {
    local port
    port=$(env_get "APP_PORT") || true
    echo "${port:-3000}"
}

is_https_mode() {
    local domain
    domain=$(env_get "DOMAIN") || true
    [ -n "$domain" ] && [ -n "$(env_get "HTTPS_PORT" 2>/dev/null)" ]
}

is_tor_mode() {
    local compose_file
    compose_file=$(find_compose_file 2>/dev/null) || true
    # Check if compose file references tor service or if torrc exists
    if [ -n "$compose_file" ] && grep -qE "Dockerfile\.tor|docker-compose\.tor" "$INSTALL_DIR/$compose_file" 2>/dev/null; then
        return 0
    fi
    # Bare-metal: check if tor hidden service is configured
    if grep -q "tillit_hidden_service" /etc/tor/torrc 2>/dev/null; then
        return 0
    fi
    return 1
}

get_onion_address() {
    # Docker mode: read from tor container
    local compose_file
    compose_file=$(find_compose_file 2>/dev/null) || true
    if [ -n "$compose_file" ] && [ "$DEPLOY_MODE" = "docker" ]; then
        docker compose -f "$INSTALL_DIR/$compose_file" exec -T tor cat /var/lib/tor/hidden_service/hostname 2>/dev/null | tr -d '[:space:]'
        return
    fi
    # Bare-metal: read from filesystem
    for dir in "/var/lib/tor/tillit_hidden_service" "$HOME/.tor/tillit_hidden_service"; do
        if [ -f "$dir/hostname" ]; then
            cat "$dir/hostname" | tr -d '[:space:]'
            return
        fi
    done
}

# Health check via docker exec + node (used when port is not exposed to host)
docker_health_check() {
    local compose_file
    compose_file=$(find_compose_file) || return 1
    docker compose -f "$INSTALL_DIR/$compose_file" exec -T tillit \
        node -e "require('http').get('http://localhost:3000/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{process.stdout.write(d);process.exit(r.statusCode===200?0:1)})}).on('error',()=>process.exit(1))" 2>/dev/null
}

# ──────────────────────────────────────────────
# .env helpers
# ──────────────────────────────────────────────

env_get() {
    local key="$1"
    if [ ! -f "$INSTALL_DIR/.env" ]; then
        return 1
    fi
    grep "^${key}=" "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d'=' -f2-
}

env_set() {
    local key="$1"
    local value="$2"

    if [ ! -f "$INSTALL_DIR/.env" ]; then
        echo -e "${RED}Error: .env file not found at $INSTALL_DIR/.env${NC}"
        return 1
    fi

    # Use | as sed delimiter to handle URLs and special chars
    if grep -q "^${key}=" "$INSTALL_DIR/.env" 2>/dev/null; then
        sed_inplace "s|^${key}=.*|${key}=${value}|" "$INSTALL_DIR/.env"
    elif grep -q "^# *${key}=" "$INSTALL_DIR/.env" 2>/dev/null; then
        # Uncomment and set
        sed_inplace "s|^# *${key}=.*|${key}=${value}|" "$INSTALL_DIR/.env"
    else
        # Append
        echo "${key}=${value}" >> "$INSTALL_DIR/.env"
    fi
}

is_sensitive() {
    local key="$1"
    case "$key" in
        *TOKEN*|*SECRET*|*PASSWORD*|*KEY*|*PRIVATE*) return 0 ;;
        *) return 1 ;;
    esac
}

mask_value() {
    local value="$1"
    local len=${#value}
    if [ "$len" -le 4 ]; then
        echo "****"
    elif [ "$len" -le 8 ]; then
        echo "${value:0:2}****"
    else
        echo "${value:0:4}****${value: -4}"
    fi
}

# Simple JSON value getter (no jq dependency)
json_get() {
    local json="$1"
    local key="$2"
    if command -v jq &>/dev/null; then
        echo "$json" | jq -r ".$key // empty" 2>/dev/null
    else
        # Fallback: grep/sed for simple flat JSON
        echo "$json" | grep -o "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/' ||
        echo "$json" | grep -o "\"${key}\"[[:space:]]*:[[:space:]]*[0-9.]*" | head -1 | sed 's/.*: *//'
    fi
}

format_uptime() {
    local seconds="$1"
    # Remove decimal part if present
    seconds=${seconds%.*}
    local days=$((seconds / 86400))
    local hours=$(( (seconds % 86400) / 3600 ))
    local minutes=$(( (seconds % 3600) / 60 ))
    local secs=$((seconds % 60))

    local result=""
    [ "$days" -gt 0 ] && result="${days}d "
    [ "$hours" -gt 0 ] && result="${result}${hours}h "
    [ "$minutes" -gt 0 ] && result="${result}${minutes}m "
    result="${result}${secs}s"
    echo "$result"
}

# ──────────────────────────────────────────────
# Service functions
# ──────────────────────────────────────────────

service_start() {
    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file)
        cd "$INSTALL_DIR" && docker compose -f "$compose_file" up -d
    elif [ "$IS_LINUX" = true ]; then
        sudo systemctl start tillit
    else
        launchctl start cc.tillit.server 2>/dev/null || true
    fi
}

service_stop() {
    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file)
        cd "$INSTALL_DIR" && docker compose -f "$compose_file" down
    elif [ "$IS_LINUX" = true ]; then
        sudo systemctl stop tillit
    else
        launchctl stop cc.tillit.server 2>/dev/null || true
    fi
}

service_restart() {
    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file)
        cd "$INSTALL_DIR" && docker compose -f "$compose_file" restart
    elif [ "$IS_LINUX" = true ]; then
        sudo systemctl restart tillit
    else
        launchctl stop cc.tillit.server 2>/dev/null || true
        sleep 1
        launchctl start cc.tillit.server 2>/dev/null || true
    fi
}

is_service_running() {
    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file) || return 1
        docker ps --filter name=tillit --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q "tillit" && return 0
        return 1
    elif [ "$IS_LINUX" = true ]; then
        systemctl is-active --quiet tillit 2>/dev/null
    else
        # macOS launchd: check if the job is loaded and has a PID
        local info
        info=$(launchctl list 2>/dev/null | grep "cc.tillit.server") || return 1
        local pid
        pid=$(echo "$info" | awk '{print $1}')
        [ "$pid" != "-" ] && [ -n "$pid" ] && return 0
        return 1
    fi
}

prompt_restart() {
    echo ""
    read -p "Restart required for changes to take effect. Restart now? (y/N): " answer
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        echo ""
        cmd_restart
    else
        echo -e "${YELLOW}Changes will take effect after next restart.${NC}"
    fi
}

# ──────────────────────────────────────────────
# Commands
# ──────────────────────────────────────────────

cmd_start() {
    echo -e "${BLUE}Starting TilliT...${NC}"
    service_start
    echo -e "${GREEN}TilliT started.${NC}"
}

cmd_stop() {
    echo -e "${YELLOW}Stopping TilliT...${NC}"
    service_stop
    echo -e "TilliT stopped."
}

cmd_restart() {
    echo -e "${BLUE}Restarting TilliT...${NC}"
    service_restart
    echo -e "${GREEN}TilliT restarted.${NC}"
}

cmd_status() {
    local running="false"
    local deploy_label

    if [ "$DEPLOY_MODE" = "docker" ]; then
        deploy_label="Docker"
    else
        deploy_label="Bare-metal"
    fi

    if is_service_running; then
        running="true"
    fi

    echo ""
    echo -e "  ${BOLD}TilliT Status${NC}"
    echo "  ============="

    if [ "$running" = "true" ]; then
        echo -e "  Service:     ${GREEN}running${NC} ($deploy_label)"
    else
        echo -e "  Service:     ${RED}stopped${NC} ($deploy_label)"
        echo -e "  Install Dir: $INSTALL_DIR"
        echo ""
        return 0
    fi

    # Health check
    local health_json
    if is_https_mode && [ "$DEPLOY_MODE" = "docker" ]; then
        # HTTPS mode: port not exposed to host, check via docker exec
        health_json=$(docker_health_check) || true
    else
        local port
        port=$(get_health_port)
        health_json=$(curl -sf --max-time 3 "http://localhost:$port/health" 2>/dev/null) || true
    fi

    if [ -n "$health_json" ]; then
        local h_status h_version h_mode h_db h_uptime

        h_status=$(json_get "$health_json" "status")
        h_version=$(json_get "$health_json" "version")
        h_mode=$(json_get "$health_json" "mode")
        h_db=$(json_get "$health_json" "database")
        h_uptime=$(json_get "$health_json" "uptime")

        if [ "$h_status" = "ok" ]; then
            echo -e "  Health:      ${GREEN}ok${NC}"
        else
            echo -e "  Health:      ${RED}${h_status:-unknown}${NC}"
        fi

        [ -n "$h_version" ] && echo -e "  Version:     $h_version"
        [ -n "$h_mode" ] && echo -e "  Mode:        $h_mode"
        [ -n "$h_db" ] && echo -e "  Database:    $h_db"

        if [ -n "$h_uptime" ]; then
            local uptime_fmt
            uptime_fmt=$(format_uptime "$h_uptime")
            echo -e "  Uptime:      $uptime_fmt"
        fi
    else
        if is_https_mode; then
            echo -e "  Health:      ${YELLOW}unreachable${NC} (via docker exec)"
        else
            echo -e "  Health:      ${YELLOW}unreachable${NC} (port $(get_health_port))"
        fi
    fi

    echo -e "  Install Dir: $INSTALL_DIR"

    # URLs
    local cloud_id ddns_enabled domain
    cloud_id=$(env_get "CLOUD_ID") || true
    ddns_enabled=$(env_get "DDNS_ENABLED") || true
    domain=$(env_get "DOMAIN") || true

    if is_https_mode; then
        # HTTPS mode: show HTTPS URL as primary, no local HTTP URL
        local https_port
        https_port=$(env_get "HTTPS_PORT") || true
        if [ "$https_port" = "443" ] || [ -z "$https_port" ]; then
            echo -e "  URL:         https://$domain"
        else
            echo -e "  URL:         https://$domain:$https_port"
        fi
    else
        # HTTP mode: show local URL
        local local_ip
        local_ip=$(get_local_ip)
        local port_val
        port_val=$(get_health_port)
        echo -e "  Local URL:   http://${local_ip}:${port_val}"

        # DDNS URL
        if [ -n "$domain" ]; then
            local https_port
            https_port=$(env_get "HTTPS_PORT") || true
            if [ "$https_port" = "443" ] || [ -z "$https_port" ]; then
                echo -e "  DDNS URL:    https://$domain"
            else
                echo -e "  DDNS URL:    https://$domain:$https_port"
            fi
        elif [ "$ddns_enabled" = "true" ] && [ -n "$cloud_id" ] && [ "$cloud_id" != "your-box-id" ]; then
            echo -e "  DDNS URL:    https://${cloud_id}.tillit.cc"
        fi
    fi

    # Tor mode: show .onion address
    if is_tor_mode; then
        local onion_addr
        onion_addr=$(get_onion_address) || true
        if [ -n "$onion_addr" ]; then
            echo -e "  Onion URL:   ${GREEN}http://$onion_addr${NC}"
        else
            echo -e "  Onion URL:   ${YELLOW}pending (Tor bootstrapping)${NC}"
        fi
    fi

    # mDNS status
    local mdns_active=false
    if [ "$DEPLOY_MODE" = "docker" ]; then
        if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "tillit-mdns"; then
            mdns_active=true
        fi
    else
        if [ -f "/etc/avahi/services/tillit.service" ] && command -v avahi-daemon &>/dev/null; then
            mdns_active=true
        elif launchctl list cc.tillit.mdns &>/dev/null 2>&1; then
            mdns_active=true
        fi
    fi

    if [ "$mdns_active" = "true" ]; then
        echo -e "  mDNS:        ${GREEN}broadcasting _tillit._tcp${NC}"
    fi

    echo ""
}

cmd_logs() {
    local follow=true
    local lines=""

    # Parse options
    while [ $# -gt 0 ]; do
        case "$1" in
            -f|--follow)
                follow=true
                shift
                ;;
            -n|--lines)
                lines="$2"
                follow=false
                shift 2
                ;;
            -n*)
                lines="${1#-n}"
                follow=false
                shift
                ;;
            *)
                shift
                ;;
        esac
    done

    # Allow SIGINT to stop logs without exiting with error
    set +e

    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file)
        if [ -n "$lines" ] && [ "$follow" = true ]; then
            cd "$INSTALL_DIR" && docker compose -f "$compose_file" logs --tail "$lines" -f
        elif [ -n "$lines" ]; then
            cd "$INSTALL_DIR" && docker compose -f "$compose_file" logs --tail "$lines"
        elif [ "$follow" = true ]; then
            cd "$INSTALL_DIR" && docker compose -f "$compose_file" logs -f
        else
            cd "$INSTALL_DIR" && docker compose -f "$compose_file" logs
        fi
    elif [ "$IS_LINUX" = true ]; then
        if [ -n "$lines" ] && [ "$follow" = true ]; then
            journalctl -u tillit.service -n "$lines" -f
        elif [ -n "$lines" ]; then
            journalctl -u tillit.service -n "$lines"
        elif [ "$follow" = true ]; then
            journalctl -u tillit.service -f
        else
            journalctl -u tillit.service
        fi
    else
        # macOS bare-metal: log file
        local logfile="$INSTALL_DIR/tillit.log"
        if [ ! -f "$logfile" ]; then
            echo -e "${YELLOW}No log file found at $logfile${NC}"
            return 0
        fi
        if [ -n "$lines" ] && [ "$follow" = true ]; then
            tail -n "$lines" -f "$logfile"
        elif [ -n "$lines" ]; then
            tail -n "$lines" "$logfile"
        elif [ "$follow" = true ]; then
            tail -f "$logfile"
        else
            cat "$logfile"
        fi
    fi

    set -e
}

# ──────────────────────────────────────────────
# Config commands
# ──────────────────────────────────────────────

cmd_config_list() {
    if [ ! -f "$INSTALL_DIR/.env" ]; then
        echo -e "${RED}Error: .env file not found at $INSTALL_DIR/.env${NC}"
        return 1
    fi

    echo ""
    echo -e "  ${BOLD}TilliT Configuration${NC}"
    echo -e "  ${DIM}$INSTALL_DIR/.env${NC}"
    echo "  --------------------"

    while IFS= read -r line; do
        # Skip empty lines and comments
        [[ -z "$line" ]] && continue
        [[ "$line" =~ ^[[:space:]]*# ]] && { echo -e "  ${DIM}$line${NC}"; continue; }

        local key value
        key=$(echo "$line" | cut -d'=' -f1)
        value=$(echo "$line" | cut -d'=' -f2-)

        if is_sensitive "$key"; then
            local masked
            masked=$(mask_value "$value")
            echo -e "  ${BLUE}$key${NC}=$masked"
        else
            echo -e "  ${BLUE}$key${NC}=$value"
        fi
    done < "$INSTALL_DIR/.env"
    echo ""
}

cmd_config_get() {
    local key="$1"
    local value
    value=$(env_get "$key") || true

    if [ -z "$value" ]; then
        echo -e "${YELLOW}$key is not set${NC}"
        return 1
    fi

    if is_sensitive "$key"; then
        local masked
        masked=$(mask_value "$value")
        echo "$masked"
    else
        echo "$value"
    fi
}

cmd_config_set() {
    local input="$1"

    # Parse KEY=VALUE
    local key value
    key=$(echo "$input" | cut -d'=' -f1)
    value=$(echo "$input" | cut -d'=' -f2-)

    if [ -z "$key" ] || [ -z "$value" ]; then
        echo -e "${RED}Usage: tillit config set KEY=VALUE${NC}"
        return 1
    fi

    local old_value
    old_value=$(env_get "$key") || true

    env_set "$key" "$value"

    if [ -n "$old_value" ]; then
        echo -e "${GREEN}Updated:${NC} $key"
        if is_sensitive "$key"; then
            echo -e "  ${DIM}$(mask_value "$old_value")${NC} -> ${DIM}$(mask_value "$value")${NC}"
        else
            echo -e "  ${DIM}$old_value${NC} -> $value"
        fi
    else
        echo -e "${GREEN}Set:${NC} $key=$value"
    fi

    prompt_restart
}

cmd_config_interactive() {
    local CHANGES_MADE=false

    while true; do
        echo ""
        echo -e "  ${BOLD}TilliT Configuration${NC}"
        echo "  --------------------"
        echo "  1) Cloud Services (DDNS, Push, Worker)"
        echo "  2) Network (Port, HTTPS)"
        echo "  3) Logging"
        echo "  4) Other Settings"
        echo "  5) Show all (config list)"
        echo "  0) Exit"
        echo ""
        read -p "  Select: " choice

        case "$choice" in
            1) config_menu_cloud ;;
            2) config_menu_network ;;
            3) config_menu_logging ;;
            4) config_menu_other ;;
            5) cmd_config_list ;;
            0|"")
                if [ "$CHANGES_MADE" = true ]; then
                    prompt_restart
                fi
                return 0
                ;;
            *) echo -e "  ${RED}Invalid option${NC}" ;;
        esac
    done
}

config_menu_cloud() {
    while true; do
        local cloud_id cloud_token ddns_enabled ddns_interval push_data worker_url
        cloud_id=$(env_get "CLOUD_ID") || true
        cloud_token=$(env_get "CLOUD_TOKEN") || true
        ddns_enabled=$(env_get "DDNS_ENABLED") || true
        ddns_interval=$(env_get "DDNS_UPDATE_INTERVAL") || true
        push_data=$(env_get "PUSH_INCLUDE_DATA") || true
        worker_url=$(env_get "CLOUD_WORKER_URL") || true

        echo ""
        echo -e "  ${BOLD}Cloud Services${NC}"
        echo "  ─────────────"
        echo -e "  1) Cloud ID:           ${BLUE}${cloud_id:-not set}${NC}"
        echo -e "  2) Cloud Token:        ${BLUE}$([ -n "$cloud_token" ] && mask_value "$cloud_token" || echo "not set")${NC}"
        echo -e "  3) DDNS Enabled:       ${BLUE}${ddns_enabled:-false}${NC}"
        echo -e "  4) DDNS Interval (ms): ${BLUE}${ddns_interval:-300000}${NC}"
        echo -e "  5) Push Data Mode:     ${BLUE}${push_data:-false}${NC}"
        echo -e "  6) Worker URL:         ${BLUE}${worker_url:-https://worker.tillit.cc}${NC}"
        echo "  0) Back"
        echo ""
        read -p "  Select: " choice

        case "$choice" in
            1)
                read -p "  Cloud ID: " val
                [ -n "$val" ] && { env_set "CLOUD_ID" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            2)
                read -p "  Cloud Token: " val
                [ -n "$val" ] && { env_set "CLOUD_TOKEN" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            3)
                if [ "$ddns_enabled" = "true" ]; then
                    env_set "DDNS_ENABLED" "false"
                    echo -e "  ${GREEN}DDNS disabled${NC}"
                else
                    env_set "DDNS_ENABLED" "true"
                    echo -e "  ${GREEN}DDNS enabled${NC}"
                fi
                CHANGES_MADE=true
                ;;
            4)
                read -p "  DDNS Update Interval (ms) [${ddns_interval:-300000}]: " val
                [ -n "$val" ] && { env_set "DDNS_UPDATE_INTERVAL" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            5)
                if [ "$push_data" = "true" ]; then
                    env_set "PUSH_INCLUDE_DATA" "false"
                    echo -e "  ${GREEN}Push data mode: privacy (generic notifications)${NC}"
                else
                    env_set "PUSH_INCLUDE_DATA" "true"
                    echo -e "  ${GREEN}Push data mode: detailed (includes room/sender info)${NC}"
                fi
                CHANGES_MADE=true
                ;;
            6)
                read -p "  Worker URL [${worker_url:-https://worker.tillit.cc}]: " val
                [ -n "$val" ] && { env_set "CLOUD_WORKER_URL" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            0|"") return 0 ;;
            *) echo -e "  ${RED}Invalid option${NC}" ;;
        esac
    done
}

config_menu_network() {
    while true; do
        local app_port domain https_port http_port
        app_port=$(env_get "APP_PORT") || true
        domain=$(env_get "DOMAIN") || true
        https_port=$(env_get "HTTPS_PORT") || true
        http_port=$(env_get "HTTP_PORT") || true

        echo ""
        echo -e "  ${BOLD}Network${NC}"
        echo "  ───────"
        echo -e "  1) APP_PORT:    ${BLUE}${app_port:-3000}${NC}"
        echo -e "  2) DOMAIN:      ${BLUE}${domain:-not set}${NC}"
        echo -e "  3) HTTPS_PORT:  ${BLUE}${https_port:-not set}${NC}"
        echo -e "  4) HTTP_PORT:   ${BLUE}${http_port:-not set}${NC}"
        echo "  0) Back"
        echo ""
        read -p "  Select: " choice

        case "$choice" in
            1)
                read -p "  APP_PORT [${app_port:-3000}]: " val
                [ -n "$val" ] && { env_set "APP_PORT" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            2)
                read -p "  DOMAIN [${domain:-}]: " val
                [ -n "$val" ] && { env_set "DOMAIN" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            3)
                read -p "  HTTPS_PORT [${https_port:-443}]: " val
                [ -n "$val" ] && { env_set "HTTPS_PORT" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            4)
                read -p "  HTTP_PORT [${http_port:-80}]: " val
                [ -n "$val" ] && { env_set "HTTP_PORT" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            0|"") return 0 ;;
            *) echo -e "  ${RED}Invalid option${NC}" ;;
        esac
    done
}

config_menu_logging() {
    while true; do
        local log_level
        log_level=$(env_get "LOG_LEVEL") || true

        echo ""
        echo -e "  ${BOLD}Logging${NC}"
        echo "  ───────"
        echo -e "  Current LOG_LEVEL: ${BLUE}${log_level:-info}${NC}"
        echo ""
        echo "  1) debug"
        echo "  2) info"
        echo "  3) warn"
        echo "  4) error"
        echo "  0) Back"
        echo ""
        read -p "  Select: " choice

        case "$choice" in
            1) env_set "LOG_LEVEL" "debug"; CHANGES_MADE=true; echo -e "  ${GREEN}Set LOG_LEVEL=debug${NC}" ;;
            2) env_set "LOG_LEVEL" "info"; CHANGES_MADE=true; echo -e "  ${GREEN}Set LOG_LEVEL=info${NC}" ;;
            3) env_set "LOG_LEVEL" "warn"; CHANGES_MADE=true; echo -e "  ${GREEN}Set LOG_LEVEL=warn${NC}" ;;
            4) env_set "LOG_LEVEL" "error"; CHANGES_MADE=true; echo -e "  ${GREEN}Set LOG_LEVEL=error${NC}" ;;
            0|"") return 0 ;;
            *) echo -e "  ${RED}Invalid option${NC}" ;;
        esac
    done
}

config_menu_other() {
    while true; do
        local ack_timeout pending_cleanup media_cleanup media_max media_retention jwt_expires
        local pending_ttl challenge_ttl challenge_cleanup
        local throttle_ttl throttle_global throttle_auth throttle_media throttle_keys
        local ephemeral_default ephemeral_max invite_code_len
        local max_volatile push_sound throttle_key_fetch
        ack_timeout=$(env_get "ACK_TIMEOUT_MS") || true
        pending_cleanup=$(env_get "PENDING_CLEANUP_INTERVAL_MS") || true
        media_cleanup=$(env_get "MEDIA_CLEANUP_INTERVAL_MS") || true
        media_max=$(env_get "MEDIA_MAX_SIZE") || true
        media_retention=$(env_get "MEDIA_RETENTION_DAYS") || true
        jwt_expires=$(env_get "JWT_EXPIRES_IN") || true
        pending_ttl=$(env_get "PENDING_MESSAGE_TTL_MS") || true
        challenge_ttl=$(env_get "CHALLENGE_TTL_SECONDS") || true
        challenge_cleanup=$(env_get "CHALLENGE_CLEANUP_INTERVAL_MS") || true
        throttle_ttl=$(env_get "THROTTLE_TTL_MS") || true
        throttle_global=$(env_get "THROTTLE_GLOBAL_LIMIT") || true
        throttle_auth=$(env_get "THROTTLE_AUTH_LIMIT") || true
        throttle_media=$(env_get "THROTTLE_MEDIA_LIMIT") || true
        throttle_keys=$(env_get "THROTTLE_KEYS_LIMIT") || true
        ephemeral_default=$(env_get "EPHEMERAL_MEDIA_DEFAULT_TTL_HOURS") || true
        ephemeral_max=$(env_get "EPHEMERAL_MEDIA_MAX_TTL_HOURS") || true
        invite_code_len=$(env_get "INVITE_CODE_LENGTH") || true
        max_volatile=$(env_get "MAX_VOLATILE_PAYLOAD_BYTES") || true
        push_sound=$(env_get "PUSH_NOTIFICATION_SOUND") || true
        throttle_key_fetch=$(env_get "THROTTLE_KEY_FETCH_PER_TARGET") || true

        echo ""
        echo -e "  ${BOLD}Other Settings${NC}"
        echo "  ──────────────"
        echo -e "   1) ACK_TIMEOUT_MS:                  ${BLUE}${ack_timeout:-5000}${NC}"
        echo -e "   2) PENDING_CLEANUP_INTERVAL_MS:     ${BLUE}${pending_cleanup:-3600000}${NC}"
        echo -e "   3) MEDIA_CLEANUP_INTERVAL_MS:       ${BLUE}${media_cleanup:-3600000}${NC}"
        echo -e "   4) MEDIA_MAX_SIZE:                  ${BLUE}${media_max:-10485760}${NC}"
        echo -e "   5) MEDIA_RETENTION_DAYS:            ${BLUE}${media_retention:-30}${NC}"
        echo -e "   6) JWT_EXPIRES_IN:                  ${BLUE}${jwt_expires:-30d}${NC}"
        echo -e "   7) PENDING_MESSAGE_TTL_MS:          ${BLUE}${pending_ttl:-604800000}${NC}"
        echo -e "   8) CHALLENGE_TTL_SECONDS:           ${BLUE}${challenge_ttl:-60}${NC}"
        echo -e "   9) CHALLENGE_CLEANUP_INTERVAL_MS:   ${BLUE}${challenge_cleanup:-30000}${NC}"
        echo -e "  10) THROTTLE_TTL_MS:                 ${BLUE}${throttle_ttl:-60000}${NC}"
        echo -e "  11) THROTTLE_GLOBAL_LIMIT:           ${BLUE}${throttle_global:-60}${NC}"
        echo -e "  12) THROTTLE_AUTH_LIMIT:             ${BLUE}${throttle_auth:-5}${NC}"
        echo -e "  13) THROTTLE_MEDIA_LIMIT:            ${BLUE}${throttle_media:-10}${NC}"
        echo -e "  14) THROTTLE_KEYS_LIMIT:             ${BLUE}${throttle_keys:-20}${NC}"
        echo -e "  15) EPHEMERAL_MEDIA_DEFAULT_TTL_HOURS: ${BLUE}${ephemeral_default:-24}${NC}"
        echo -e "  16) EPHEMERAL_MEDIA_MAX_TTL_HOURS:   ${BLUE}${ephemeral_max:-168}${NC}"
        echo -e "  17) INVITE_CODE_LENGTH:              ${BLUE}${invite_code_len:-8}${NC}"
        echo -e "  18) MAX_VOLATILE_PAYLOAD_BYTES:      ${BLUE}${max_volatile:-10485760}${NC}"
        echo -e "  19) PUSH_NOTIFICATION_SOUND:         ${BLUE}${push_sound:-default}${NC}"
        echo -e "  20) THROTTLE_KEY_FETCH_PER_TARGET:   ${BLUE}${throttle_key_fetch:-3}${NC}"
        echo "   0) Back"
        echo ""
        read -p "  Select: " choice

        case "$choice" in
            1)
                read -p "  ACK_TIMEOUT_MS [${ack_timeout:-5000}]: " val
                [ -n "$val" ] && { env_set "ACK_TIMEOUT_MS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            2)
                read -p "  PENDING_CLEANUP_INTERVAL_MS [${pending_cleanup:-3600000}]: " val
                [ -n "$val" ] && { env_set "PENDING_CLEANUP_INTERVAL_MS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            3)
                read -p "  MEDIA_CLEANUP_INTERVAL_MS [${media_cleanup:-3600000}]: " val
                [ -n "$val" ] && { env_set "MEDIA_CLEANUP_INTERVAL_MS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            4)
                read -p "  MEDIA_MAX_SIZE [${media_max:-10485760}]: " val
                [ -n "$val" ] && { env_set "MEDIA_MAX_SIZE" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            5)
                read -p "  MEDIA_RETENTION_DAYS [${media_retention:-30}]: " val
                [ -n "$val" ] && { env_set "MEDIA_RETENTION_DAYS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            6)
                read -p "  JWT_EXPIRES_IN [${jwt_expires:-30d}]: " val
                [ -n "$val" ] && { env_set "JWT_EXPIRES_IN" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            7)
                read -p "  PENDING_MESSAGE_TTL_MS [${pending_ttl:-604800000}]: " val
                [ -n "$val" ] && { env_set "PENDING_MESSAGE_TTL_MS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            8)
                read -p "  CHALLENGE_TTL_SECONDS [${challenge_ttl:-60}]: " val
                [ -n "$val" ] && { env_set "CHALLENGE_TTL_SECONDS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            9)
                read -p "  CHALLENGE_CLEANUP_INTERVAL_MS [${challenge_cleanup:-30000}]: " val
                [ -n "$val" ] && { env_set "CHALLENGE_CLEANUP_INTERVAL_MS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            10)
                read -p "  THROTTLE_TTL_MS [${throttle_ttl:-60000}]: " val
                [ -n "$val" ] && { env_set "THROTTLE_TTL_MS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            11)
                read -p "  THROTTLE_GLOBAL_LIMIT [${throttle_global:-60}]: " val
                [ -n "$val" ] && { env_set "THROTTLE_GLOBAL_LIMIT" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            12)
                read -p "  THROTTLE_AUTH_LIMIT [${throttle_auth:-5}]: " val
                [ -n "$val" ] && { env_set "THROTTLE_AUTH_LIMIT" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            13)
                read -p "  THROTTLE_MEDIA_LIMIT [${throttle_media:-10}]: " val
                [ -n "$val" ] && { env_set "THROTTLE_MEDIA_LIMIT" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            14)
                read -p "  THROTTLE_KEYS_LIMIT [${throttle_keys:-20}]: " val
                [ -n "$val" ] && { env_set "THROTTLE_KEYS_LIMIT" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            15)
                read -p "  EPHEMERAL_MEDIA_DEFAULT_TTL_HOURS [${ephemeral_default:-24}]: " val
                [ -n "$val" ] && { env_set "EPHEMERAL_MEDIA_DEFAULT_TTL_HOURS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            16)
                read -p "  EPHEMERAL_MEDIA_MAX_TTL_HOURS [${ephemeral_max:-168}]: " val
                [ -n "$val" ] && { env_set "EPHEMERAL_MEDIA_MAX_TTL_HOURS" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            17)
                read -p "  INVITE_CODE_LENGTH [${invite_code_len:-8}]: " val
                [ -n "$val" ] && { env_set "INVITE_CODE_LENGTH" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            18)
                read -p "  MAX_VOLATILE_PAYLOAD_BYTES [${max_volatile:-10485760}]: " val
                [ -n "$val" ] && { env_set "MAX_VOLATILE_PAYLOAD_BYTES" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            19)
                read -p "  PUSH_NOTIFICATION_SOUND [${push_sound:-default}]: " val
                [ -n "$val" ] && { env_set "PUSH_NOTIFICATION_SOUND" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            20)
                read -p "  THROTTLE_KEY_FETCH_PER_TARGET [${throttle_key_fetch:-3}]: " val
                [ -n "$val" ] && { env_set "THROTTLE_KEY_FETCH_PER_TARGET" "$val"; CHANGES_MADE=true; echo -e "  ${GREEN}Updated${NC}"; }
                ;;
            0|"") return 0 ;;
            *) echo -e "  ${RED}Invalid option${NC}" ;;
        esac
    done
}

# ──────────────────────────────────────────────
# Moderation commands
# ──────────────────────────────────────────────

run_node_script() {
    local script="$1"
    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file)
        docker compose -f "$INSTALL_DIR/$compose_file" exec -T tillit node -e "$script"
    else
        cd "$INSTALL_DIR" && node -e "$script"
    fi
}

get_db_path() {
    local sqlite_dir
    sqlite_dir=$(env_get "SQLITE_DATA_DIR") || true
    if [ -n "$sqlite_dir" ]; then
        echo "${sqlite_dir}/tillit.db"
    else
        echo "$INSTALL_DIR/data/tillit.db"
    fi
}

run_sqlite_query() {
    local query="$1"
    local db_path
    db_path=$(get_db_path)

    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file)
        docker compose -f "$INSTALL_DIR/$compose_file" exec -T tillit \
            node -e "const Database = require('better-sqlite3'); const db = new Database('/app/data/tillit.db'); const rows = db.prepare(\`$query\`).all(); console.log(JSON.stringify(rows)); db.close();"
    else
        if ! command -v sqlite3 &>/dev/null; then
            # Fallback to node
            run_node_script "const Database = require('better-sqlite3'); const db = new Database('$db_path'); const rows = db.prepare(\`$query\`).all(); console.log(JSON.stringify(rows)); db.close();"
        else
            sqlite3 -json "$db_path" "$query"
        fi
    fi
}

run_sqlite_exec() {
    local query="$1"
    local db_path
    db_path=$(get_db_path)

    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file)
        docker compose -f "$INSTALL_DIR/$compose_file" exec -T tillit \
            node -e "const Database = require('better-sqlite3'); const db = new Database('/app/data/tillit.db'); const info = db.prepare(\`$query\`).run(); console.log(JSON.stringify({changes: info.changes})); db.close();"
    else
        if ! command -v sqlite3 &>/dev/null; then
            run_node_script "const Database = require('better-sqlite3'); const db = new Database('$db_path'); const info = db.prepare(\`$query\`).run(); console.log(JSON.stringify({changes: info.changes})); db.close();"
        else
            sqlite3 "$db_path" "$query"
            echo '{"changes":1}'
        fi
    fi
}

cmd_moderation() {
    local subcmd="${1:-}"
    shift 2>/dev/null || true

    case "$subcmd" in
        reports)
            echo ""
            echo -e "  ${BOLD}Pending Reports${NC}"
            echo "  ==============="
            local result
            result=$(run_sqlite_query "SELECT r.id, r.reporter_user_id, r.reported_user_id, r.room_id, r.message_id, r.reason, r.description, r.status, r.created_at FROM reports r WHERE r.status = 'pending' ORDER BY r.created_at DESC")

            if [ -z "$result" ] || [ "$result" = "[]" ]; then
                echo -e "  ${DIM}No pending reports.${NC}"
            else
                echo "$result" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
for r in rows:
    ts = r.get('created_at', 0)
    from datetime import datetime
    dt = datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M') if ts else 'unknown'
    msg = f\" (msg: {r['message_id']})\" if r.get('message_id') else ''
    desc = f\" - {r['description']}\" if r.get('description') else ''
    print(f\"  #{r['id']}  [{r['reason']}] user {r['reporter_user_id']} -> user {r['reported_user_id']} in room {r['room_id']}{msg}{desc}  ({dt})\")
" 2>/dev/null || echo "  $result"
            fi
            echo ""
            ;;
        report)
            local report_id="${1:-}"
            local action="${2:-}"

            if [ -z "$report_id" ] || [ -z "$action" ]; then
                echo -e "${RED}Usage: tillit moderation report <id> <review|dismiss>${NC}"
                return 1
            fi

            case "$action" in
                review)
                    run_sqlite_exec "UPDATE reports SET status = 'reviewed' WHERE id = $report_id"
                    echo -e "${GREEN}Report #$report_id marked as reviewed.${NC}"
                    ;;
                dismiss)
                    run_sqlite_exec "UPDATE reports SET status = 'dismissed' WHERE id = $report_id"
                    echo -e "${GREEN}Report #$report_id dismissed.${NC}"
                    ;;
                action)
                    run_sqlite_exec "UPDATE reports SET status = 'actioned' WHERE id = $report_id"
                    echo -e "${GREEN}Report #$report_id marked as actioned.${NC}"
                    ;;
                *)
                    echo -e "${RED}Unknown action: $action. Use: review, dismiss, action${NC}"
                    return 1
                    ;;
            esac
            ;;
        ban)
            local user_id="${1:-}"
            local reason="${2:-}"

            if [ -z "$user_id" ]; then
                echo -e "${RED}Usage: tillit moderation ban <userId> [reason]${NC}"
                return 1
            fi

            local now
            now=$(date +%s%3N 2>/dev/null || python3 -c "import time; print(int(time.time()*1000))")
            local reason_sql="NULL"
            [ -n "$reason" ] && reason_sql="'$reason'"

            run_sqlite_exec "INSERT OR IGNORE INTO banned_users (user_id, reason, banned_at) VALUES ($user_id, $reason_sql, $now)"
            echo -e "${GREEN}User $user_id has been banned.${NC}"
            echo -e "${YELLOW}Note: The ban takes effect on their next request/connection. Restart the service to clear cached sessions.${NC}"
            ;;
        unban)
            local user_id="${1:-}"

            if [ -z "$user_id" ]; then
                echo -e "${RED}Usage: tillit moderation unban <userId>${NC}"
                return 1
            fi

            run_sqlite_exec "DELETE FROM banned_users WHERE user_id = $user_id"
            echo -e "${GREEN}User $user_id has been unbanned.${NC}"
            echo -e "${YELLOW}Note: Restart the service to clear the ban cache.${NC}"
            ;;
        banned)
            echo ""
            echo -e "  ${BOLD}Banned Users${NC}"
            echo "  ============"
            local result
            result=$(run_sqlite_query "SELECT b.user_id, b.reason, b.banned_at, u.identity_public_key FROM banned_users b LEFT JOIN users u ON b.user_id = u.id ORDER BY b.banned_at DESC")

            if [ -z "$result" ] || [ "$result" = "[]" ]; then
                echo -e "  ${DIM}No banned users.${NC}"
            else
                echo "$result" | python3 -c "
import json, sys
rows = json.load(sys.stdin)
for r in rows:
    ts = r.get('banned_at', 0)
    from datetime import datetime
    dt = datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M') if ts else 'unknown'
    reason = r.get('reason') or 'no reason'
    ipk = r.get('identity_public_key', '')
    ipk_short = ipk[:16] + '...' if ipk and len(ipk) > 16 else ipk or 'unknown'
    print(f\"  User #{r['user_id']}  key={ipk_short}  reason={reason}  ({dt})\")
" 2>/dev/null || echo "  $result"
            fi
            echo ""
            ;;
        ""|help)
            echo ""
            echo -e "  ${BOLD}Moderation Commands${NC}"
            echo ""
            echo "    tillit moderation reports                List pending reports"
            echo "    tillit moderation report <id> review     Mark report as reviewed"
            echo "    tillit moderation report <id> dismiss    Dismiss report"
            echo "    tillit moderation report <id> action     Mark report as actioned"
            echo "    tillit moderation ban <userId> [reason]  Ban a user"
            echo "    tillit moderation unban <userId>         Unban a user"
            echo "    tillit moderation banned                 List banned users"
            echo ""
            ;;
        *)
            echo -e "${RED}Unknown moderation command: $subcmd${NC}"
            echo "Run 'tillit moderation help' for usage."
            return 1
            ;;
    esac
}

# ──────────────────────────────────────────────
# Update
# ──────────────────────────────────────────────

cmd_onion() {
    if ! is_tor_mode; then
        echo -e "${RED}Not running in Tor mode.${NC}"
        echo "  Tor Hidden Service is only available with docker-compose.tor.yml"
        return 1
    fi

    local addr
    addr=$(get_onion_address) || true
    if [ -n "$addr" ]; then
        echo ""
        echo -e "  ${BOLD}Onion Address${NC}"
        echo -e "  http://$addr"
        echo ""
    else
        echo -e "${YELLOW}Onion address not available yet — Tor may still be bootstrapping.${NC}"
        echo "  Check Tor logs: tillit logs"
        return 1
    fi
}

cmd_update() {
    echo -e "${BLUE}Updating TilliT...${NC}"
    echo ""

    if [ "$DEPLOY_MODE" = "docker" ]; then
        local compose_file
        compose_file=$(find_compose_file)
        cd "$INSTALL_DIR"
        echo "Pulling latest image..."
        docker compose -f "$compose_file" pull
        echo "Recreating containers..."
        if is_tor_mode; then
            # Tor uses build: directive, needs --build to rebuild the sidecar
            docker compose -f "$compose_file" up -d --build
        else
            docker compose -f "$compose_file" up -d
        fi
    else
        cd "$INSTALL_DIR"
        echo "Pulling latest code..."
        git pull
        echo "Installing dependencies..."
        pnpm install --frozen-lockfile
        echo "Building..."
        pnpm run build
        echo "Restarting service..."
        service_restart
    fi

    echo ""
    echo -e "${GREEN}Update complete.${NC}"

    # Wait a bit and show status
    sleep 3
    cmd_status
}

# ──────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────

cmd_help() {
    echo ""
    echo -e "  ${BOLD}TilliT CLI${NC} v$CLI_VERSION"
    echo ""
    echo "  Usage: tillit <command> [options]"
    echo ""
    echo -e "  ${BOLD}Service${NC}"
    echo "    start                  Start the service"
    echo "    stop                   Stop the service"
    echo "    restart                Restart the service"
    echo "    status                 Show service status and health info"
    echo "    logs [-f] [-n N]       View logs (default: follow mode)"
    echo ""
    echo -e "  ${BOLD}Configuration${NC}"
    echo "    config                 Interactive configuration menu"
    echo "    config list            Show all settings"
    echo "    config get <KEY>       Read a configuration value"
    echo "    config set KEY=VALUE   Set a configuration value"
    echo ""
    echo -e "  ${BOLD}Moderation${NC}"
    echo "    moderation reports     List pending reports"
    echo "    moderation ban <id>    Ban a user"
    echo "    moderation unban <id>  Unban a user"
    echo "    moderation banned      List banned users"
    echo "    moderation help        Show all moderation commands"
    echo ""
    echo -e "  ${BOLD}Tor${NC}"
    echo "    onion                  Show .onion address (Tor mode only)"
    echo ""
    echo -e "  ${BOLD}Maintenance${NC}"
    echo "    update                 Update to the latest version"
    echo ""
    echo -e "  ${BOLD}Info${NC}"
    echo "    help                   Show this help message"
    echo "    version                Show CLI version"
    echo ""
    echo -e "  ${DIM}Install dir: ${INSTALL_DIR:-/opt/tillit}${NC}"
    echo -e "  ${DIM}Deploy mode: ${DEPLOY_MODE:-unknown}${NC}"
    echo ""
}

cmd_version() {
    echo "tillit-cli v$CLI_VERSION"
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

main() {
    detect_os

    # Commands that don't need install dir detection
    case "${1:-}" in
        version|--version|-v)
            cmd_version
            exit 0
            ;;
        ""|help|--help|-h)
            # Try to detect for help display, but don't fail
            detect_install_dir 2>/dev/null || INSTALL_DIR="${HOME}/tillit"
            detect_deploy_mode "false"
            cmd_help
            exit 0
            ;;
    esac

    # All other commands require a valid installation
    detect_install_dir
    detect_deploy_mode

    case "$1" in
        start)
            cmd_start
            ;;
        stop)
            cmd_stop
            ;;
        restart)
            cmd_restart
            ;;
        status)
            cmd_status
            ;;
        logs)
            shift
            cmd_logs "$@"
            ;;
        config)
            shift
            case "${1:-}" in
                list)
                    cmd_config_list
                    ;;
                get)
                    if [ -z "${2:-}" ]; then
                        echo -e "${RED}Usage: tillit config get <KEY>${NC}"
                        exit 1
                    fi
                    cmd_config_get "$2"
                    ;;
                set)
                    if [ -z "${2:-}" ]; then
                        echo -e "${RED}Usage: tillit config set KEY=VALUE${NC}"
                        exit 1
                    fi
                    cmd_config_set "$2"
                    ;;
                "")
                    cmd_config_interactive
                    ;;
                *)
                    echo -e "${RED}Unknown config command: $1${NC}"
                    echo "Usage: tillit config [list|get <KEY>|set KEY=VALUE]"
                    exit 1
                    ;;
            esac
            ;;
        moderation)
            shift
            cmd_moderation "$@"
            ;;
        onion)
            cmd_onion
            ;;
        update)
            cmd_update
            ;;
        *)
            echo -e "${RED}Unknown command: $1${NC}"
            echo "Run 'tillit help' for usage."
            exit 1
            ;;
    esac
}

main "$@"
