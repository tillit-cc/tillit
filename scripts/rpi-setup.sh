#!/bin/bash
#
# TilliT Raspberry Pi SD Card Setup Tool
#
# Run this on your PC (macOS or Linux) AFTER flashing Raspberry Pi OS
# with Raspberry Pi Imager and configuring WiFi/hostname.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/rpi-setup.sh | bash
#
# Or download and run:
#   chmod +x rpi-setup.sh && ./rpi-setup.sh
#
# Supports all Raspberry Pi OS boot mechanisms:
#   - Trixie (Imager 2.0+): cloud-init user-data with runcmd
#   - Bookworm (recent):     custom.toml + firstrun.sh
#   - Bookworm (older):      firstrun.sh with cmdline.txt trigger
#
set -euo pipefail

# When piped via curl | bash, stdin is the script itself, not the terminal.
# Reopen stdin from /dev/tty so interactive read prompts work.
if [ ! -t 0 ] && [ -e /dev/tty ]; then
    exec < /dev/tty
fi

# ── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

# ── Configuration ────────────────────────────────────────────────────────────

REPO_RAW="https://raw.githubusercontent.com/tillit-cc/tillit/main"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd 2>/dev/null)" || SCRIPT_DIR="."
FIRSTBOOT_SCRIPT="tillit-firstboot.sh"
FIRSTBOOT_ENV="tillit-firstboot.env"

# ── Helpers ──────────────────────────────────────────────────────────────────

print_banner() {
    echo -e "${CYAN}"
    echo "╔═══════════════════════════════════════════════════════════╗"
    echo "║                                                           ║"
    echo "║          TilliT — Raspberry Pi SD Card Setup              ║"
    echo "║                                                           ║"
    echo "║   Prepare your SD card for automatic TilliT installation  ║"
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

# ── Detect boot partition ────────────────────────────────────────────────────

detect_boot_partition() {
    local boot_path=""

    case "$(uname -s)" in
        Darwin)
            # macOS: Bookworm+ uses "bootfs", older uses "boot"
            for candidate in "/Volumes/bootfs" "/Volumes/boot"; do
                if [ -d "$candidate" ] && [ -f "$candidate/cmdline.txt" ]; then
                    boot_path="$candidate"
                    break
                fi
            done
            ;;
        Linux)
            # Linux: check common mount points
            local user="${SUDO_USER:-$USER}"
            for prefix in "/media/$user" "/run/media/$user" "/mnt"; do
                for name in "bootfs" "boot"; do
                    local candidate="$prefix/$name"
                    if [ -d "$candidate" ] && [ -f "$candidate/cmdline.txt" ]; then
                        boot_path="$candidate"
                        break 2
                    fi
                done
            done
            ;;
    esac

    if [ -z "$boot_path" ]; then
        echo ""
        log_warning "Could not auto-detect boot partition."
        echo ""
        echo "  Make sure the SD card is inserted and mounted."
        echo "  The boot partition should contain cmdline.txt and config.txt."
        echo ""
        read -rp "  Enter the path to the boot partition: " boot_path

        if [ -z "$boot_path" ]; then
            log_error "No path provided. Exiting."
            exit 1
        fi
    fi

    # Validate
    if [ ! -f "$boot_path/cmdline.txt" ] || [ ! -f "$boot_path/config.txt" ]; then
        log_error "Not a valid Raspberry Pi boot partition: $boot_path"
        echo "  Expected to find cmdline.txt and config.txt"
        exit 1
    fi

    echo "$boot_path"
}

# ── Detect boot mechanism ───────────────────────────────────────────────────

# Returns: "cloudinit", "firstrun", or "none"
detect_boot_mode() {
    local boot_path="$1"

    # Trixie (Imager 2.0+): cloud-init files present
    if [ -f "$boot_path/user-data" ]; then
        echo "cloudinit"
        return
    fi

    # Bookworm legacy: firstrun.sh with cmdline.txt trigger
    if [ -f "$boot_path/firstrun.sh" ]; then
        echo "firstrun"
        return
    fi

    # No first-boot mechanism detected
    echo "none"
}

