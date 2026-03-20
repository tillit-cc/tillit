#!/bin/sh
#
# mDNS Entrypoint — Publishes _tillit._tcp via Avahi.
#
# Strategy:
#   1. If /host-avahi-services is mounted (host has Avahi), write the service XML
#      there and let the host's avahi-daemon pick it up automatically.
#      The container stays alive to watch for onion file changes.
#   2. Otherwise, start our own dbus + avahi-daemon inside the container.
#
# Environment variables:
#   MDNS_NAME       Service display name (default: TilliT)
#   MDNS_PORT       Port number (default: 3000)
#   MDNS_PROTOCOL   http or https (default: http)
#   MDNS_VERSION    Server version (default: 0.5.0)
#   MDNS_HOST       Optional hostname (e.g., mybox.tillit.cc)
#   MDNS_ONION      Static .onion address
#   MDNS_ONION_FILE Path to file containing .onion address (Tor mode)
#
set -e

MDNS_NAME="${MDNS_NAME:-TilliT}"
MDNS_PORT="${MDNS_PORT:-3000}"
MDNS_PROTOCOL="${MDNS_PROTOCOL:-http}"
MDNS_VERSION="${MDNS_VERSION:-0.5.0}"
MDNS_HOST="${MDNS_HOST:-}"
MDNS_ONION="${MDNS_ONION:-}"
MDNS_ONION_FILE="${MDNS_ONION_FILE:-}"

# Detect mode: host Avahi or standalone
if [ -d "/host-avahi-services" ]; then
    SERVICE_FILE="/host-avahi-services/tillit.service"
    MODE="host"
else
    SERVICE_FILE="/etc/avahi/services/tillit.service"
    MODE="standalone"
fi

# Generate the Avahi service XML
generate_service() {
    local onion_txt=""
    local host_txt=""
    local onion_addr="${1:-$MDNS_ONION}"

    if [ -n "$onion_addr" ]; then
        onion_txt="      <txt-record>onion=$onion_addr</txt-record>"
    fi
    if [ -n "$MDNS_HOST" ]; then
        host_txt="      <txt-record>host=$MDNS_HOST</txt-record>"
    fi

    # Delete then create: Avahi uses inotify on /etc/avahi/services/.
    # In-place overwrites (same inode) may not trigger inotify via Docker
    # bind mounts. Deleting first triggers a CREATE event on the new file.
    rm -f "$SERVICE_FILE"
    cat > "$SERVICE_FILE" << EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>$MDNS_NAME</name>
  <service>
    <type>_tillit._tcp</type>
    <port>$MDNS_PORT</port>
    <txt-record>ver=$MDNS_VERSION</txt-record>
    <txt-record>protocol=$MDNS_PROTOCOL</txt-record>
    <txt-record>path=</txt-record>
${host_txt:+$host_txt
}${onion_txt:+$onion_txt
}  </service>
</service-group>
EOF
}

# On exit: remove only our tillit.service file so host Avahi stops advertising it
cleanup() {
    if [ "$SERVICE_FILE" = "/host-avahi-services/tillit.service" ] && [ -f "$SERVICE_FILE" ]; then
        echo "[mdns] Stopping — removing tillit.service from host Avahi"
        rm -f "$SERVICE_FILE"
    fi
    exit 0
}
trap cleanup TERM INT

# Generate initial service file
generate_service

# Watch for onion file changes in background (if configured)
if [ -n "$MDNS_ONION_FILE" ]; then
    (
        echo "[mdns] Watching for onion address at $MDNS_ONION_FILE..."
        last_onion=""
        while true; do
            if [ -f "$MDNS_ONION_FILE" ]; then
                current_onion=$(cat "$MDNS_ONION_FILE" 2>/dev/null | tr -d '[:space:]')
                if [ -n "$current_onion" ] && [ "$current_onion" != "$last_onion" ]; then
                    echo "[mdns] Onion address found: $current_onion"
                    generate_service "$current_onion"
                    last_onion="$current_onion"
                fi
            fi
            sleep 5
        done
    ) &
fi

echo "[mdns] Broadcasting _tillit._tcp on port $MDNS_PORT (protocol=$MDNS_PROTOCOL, ver=$MDNS_VERSION)"

if [ "$MODE" = "host" ]; then
    # Host mode: service file written, host Avahi detects it automatically.
    # Container stays alive to watch for onion changes and clean up on stop.
    echo "[mdns] Using host Avahi (service file at $SERVICE_FILE)"
    while true; do sleep 3600 & wait $!; done
else
    # Standalone mode: no host Avahi available, start our own daemon
    echo "[mdns] Starting standalone Avahi daemon"

    mkdir -p /etc/avahi
    cat > /etc/avahi/avahi-daemon.conf << EOF
[server]
use-ipv4=yes
use-ipv6=yes
allow-interfaces=
deny-interfaces=
enable-dbus=yes
disallow-other-stacks=no

[wide-area]
enable-wide-area=no

[publish]
publish-addresses=no
publish-hinfo=no
publish-workstation=no
publish-domain=no

[reflector]

[rlimits]
EOF

    mkdir -p /run/dbus
    rm -f /run/dbus/pid
    dbus-daemon --system --nofork --nopidfile &
    sleep 1

    exec avahi-daemon --no-drop-root --no-chroot
fi