# Self-Hosted DNS & Network Options

TilliT's default setup uses `tillit.cc` DDNS for automatic domain resolution, but this is entirely optional. This guide covers all the ways to make your TilliT box reachable.

---

## Option 1: Default — tillit.cc DDNS

How it works out of the box:

1. Your TilliT box runs the `DdnsModule`, which periodically sends its public IP to the TilliT cloud worker
2. The cloud worker updates a Cloudflare DNS record: `<your-box-id>.tillit.cc → <your-ip>`
3. Clients connect to `<your-box-id>.tillit.cc`

**Configuration** (`.env`):
```env
DDNS_ENABLED=true
CLOUD_WORKER_URL=https://worker.tillit.cc
CLOUD_ID=your-box-id
CLOUD_TOKEN=your-box-token
DDNS_UPDATE_INTERVAL=300000  # 5 minutes
```

**Pros**: Zero configuration, automatic HTTPS via Caddy + ACME-DNS.
**Cons**: Depends on `tillit.cc` infrastructure being available.

---

## Option 2: Static IP / Your Own DNS

If your server has a static IP (or you manage your own DNS), disable DDNS and point your domain manually.

**Configuration** (`.env`):
```env
DDNS_ENABLED=false
```

**Steps**:
1. Set `DDNS_ENABLED=false` in your `.env`
2. Create an A record in your DNS provider: `chat.yourdomain.com → <server-ip>`
3. For HTTPS, use `docker-compose.https.yml` with Caddy — update the `Caddyfile` to use your domain
4. Clients connect to `chat.yourdomain.com`

**Pros**: Full control, no external dependencies.
**Cons**: Requires DNS management and a static IP (or your own dynamic DNS solution).

---

## Option 3: Custom Reverse Proxy

If you already run Nginx, Traefik, Caddy, or another reverse proxy, you can put TilliT behind it.

**Configuration** (`.env`):
```env
DDNS_ENABLED=false
```

Use `docker-compose.selfhosted.yml` (HTTP-only) and let your proxy handle TLS termination.

**Nginx example**:
```nginx
server {
    listen 443 ssl;
    server_name chat.yourdomain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**Important**: WebSocket support (`Upgrade` + `Connection` headers) is required for Socket.IO to work.

---

## Option 4: Tailscale / WireGuard (Private Network)

For private deployments where you don't want to expose any ports to the internet.

**Tailscale** (easiest):
1. Install Tailscale on the TilliT box and on all client devices
2. Set `DDNS_ENABLED=false`
3. Clients connect via the Tailscale IP (e.g., `100.x.y.z:3000`) or MagicDNS hostname
4. No port forwarding or public DNS needed

**WireGuard** (manual):
1. Set up a WireGuard tunnel between the box and client devices
2. Clients connect via the WireGuard IP
3. Same zero-exposure benefit, more setup required

**Pros**: No public exposure, no DNS needed, encrypted tunnel layer on top of E2E encryption.
**Cons**: All users need Tailscale/WireGuard installed, not suitable for open-access deployments.

---

## Option 5: Cloudflare Tunnel

TilliT includes a ready-made Docker Compose file for Cloudflare Tunnel:

```bash
docker compose -f docker-compose.tunnel.yml up -d
```

**Configuration** (`.env`):
```env
DDNS_ENABLED=false
CLOUDFLARE_TUNNEL_TOKEN=your-tunnel-token
```

**Steps**:
1. Create a tunnel in the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
2. Configure the tunnel to point to `http://tillit:3000`
3. Set your tunnel token in `.env`
4. Clients connect to the Cloudflare-assigned hostname

**Pros**: No port forwarding, automatic HTTPS, Cloudflare DDoS protection.
**Cons**: Depends on Cloudflare, requires a Cloudflare account.

---

## Option 6: Self-Host the Cloud Worker

If you want the DDNS experience but don't want to depend on `tillit.cc`, you can run your own compatible cloud worker. The worker is a simple HTTP API that updates Cloudflare DNS records.

**Steps**:
1. Deploy a DDNS relay to your own infrastructure (Cloudflare Workers, VPS, etc.)
2. Configure it with your own Cloudflare API token and DNS zone
3. Point your TilliT box to your worker:

```env
DDNS_ENABLED=true
CLOUD_WORKER_URL=https://worker.yourdomain.com
CLOUD_ID=your-box-id
CLOUD_TOKEN=your-box-token
```

This gives you the same plug-and-play DDNS behavior, fully under your control.

---

## Option 7: Tor Hidden Service

Access your TilliT server anonymously via a `.onion` address. No port forwarding, domain registration, or external accounts needed. The `.onion` address is auto-generated on first start and persisted across restarts.

**Docker setup** (recommended):
```bash
docker compose -f docker-compose.tor.yml up -d

# Wait ~60 seconds for Tor bootstrap, then:
docker compose -f docker-compose.tor.yml exec tor cat /var/lib/tor/hidden_service/hostname
```

This runs a Tor sidecar container that relays `.onion:80 → tillit:3000` via Docker network.

**Bare-metal setup**:
```bash
# Install Tor
sudo apt install tor    # Debian/Ubuntu
brew install tor        # macOS

# Add to /etc/tor/torrc (or $(brew --prefix)/etc/tor/torrc on macOS):
HiddenServiceDir /var/lib/tor/tillit_hidden_service/
HiddenServicePort 80 127.0.0.1:3000

# Restart Tor
sudo systemctl restart tor    # Linux
brew services restart tor     # macOS

# Get your .onion address
cat /var/lib/tor/tillit_hidden_service/hostname
```

**Client support**: The TilliT mobile app has built-in Tor support (arti on iOS, ctor on Android) — no extra apps or configuration needed.

**WebSocket note**: Socket.IO works over Tor but may fall back to HTTP long-polling due to latency. TilliT's pending message queue handles reconnections gracefully.

**Pros**: Maximum anonymity, zero configuration, no external dependencies, no port forwarding, plug & play.
**Cons**: Higher latency (~1-3s), .onion addresses are not human-readable.

---

## Summary

| Option | Public DNS | Port Forwarding | External Dependency | Complexity |
|--------|-----------|-----------------|---------------------|------------|
| tillit.cc DDNS | Yes | Yes | tillit.cc | None |
| Own DNS | Yes | Yes | None | Low |
| Reverse Proxy | Yes | Yes | None | Medium |
| Tailscale/WireGuard | No | No | Tailscale (optional) | Low-Medium |
| Cloudflare Tunnel | Yes | No | Cloudflare | Low |
| Self-host Worker | Yes | Yes | None | Medium |
| Tor Hidden Service | No (.onion) | No | None | None |