# ── Get firstboot script ────────────────────────────────────────────────────

get_firstboot_script() {
    local boot_path="$1"
    local local_script="$SCRIPT_DIR/$FIRSTBOOT_SCRIPT"

    if [ -f "$local_script" ]; then
        log_info "Using local $FIRSTBOOT_SCRIPT"
        cp "$local_script" "$boot_path/$FIRSTBOOT_SCRIPT"
    else
        log_info "Downloading $FIRSTBOOT_SCRIPT from GitHub..."
        curl -fsSL "$REPO_RAW/scripts/$FIRSTBOOT_SCRIPT" -o "$boot_path/$FIRSTBOOT_SCRIPT"
    fi

    chmod +x "$boot_path/$FIRSTBOOT_SCRIPT"
    log_success "Copied $FIRSTBOOT_SCRIPT to boot partition"
}

# ── Interactive configuration ────────────────────────────────────────────────

configure_tillit() {
    local boot_path="$1"

    echo ""
    echo -e "${CYAN}╔═══════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║          TilliT Configuration              ║${NC}"
    echo -e "${CYAN}╚═══════════════════════════════════════════╝${NC}"
    echo ""
    echo "  Configure TilliT settings (press Enter to accept defaults)."
    echo ""

    # Network mode
    echo -e "  ${CYAN}Network Mode:${NC}"
    echo "    1) Tor hidden service (recommended — plug & play, anonymous .onion)"
    echo "    2) Cloudflare Tunnel (access from anywhere, no port forwarding)"
    echo "    3) HTTP only (access via local network)"
    echo ""
    read -rp "  Select [1]: " network_choice
    network_choice=${network_choice:-1}

    local network_mode="http"
    local tunnel_token=""

    if [ "$network_choice" = "3" ]; then
        network_mode="http"
    elif [ "$network_choice" = "2" ]; then
        network_mode="tunnel"
        echo ""
        echo -e "  ${CYAN}How to get a Cloudflare Tunnel token:${NC}"
        echo "    1. Go to https://one.dash.cloudflare.com/"
        echo "    2. Networks > Connectors > Create a tunnel"
        echo "    3. Choose \"Cloudflared\" and name it (e.g., \"tillit\")"
        echo "    4. The dashboard shows an install command containing --token <TOKEN>"
        echo "       Copy the command, paste it in a text editor, and extract the token"
        echo "       (the long string after --token)"
        echo -e "    5. Configure Public Hostname: your domain ${DIM}→${NC} http://localhost:3000"
        echo ""
        read -rp "  Cloudflare Tunnel token: " tunnel_token
        if [ -z "$tunnel_token" ]; then
            log_warning "No tunnel token provided — falling back to HTTP mode"
            network_mode="http"
        fi
    else
        network_mode="tor"
        echo ""
        echo -e "  ${DIM}The .onion address will be auto-generated on first boot.${NC}"
        echo -e "  ${DIM}The TilliT app connects natively (built-in Tor support).${NC}"
        log_success "Tor Hidden Service mode selected"
    fi

    # Cloud services
    echo ""
    echo -e "  ${CYAN}TilliT Cloud Services (optional):${NC}"
    echo "    Provides DDNS (your-id.tillit.cc) and push notification relay."
    echo ""
    read -rp "  Enable TilliT Cloud? (y/N): " enable_cloud
    enable_cloud=${enable_cloud:-N}

    local cloud_id=""
    local cloud_token=""
    local ddns_enabled="false"
    local push_include_data="false"

    if [ "$enable_cloud" = "y" ] || [ "$enable_cloud" = "Y" ]; then
        read -rp "  Cloud ID (e.g., my-home-server): " cloud_id
        read -rp "  Cloud Token: " cloud_token

        if [ -n "$cloud_id" ] && [ -n "$cloud_token" ]; then
            echo ""
            read -rp "  Enable DDNS (${cloud_id}.tillit.cc)? (Y/n): " enable_ddns
            enable_ddns=${enable_ddns:-Y}
            if [ "$enable_ddns" != "n" ] && [ "$enable_ddns" != "N" ]; then
                ddns_enabled="true"
            fi

            echo ""
            echo "  Push notification mode:"
            echo "    1) Privacy mode — generic \"New message\" (default)"
            echo "    2) Detailed mode — includes room/sender info"
            read -rp "  Choose [1]: " push_choice
            push_choice=${push_choice:-1}
            if [ "$push_choice" = "2" ]; then
                push_include_data="true"
            fi
        else
            log_warning "Cloud ID or Token missing — cloud services disabled"
        fi
    fi

    # Write env file
    log_info "Writing configuration to $FIRSTBOOT_ENV..."

    cat > "$boot_path/$FIRSTBOOT_ENV" << EOF
# TilliT First-Boot Configuration
# Generated by rpi-setup.sh on $(date '+%Y-%m-%d %H:%M:%S')

NETWORK_MODE=$network_mode
APP_PORT=3000

# Cloud Services
CLOUD_ID=$cloud_id
CLOUD_TOKEN=$cloud_token
DDNS_ENABLED=$ddns_enabled
PUSH_INCLUDE_DATA=$push_include_data
EOF

    if [ -n "$tunnel_token" ]; then
        echo "" >> "$boot_path/$FIRSTBOOT_ENV"
        echo "# Cloudflare Tunnel" >> "$boot_path/$FIRSTBOOT_ENV"
        echo "CLOUDFLARE_TUNNEL_TOKEN=$tunnel_token" >> "$boot_path/$FIRSTBOOT_ENV"
    fi

    log_success "Configuration saved"
}

