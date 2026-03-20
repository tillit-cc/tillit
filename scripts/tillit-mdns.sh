#!/bin/bash
#
# TilliT mDNS Helper — Bare-metal mDNS service management
#
# This script is sourced by install-bare.sh and tillit-cli.sh.
# It provides functions to register/remove the _tillit._tcp mDNS service
# on Linux (Avahi) and macOS (dns-sd via launchd).
#
# Usage (sourced):
#   . /path/to/tillit-mdns.sh
#   setup_mdns_service 3000 http 0.5.0
#   update_mdns_onion "xxxxx.onion"
#   remove_mdns_service
#

AVAHI_SERVICE_FILE="/etc/avahi/services/tillit.service"
MDNS_PLIST_FILE="$HOME/Library/LaunchAgents/cc.tillit.mdns.plist"
MDNS_PIDFILE="/tmp/tillit-mdns-dns-sd.pid"

# setup_mdns_service port protocol version [onion] [host]
setup_mdns_service() {
    local port="${1:-3000}"
    local protocol="${2:-http}"
    local version="${3:-0.5.0}"
    local onion="${4:-}"
    local host="${5:-}"

    case "$(uname -s)" in
        Darwin) _setup_mdns_macos "$port" "$protocol" "$version" "$onion" "$host" ;;
        *)      _setup_mdns_linux "$port" "$protocol" "$version" "$onion" "$host" ;;
    esac
}

# update_mdns_onion onion_address
update_mdns_onion() {
    local onion="$1"

    case "$(uname -s)" in
        Darwin)
            # macOS: need to restart dns-sd with updated TXT records
            # Re-read current settings from plist or use defaults
            local port protocol version host
            port=$(_mdns_macos_current_port)
            protocol=$(_mdns_macos_current_protocol)
            version=$(_mdns_macos_current_version)
            host=$(_mdns_macos_current_host)
            _stop_mdns_macos
            _setup_mdns_macos "$port" "$protocol" "$version" "$onion" "$host"
            ;;
        *)
            # Linux: update the Avahi XML and Avahi reloads automatically
            if [ -f "$AVAHI_SERVICE_FILE" ]; then
                _setup_mdns_linux \
                    "$(_avahi_xml_get_port)" \
                    "$(_avahi_xml_get_txt protocol)" \
                    "$(_avahi_xml_get_txt ver)" \
                    "$onion" \
                    "$(_avahi_xml_get_txt host)"
            fi
            ;;
    esac
}

# remove_mdns_service
remove_mdns_service() {
    case "$(uname -s)" in
        Darwin) _stop_mdns_macos; rm -f "$MDNS_PLIST_FILE" ;;
        *)      rm -f "$AVAHI_SERVICE_FILE" ;;
    esac
}

# install_mdns_launchd port protocol version [onion] [host]
# Creates a launchd plist that runs dns-sd on boot (macOS only)
install_mdns_launchd() {
    local port="${1:-3000}"
    local protocol="${2:-http}"
    local version="${3:-0.5.0}"
    local onion="${4:-}"
    local host="${5:-}"

    local txt="ver=$version,protocol=$protocol,path="
    [ -n "$host" ] && txt="$txt,host=$host"
    [ -n "$onion" ] && txt="$txt,onion=$onion"

    local plist_dir
    plist_dir="$(dirname "$MDNS_PLIST_FILE")"
    mkdir -p "$plist_dir"

    cat > "$MDNS_PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>cc.tillit.mdns</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/dns-sd</string>
        <string>-R</string>
        <string>TilliT</string>
        <string>_tillit._tcp</string>
        <string>local</string>
        <string>$port</string>
        <string>$txt</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
EOF

    launchctl load "$MDNS_PLIST_FILE" 2>/dev/null || true
}

# is_mdns_running — check if mDNS service is active
is_mdns_running() {
    case "$(uname -s)" in
        Darwin)
            launchctl list cc.tillit.mdns >/dev/null 2>&1 && return 0
            [ -f "$MDNS_PIDFILE" ] && kill -0 "$(cat "$MDNS_PIDFILE")" 2>/dev/null && return 0
            return 1
            ;;
        *)
            [ -f "$AVAHI_SERVICE_FILE" ] && systemctl is-active --quiet avahi-daemon 2>/dev/null && return 0
            return 1
            ;;
    esac
}

# ── Internal: Linux (Avahi) ──────────────────────────────────────────────────

