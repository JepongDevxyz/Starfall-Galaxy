# Starfall Galaxy — 2-Player Space Shooter

A side-scrolling space shooter inspired by ML-style event mini-games, with original
Canvas-drawn characters (no copyrighted art). Fly on the left, auto-shoot pink petal
starshots, dodge and blast meteors, collect **10 crystals**, use shield / rapid-fire /
stellar-energy bubbles, charge your **Nova** skill (max 2/2), and take down the
**Pillar of Creation** boss that appears every 60 seconds.

## Game modes

| Mode | How it works |
| --- | --- |
| **Solo** | 1 player, 3 hearts. |
| **Local 2P** | Same screen co-op. P1: `WASD` + `Space`/`E` skill. P2: arrow keys + `/` or `.` skill. On touch devices there are two joysticks. A downed player respawns after 5s while their partner is alive; the mission ends when both are down at once. |
| **Online 2P** | Host clicks **Create Room** and gets a 4-letter code. Player 2 opens the same site on another device, enters the code under **Join**, and the game starts automatically. The host runs the simulation and streams state snapshots (~18/sec); the guest only sends inputs. |

Controls: shooting is automatic. Pause with the HUD button or `P` / `Esc`.
Scoring: small meteor 100, medium 200, large crystal rock 300, Stellar Energy bubble
+500, 10 crystals = +1000 bonus, Pillar of Creation +2000.

## Run locally (no install, zero dependencies)

Requires Node.js 18+ only — there is nothing to `npm install`.

```bash
node server.js
# → Starfall Galaxy listening on http://localhost:8080
```

Open http://localhost:8080 on the host PC/phone browser. To test Online 2P on your
LAN, open `http://<your-lan-ip>:8080` on a second device, create a room on one
device and join with the code on the other.

Health check: `curl http://localhost:8080/healthz` → `{"ok":true,"rooms":0}`

## Deploy on Oracle Cloud (Ubuntu instance)

### 1. Copy the game to the instance

From your machine:

```bash
scp -r stellar-2p-game ubuntu@<instance-public-ip>:~/
ssh ubuntu@<instance-public-ip>
sudo mv ~/stellar-2p-game /opt/stellar-2p-game
```

### 2. Install Node.js (if not present)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

### 3. Open the port

- **Oracle Cloud Console:** Networking → Virtual Cloud Networks → your VCN →
  Security Lists → Default Security List → Add Ingress Rule:
  Source `0.0.0.0/0`, IP Protocol **TCP**, Destination Port **8080**.
- **On the instance (iptables/ufw):** Oracle Ubuntu images ship with restrictive
  iptables rules, so also run:

  ```bash
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8080 -j ACCEPT
  sudo netfilter-persistent save   # if netfilter-persistent is installed
  # or, if you use ufw instead:
  sudo ufw allow 8080/tcp
  ```

### 4. Run it as a service (systemd)

```bash
sudo cp /opt/stellar-2p-game/deploy/stellar-game.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now stellar-game
sudo systemctl status stellar-game
curl http://localhost:8080/healthz
```

Then visit `http://<instance-public-ip>:8080` from any phone or PC.

Quick alternative without systemd: `sudo npm i -g pm2 && cd /opt/stellar-2p-game && PORT=8080 pm2 start server.js --name stellar-game && pm2 save && pm2 startup`

### 5. (Optional) nginx reverse proxy + your domain

Point your domain's DNS A record at the instance, open ports 80/443 the same way as
step 3, then:

```nginx
server {
    listen 80;
    server_name game.example.com;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # needed for WebSocket (online 2P)
        proxy_set_header Connection "upgrade";       # needed for WebSocket (online 2P)
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Add HTTPS with `sudo apt install certbot python3-certbot-nginx && sudo certbot --nginx -d game.example.com`.
With HTTPS the game automatically uses secure WebSockets (`wss://`) — no code change needed.

## Files

```
server.js                  zero-dependency static server + hand-written WebSocket rooms
public/index.html          menu / HUD / lobby / pause / game-over UI
public/game.js             full game engine (Canvas, WebAudio synth sounds)
deploy/stellar-game.service  systemd unit
package.json               "npm start" → node server.js (no dependencies)
```