# ── Shared: TilliT setup shell commands ──────────────────────────────────────

# These commands copy our script from the boot partition to the ext4 filesystem
# and register a systemd service that runs after networking is available.
# Used by both firstrun.sh patching and cloud-init runcmd.

generate_tillit_commands() {
    cat << 'CMDS'
cp /boot/firmware/tillit-firstboot.sh /usr/local/bin/tillit-firstboot.sh 2>/dev/null || cp /boot/tillit-firstboot.sh /usr/local/bin/tillit-firstboot.sh
chmod +x /usr/local/bin/tillit-firstboot.sh
[ -f /boot/firmware/tillit-firstboot.env ] && cp /boot/firmware/tillit-firstboot.env /usr/local/share/tillit-firstboot.env
[ -f /boot/tillit-firstboot.env ] && cp /boot/tillit-firstboot.env /usr/local/share/tillit-firstboot.env
CMDS
}

generate_systemd_unit() {
    cat << 'UNIT'
[Unit]
Description=TilliT First Boot Installation
After=network-online.target time-sync.target
Wants=network-online.target
ConditionPathExists=!/var/lib/tillit-installed

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=600
ExecStart=/usr/local/bin/tillit-firstboot.sh
ExecStartPost=/bin/touch /var/lib/tillit-installed
ExecStartPost=/bin/systemctl disable tillit-install.service

[Install]
WantedBy=multi-user.target
UNIT
}

# ── Mode: cloud-init (Trixie / Imager 2.0+) ─────────────────────────────────