_setup_mdns_linux() {
    local port="$1" protocol="$2" version="$3" onion="$4" host="$5"

    # Ensure avahi-daemon is installed
    if ! command -v avahi-daemon &>/dev/null; then
        echo "[mdns] Installing avahi-daemon..."
        if command -v apt-get &>/dev/null; then
            apt-get install -y avahi-daemon >/dev/null 2>&1
        elif command -v dnf &>/dev/null; then
            dnf install -y avahi >/dev/null 2>&1
        fi
    fi

    local onion_line=""
    local host_line=""
    [ -n "$onion" ] && onion_line="    <txt-record>onion=$onion</txt-record>"
    [ -n "$host" ] && host_line="    <txt-record>host=$host</txt-record>"

    mkdir -p "$(dirname "$AVAHI_SERVICE_FILE")"

    cat > "$AVAHI_SERVICE_FILE" << EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>TilliT</name>
  <service>
    <type>_tillit._tcp</type>
    <port>$port</port>
    <txt-record>ver=$version</txt-record>
    <txt-record>protocol=$protocol</txt-record>
    <txt-record>path=</txt-record>
${host_line:+$host_line
}${onion_line:+$onion_line
}  </service>
</service-group>
EOF

    # Ensure avahi-daemon is running
    if command -v systemctl &>/dev/null; then
        systemctl enable avahi-daemon 2>/dev/null || true
        systemctl restart avahi-daemon 2>/dev/null || true
    fi
}

# ── Internal: macOS (dns-sd) ─────────────────────────────────────────────────

_setup_mdns_macos() {
    local port="$1" protocol="$2" version="$3" onion="$4" host="$5"

    local txt="ver=$version,protocol=$protocol,path="
    [ -n "$host" ] && txt="$txt,host=$host"
    [ -n "$onion" ] && txt="$txt,onion=$onion"

    # Kill existing dns-sd if running
    _stop_mdns_macos

    dns-sd -R "TilliT" "_tillit._tcp" "local" "$port" "$txt" &
    echo $! > "$MDNS_PIDFILE"
}

_stop_mdns_macos() {
    if [ -f "$MDNS_PIDFILE" ]; then
        local pid
        pid=$(cat "$MDNS_PIDFILE")
        kill "$pid" 2>/dev/null || true
        rm -f "$MDNS_PIDFILE"
    fi

    # Also unload launchd if loaded
    launchctl unload "$MDNS_PLIST_FILE" 2>/dev/null || true
}

# ── Internal: Parse existing Avahi XML ───────────────────────────────────────

_avahi_xml_get_port() {
    grep -oP '(?<=<port>)\d+' "$AVAHI_SERVICE_FILE" 2>/dev/null || echo "3000"
}

_avahi_xml_get_txt() {
    local key="$1"
    grep "txt-record.*${key}=" "$AVAHI_SERVICE_FILE" 2>/dev/null \
        | sed "s/.*${key}=\([^<]*\).*/\1/" | head -1
}

# ── Internal: Parse macOS dns-sd state ───────────────────────────────────────

_mdns_macos_current_port() {
    if [ -f "$MDNS_PLIST_FILE" ]; then
        # Port is the argument after "local" in the plist
        grep -A1 ">local<" "$MDNS_PLIST_FILE" 2>/dev/null \
            | grep "<string>" | sed 's/.*<string>\(.*\)<\/string>.*/\1/' | head -1
    else
        echo "3000"
    fi
}

_mdns_macos_current_protocol() {
    if [ -f "$MDNS_PLIST_FILE" ]; then
        grep "protocol=" "$MDNS_PLIST_FILE" 2>/dev/null \
            | sed 's/.*protocol=\([^,<]*\).*/\1/' | head -1
    else
        echo "http"
    fi
}

_mdns_macos_current_version() {
    if [ -f "$MDNS_PLIST_FILE" ]; then
        grep "ver=" "$MDNS_PLIST_FILE" 2>/dev/null \
            | sed 's/.*ver=\([^,<]*\).*/\1/' | head -1
    else
        echo "0.5.0"
    fi
}

_mdns_macos_current_host() {
    if [ -f "$MDNS_PLIST_FILE" ]; then
        grep "host=" "$MDNS_PLIST_FILE" 2>/dev/null \
            | sed 's/.*host=\([^,<]*\).*/\1/' | head -1
    else
        echo ""
    fi
}
