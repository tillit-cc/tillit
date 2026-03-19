# Raspberry Pi Zero-Terminal Setup

Install TilliT on a Raspberry Pi without ever opening a terminal. Flash the SD card, run one script on your PC, plug in the Pi, done.

## Prerequisites

- **Raspberry Pi** 4/5 (or any ARM64 board with 2GB+ RAM)
- **SD card** 32GB+ (Class 10 / A1 recommended)
- **Raspberry Pi Imager** installed on your PC ([download](https://www.raspberrypi.com/software/))
- **PC** running macOS or Linux (Windows: see [Manual Setup](#windows-manual-setup) below)

## Step-by-Step

### 1. Flash Raspberry Pi OS

1. Open **Raspberry Pi Imager**
2. Choose OS: **Raspberry Pi OS Lite (64-bit)** (under "Raspberry Pi OS (other)")
3. Choose your SD card
4. Click the **gear icon** (or Ctrl+Shift+X) to open Advanced Options:
   - **Set hostname**: e.g., `tillit` (you'll access TilliT at `tillit.local`)
   - **Enable SSH**: password or public key
   - **Configure WiFi**: enter your SSID and password
   - **Set username/password**
5. Click **Write** and wait for completion

### 2. Re-insert the SD card

After flashing, **eject and re-insert** the SD card so the boot partition mounts on your PC.

- macOS: appears as `/Volumes/bootfs`
- Linux: appears as `/media/<user>/bootfs` or `/run/media/<user>/bootfs`

### 3. Run the setup tool

Open a terminal on your PC and run:

```bash
curl -fsSL https://raw.githubusercontent.com/tillit-cc/tillit/main/scripts/rpi-setup.sh | bash
```

Or if you've cloned the repo:

```bash
./scripts/rpi-setup.sh
```

The script will:
1. Auto-detect the boot partition
2. Ask optional configuration questions (network mode, cloud services)
3. Copy the installation script to the SD card
4. Patch the Raspberry Pi first-boot script

### 4. Boot the Raspberry Pi

1. **Safely eject** the SD card from your PC
2. Insert it into the Raspberry Pi
3. Connect power

The Pi will:
1. Boot and configure WiFi/SSH (from Imager settings)
2. Reboot automatically
3. Install Docker (~2-3 minutes)
4. Download and start TilliT (~2-3 minutes)

**Total time: ~5-10 minutes** (varies by internet speed)

### 5. Connect

Open the TilliT app and connect to:

```
http://<hostname>.local:3000
```

For example, if you set hostname to `tillit`:

```
http://tillit.local:3000
```

## Configuration Options

During `rpi-setup.sh`, you can configure:

| Option | Default | Description |
|--------|---------|-------------|
| Network Mode | HTTP | HTTP only (local network) or Cloudflare Tunnel (remote access) |
| Cloudflare Tunnel | disabled | Provide a tunnel token for secure remote access without port forwarding |
| TilliT Cloud | disabled | DDNS (`your-id.tillit.cc`) and push notification relay |
| DDNS | disabled | Automatic domain registration (requires TilliT Cloud) |
| Push Data Mode | privacy | Generic "New message" vs detailed notifications |

All options can be changed later by SSHing into the Pi and running `tillit config`.

### How to get a Cloudflare Tunnel token

If you choose Cloudflare Tunnel mode, you need a token from the Cloudflare dashboard:

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/)
2. Navigate to **Networks > Connectors**
3. Click **Create a tunnel**
4. Choose **Cloudflared** and give it a name (e.g., "tillit")
5. The dashboard shows an install command like:
   ```
   cloudflared service install eyJhIjoiNmQ3...very-long-string
   ```
   The dashboard does **not** let you copy the token alone — copy the entire command, paste it into a text editor, and extract the token (the long string after `--token` or after `service install`)
6. Go to **Public Hostname** tab and add a route:
   - **Domain**: your domain (e.g., `chat.example.com`)
   - **Service**: `http://localhost:3000`

Paste this token when `rpi-setup.sh` asks for it.

## Troubleshooting

### Check installation status

SSH into the Raspberry Pi:

```bash
ssh <username>@<hostname>.local
```

Then check:

```bash
# Installation service status
sudo systemctl status tillit-install.service

# Installation log (most useful)
cat /var/log/tillit-install.log

# TilliT service status (after install)
tillit status

# TilliT logs
tillit logs
```

### Common issues

**Pi doesn't connect to WiFi**
- Re-flash with Imager and double-check WiFi credentials in Advanced Options
- Ensure your WiFi is 2.4GHz (RPi 4 may not see 5GHz on first boot)

**Installation service didn't run**
- Check if `firstrun.sh` was correctly patched: `cat /boot/firmware/firstrun.sh` (or `/boot/firstrun.sh`)
- Verify the systemd service exists: `systemctl cat tillit-install.service`

**Docker install failed**
- Check network: `ping -c 3 google.com`
- Retry manually: `sudo /usr/local/bin/tillit-firstboot.sh`

**TilliT containers won't start**
- Check Docker: `docker ps -a` and `docker compose -f /opt/tillit/docker-compose.yml logs`
- Check disk space: `df -h`

### Retry installation

If the installation failed, it will automatically retry on next reboot. Or run manually:

```bash
sudo /usr/local/bin/tillit-firstboot.sh
```

## Windows Manual Setup

Windows doesn't run bash scripts natively. After flashing with Raspberry Pi Imager:

1. Open the `bootfs` drive in File Explorer

2. Download `tillit-firstboot.sh` from GitHub and copy it to the `bootfs` drive

3. Optionally create `tillit-firstboot.env` with your settings (see [Configuration Options](#configuration-options)):
   ```
   NETWORK_MODE=http
   APP_PORT=3000
   CLOUD_ID=
   CLOUD_TOKEN=
   DDNS_ENABLED=false
   PUSH_INCLUDE_DATA=false
   ```

4. Check which boot mechanism your image uses:
   - If you see a `user-data` file: you have **Trixie / cloud-init** — see [Cloud-init instructions](#windows-cloud-init) below
   - If you see a `firstrun.sh` file: you have **Bookworm / legacy** — see [firstrun.sh instructions](#windows-firstrun) below
   - If neither exists: follow the firstrun.sh instructions (you'll also need to edit `cmdline.txt`)

### Windows: cloud-init (Trixie) {#windows-cloud-init}

Open `user-data` in a text editor (Notepad++). Add the following at the end:

```yaml
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
```

If `user-data` already has a `runcmd:` section, merge the commands into it (don't add a second `runcmd:` key).

Save with **Unix line endings** (LF). In Notepad++: Edit > EOL Conversion > Unix (LF).

### Windows: firstrun.sh (Bookworm) {#windows-firstrun}

Open `firstrun.sh` in a text editor like Notepad++. **Before** the line `rm -f /boot/firmware/firstrun.sh`, add:
   ```bash
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
   ```

5. **Important**: Save with Unix line endings (LF, not CRLF). In Notepad++: Edit > EOL Conversion > Unix (LF)

6. Safely eject and boot the Pi

## Supported Boot Mechanisms

`rpi-setup.sh` auto-detects which mechanism the SD card uses:

| RPi OS Version | Imager | Mechanism | How detected |
|----------------|--------|-----------|--------------|
| **Trixie** (Nov 2025+) | 2.0+ | cloud-init (`user-data`) | `user-data` file on boot partition |
| **Bookworm** (older) | 1.x | `firstrun.sh` | `firstrun.sh` file on boot partition |
| **None detected** | — | Creates `firstrun.sh` + `cmdline.txt` trigger | Fallback |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Your PC                              │
│                                                       │
│  1. Raspberry Pi Imager → Flash OS + WiFi/SSH config  │
│  2. rpi-setup.sh        → Copy scripts + patch boot   │
└──────────────────────────┬────────────────────────────┘
                           │ SD card
                           ▼
┌─────────────────────────────────────────────────────┐
│              Raspberry Pi Boot Sequence                │
│                                                       │
│  Phase 1: first-boot (no network or early boot)       │
│    cloud-init runcmd / firstrun.sh:                   │
│    └─ Copies tillit-firstboot.sh to /usr/local/bin    │
│    └─ Registers tillit-install.service (systemd)      │
│    └─ Reboots (firstrun.sh) or continues (cloud-init) │
│                                                       │
│  Phase 2: tillit-install.service (with network)       │
│    └─ Installs Docker                                 │
│    └─ Downloads docker-compose + .env                 │
│    └─ Starts TilliT containers                        │
│    └─ Installs tillit CLI                             │
│    └─ Disables itself (one-shot)                      │
└─────────────────────────────────────────────────────┘
```