patch_cloudinit() {
    local boot_path="$1"
    local userdata="$boot_path/user-data"

    log_info "Detected cloud-init (Trixie / Imager 2.0+)"

    # Check if already patched
    if grep -q "tillit-firstboot" "$userdata" 2>/dev/null; then
        log_warning "user-data already contains TilliT setup — skipping"
        return 0
    fi

    # Build runcmd block to append to user-data
    # We write the systemd unit via a shell heredoc inside runcmd
    local runcmd_block
    runcmd_block=$(cat << 'RUNCMD'

# --- TilliT First-Boot Setup ---
runcmd:
  - |
    cp /boot/firmware/tillit-firstboot.sh /usr/local/bin/tillit-firstboot.sh 2>/dev/null || cp /boot/tillit-firstboot.sh /usr/local/bin/tillit-firstboot.sh
    chmod +x /usr/local/bin/tillit-firstboot.sh
    [ -f /boot/firmware/tillit-firstboot.env ] && cp /boot/firmware/tillit-firstboot.env /usr/local/share/tillit-firstboot.env
    [ -f /boot/tillit-firstboot.env ] && cp /boot/tillit-firstboot.env /usr/local/share/tillit-firstboot.env
    cat > /etc/systemd/system/tillit-install.service << 'SVCEOF'
    [Unit]
    Description=TilliT First Boot Installation
    After=network-online.target time-sync.target
    Wants=network-online.target
    ConditionPathExists=!/var/lib/tillit-installed

    [Service]
    Type=oneshot
    RemainAfterExit=yes
    TimeoutStartSec=600
    ExecStart=/usr/local/bin/tillit-firstboot.sh
    ExecStartPost=/bin/touch /var/lib/tillit-installed
    ExecStartPost=/bin/systemctl disable tillit-install.service

    [Install]
    WantedBy=multi-user.target
    SVCEOF
    systemctl daemon-reload
    systemctl enable --now tillit-install.service
# --- End TilliT Setup ---
RUNCMD
)

    # Check if user-data already has a runcmd section
    if grep -q "^runcmd:" "$userdata" 2>/dev/null; then
        # Merge: append our commands into the existing runcmd section
        # We insert our commands as a single list item after the existing runcmd: line
        local tmp_file
        tmp_file=$(mktemp)

        local in_runcmd=false
        local inserted=false
        while IFS= read -r line; do
            echo "$line" >> "$tmp_file"
            if [ "$inserted" = false ] && echo "$line" | grep -q "^runcmd:"; then
                in_runcmd=true
            fi
            # Insert after the first item in runcmd (or right after runcmd:)
            if [ "$in_runcmd" = true ] && [ "$inserted" = false ]; then
                cat >> "$tmp_file" << 'MERGE_CMDS'
  # --- TilliT First-Boot Setup ---
  - |
    cp /boot/firmware/tillit-firstboot.sh /usr/local/bin/tillit-firstboot.sh 2>/dev/null || cp /boot/tillit-firstboot.sh /usr/local/bin/tillit-firstboot.sh
    chmod +x /usr/local/bin/tillit-firstboot.sh
    [ -f /boot/firmware/tillit-firstboot.env ] && cp /boot/firmware/tillit-firstboot.env /usr/local/share/tillit-firstboot.env
    [ -f /boot/tillit-firstboot.env ] && cp /boot/tillit-firstboot.env /usr/local/share/tillit-firstboot.env
    cat > /etc/systemd/system/tillit-install.service << 'SVCEOF'
    [Unit]
    Description=TilliT First Boot Installation
    After=network-online.target time-sync.target
    Wants=network-online.target
    ConditionPathExists=!/var/lib/tillit-installed

    [Service]
    Type=oneshot
    RemainAfterExit=yes
    TimeoutStartSec=600
    ExecStart=/usr/local/bin/tillit-firstboot.sh
    ExecStartPost=/bin/touch /var/lib/tillit-installed
    ExecStartPost=/bin/systemctl disable tillit-install.service

    [Install]
    WantedBy=multi-user.target
    SVCEOF
    systemctl daemon-reload
    systemctl enable --now tillit-install.service
  # --- End TilliT Setup ---
MERGE_CMDS
                inserted=true
                in_runcmd=false
            fi
        done < "$userdata"

        cp "$tmp_file" "$userdata"
        rm -f "$tmp_file"
    else
        # No existing runcmd — append our block
        echo "$runcmd_block" >> "$userdata"
    fi

    log_success "Patched user-data with TilliT runcmd block"
}

# ── Mode: firstrun.sh (Bookworm legacy) ─────────────────────────────────────

generate_tillit_block() {
    cat << 'TILLIT_BLOCK'
# --- TilliT First-Boot Setup ---
cp /boot/firmware/tillit-firstboot.sh /usr/local/bin/tillit-firstboot.sh 2>/dev/null || \
cp /boot/tillit-firstboot.sh /usr/local/bin/tillit-firstboot.sh
chmod +x /usr/local/bin/tillit-firstboot.sh
[ -f /boot/firmware/tillit-firstboot.env ] && cp /boot/firmware/tillit-firstboot.env /usr/local/share/tillit-firstboot.env
[ -f /boot/tillit-firstboot.env ] && cp /boot/tillit-firstboot.env /usr/local/share/tillit-firstboot.env
cat > /etc/systemd/system/tillit-install.service << 'SVCEOF'
[Unit]
Description=TilliT First Boot Installation
After=network-online.target time-sync.target
Wants=network-online.target
ConditionPathExists=!/var/lib/tillit-installed

[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=600
ExecStart=/usr/local/bin/tillit-firstboot.sh
ExecStartPost=/bin/touch /var/lib/tillit-installed
ExecStartPost=/bin/systemctl disable tillit-install.service

[Install]
WantedBy=multi-user.target
SVCEOF
systemctl enable tillit-install.service
# --- End TilliT Setup ---
TILLIT_BLOCK
}

patch_firstrun() {
    local boot_path="$1"
    local firstrun="$boot_path/firstrun.sh"

    log_info "Detected firstrun.sh (Bookworm)"

    # Check if already patched
    if grep -q "TilliT First-Boot Setup" "$firstrun"; then
        log_warning "firstrun.sh already contains TilliT setup — skipping patch"
        return 0
    fi

    # Insert our block before the `rm -f` line that removes firstrun.sh
    local tillit_block
    tillit_block=$(generate_tillit_block)

    local tmp_file
    tmp_file=$(mktemp)

    local inserted=false
    while IFS= read -r line; do
        # Match the rm line that deletes firstrun.sh itself
        if [ "$inserted" = false ] && echo "$line" | grep -qE 'rm -f /boot(/firmware)?/firstrun\.sh'; then
            echo "$tillit_block" >> "$tmp_file"
            echo "" >> "$tmp_file"
            inserted=true
        fi
        echo "$line" >> "$tmp_file"
    done < "$firstrun"

    # Fallback: if no rm line was found, append before exit 0 or at the end
    if [ "$inserted" = false ]; then
        log_warning "Could not find 'rm -f' line in firstrun.sh — appending at end"
        echo "" >> "$tmp_file"
        echo "$tillit_block" >> "$tmp_file"
    fi

    cp "$tmp_file" "$firstrun"
    rm -f "$tmp_file"
    chmod +x "$firstrun"

    log_success "Patched firstrun.sh with TilliT setup block"
}

# ── Mode: none — create firstrun.sh + cmdline.txt trigger ────────────────────

create_firstrun() {
    local boot_path="$1"
    local firstrun="$boot_path/firstrun.sh"

    log_info "No first-boot mechanism detected — creating firstrun.sh"

    cat > "$firstrun" << 'HEADER'
#!/bin/bash
set +e
HEADER

    generate_tillit_block >> "$firstrun"

    cat >> "$firstrun" << 'FOOTER'

rm -f /boot/firstrun.sh
rm -f /boot/firmware/firstrun.sh
exit 0
FOOTER

    chmod +x "$firstrun"

    # Add systemd.run trigger to cmdline.txt so the kernel runs firstrun.sh
    local cmdline="$boot_path/cmdline.txt"
    if ! grep -q "systemd.run=" "$cmdline"; then
        log_info "Adding systemd.run trigger to cmdline.txt"
        # Determine the correct path (Bookworm uses /boot/firmware/)
        local firstrun_path="/boot/firmware/firstrun.sh"
        if ! grep -q "root=" "$cmdline" 2>/dev/null; then
            firstrun_path="/boot/firstrun.sh"
        fi
        # Append to the single line in cmdline.txt
        local current
        current=$(cat "$cmdline")
        echo "${current} systemd.run=${firstrun_path} systemd.run_success_action=reboot systemd.unit=kernel-command-line.target" > "$cmdline"
        log_success "Added systemd.run trigger to cmdline.txt"
    else
        log_warning "cmdline.txt already has a systemd.run entry"
    fi

    log_success "Created firstrun.sh with TilliT setup"
}

# ── Patch boot partition (dispatcher) ────────────────────────────────────────

patch_boot() {
    local boot_path="$1"
    local boot_mode
    boot_mode=$(detect_boot_mode "$boot_path")

    case "$boot_mode" in
        cloudinit)
            patch_cloudinit "$boot_path"
            ;;
        firstrun)
            patch_firstrun "$boot_path"
            ;;
        none)
            create_firstrun "$boot_path"
            ;;
    esac
}

# ── Print summary ────────────────────────────────────────────────────────────

print_summary() {
    local boot_path="$1"
    local boot_mode="$2"

    echo ""
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              SD Card Ready!                               ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo "  Files written to: $boot_path"
    echo -e "  Boot mechanism:   ${CYAN}${boot_mode}${NC}"
    echo ""
    echo -e "  ${CYAN}Next steps:${NC}"
    echo "    1. Safely eject the SD card"
    echo "    2. Insert it into your Raspberry Pi"
    echo "    3. Power on the Raspberry Pi"
    echo "    4. Wait ~5-10 minutes for automatic installation"
    echo ""
    echo -e "  ${CYAN}After installation:${NC}"

    # Read the env file to show relevant info
    if [ -f "$boot_path/$FIRSTBOOT_ENV" ]; then
        local net_mode
        net_mode=$(grep "^NETWORK_MODE=" "$boot_path/$FIRSTBOOT_ENV" | cut -d'=' -f2)
        if [ "$net_mode" = "tunnel" ]; then
            echo "    Access TilliT via your Cloudflare Tunnel domain"
        elif [ "$net_mode" = "tor" ]; then
            echo "    Access TilliT via the .onion address (generated on first boot)"
            echo "    SSH into the RPi to retrieve it:"
            echo "      docker compose -f /opt/tillit/docker-compose.yml exec tor cat /var/lib/tor/hidden_service/hostname"
            echo "    The TilliT app connects natively (built-in Tor support)."
        else
            echo "    Access TilliT at: http://<hostname>.local:3000"
        fi
    else
        echo "    Access TilliT at: http://<hostname>.local:3000"
    fi

    echo ""
    echo -e "  ${CYAN}Troubleshooting:${NC}"
    echo "    SSH into the RPi and check:"
    echo "      sudo journalctl -u tillit-install.service"
    echo "      cat /var/log/tillit-install.log"
    echo ""
    echo -e "  ${CYAN}Management (after install):${NC}"
    echo "    SSH into the RPi and run:"
    echo "      tillit status"
    echo "      tillit logs"
    echo ""
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
    print_banner

    # Step 1: Detect boot partition
    log_info "Detecting SD card boot partition..."
    local boot_path
    boot_path=$(detect_boot_partition)
    log_success "Found boot partition: $boot_path"

    # Step 2: Detect boot mechanism
    local boot_mode
    boot_mode=$(detect_boot_mode "$boot_path")

    # Step 3: Copy firstboot script
    get_firstboot_script "$boot_path"

    # Step 4: Interactive configuration
    configure_tillit "$boot_path"

    # Step 5: Patch boot (cloud-init, firstrun.sh, or create from scratch)
    patch_boot "$boot_path"

    # Step 6: Summary
    print_summary "$boot_path" "$boot_mode"
}

main "$@"