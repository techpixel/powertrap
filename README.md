# PowerTrap

A dead-man's-switch for hardware. An **Adafruit ESP32-S3 TFT Feather** sends a
"heartbeat" to a small server on your VPS every few seconds. When the board
loses power (or WiFi, or crashes), the heartbeats stop, the server notices
within about a minute, and **pushes a notification to your phone** — plus
optional email, phone call, or SMS.

```
  ESP32-S3 TFT ──heartbeat every 20s──▶  VPS server ──▶  ntfy push / email / call
   (on your desk)      HTTP POST          (watchdog)      (when beats stop)
```

- **Instant-ish**: alerts fire ~70s after power loss (tunable).
- **No false alarms**: tolerates brief WiFi blips and reboots before alerting.
- **Won't spam you**: one alert, repeated every 5 min while down, then an
  all-clear when the device comes back.
- **Free by default**: [ntfy](https://ntfy.sh) push needs no paid account.

---

## Repo layout

```
firmware/powertrap/     Arduino sketch for the ESP32-S3 TFT Feather
server/                 Node.js watchdog + notifier for your VPS
```

---

## 1. Server (on your VPS)

Needs Node 18+ (you have 25 — great).

```bash
cd server
npm install
cp .env.example .env
```

Edit `.env`:

- Set **`SHARED_TOKEN`** to a long random string (`openssl rand -hex 24`).
  The ESP must send this exact value.
- Set **`NTFY_TOPIC`** to something random and hard to guess, e.g.
  `powertrap-7fa39c2b`. Anyone who knows the topic can read your alerts, so
  don't use a guessable name.

Run it:

```bash
npm start
# PowerTrap server listening on :8080
# channels: ntfy(push)
```

### Get the push notifications on your phone

1. Install the **ntfy** app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [iOS](https://apps.apple.com/us/app/ntfy/id1625396347)).
2. Tap **+**, add your `NTFY_TOPIC` (leave server as `ntfy.sh`).
3. Test it end to end:

   ```bash
   curl -X POST -H "Authorization: Bearer YOUR_TOKEN" http://YOUR_VPS_IP:8080/test-alert
   ```

   Your phone should buzz within a second. (Priority is `high` — a normal
   heads-up push, not an alarm. Set `NTFY_PRIORITY=max` later if you ever want
   the loud DND-bypassing version.)

### Keep it running (systemd)

```bash
sudo cp -r . /opt/powertrap/server        # or clone there
# edit server/powertrap.service paths/user, then:
sudo cp powertrap.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now powertrap
journalctl -u powertrap -f
```

### Status page

Visit `http://YOUR_VPS_IP:8080/status` — a live page showing online/down, last
heartbeat, signal, uptime, and which channels are armed.

> **Firewall/port:** open the port (default 8080), or better, put it behind
> Caddy/nginx with HTTPS and a domain. If you use HTTPS, set `SERVER_URL` in the
> firmware to `https://...` **and** flip `USE_TLS` to `1` in the sketch.

---

## 2. Firmware (on the ESP32-S3 TFT Feather)

**Arduino IDE setup** (one time):

1. **File → Preferences → Additional Boards Manager URLs**, add:
   `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
2. **Tools → Board → Boards Manager** → install **esp32 by Espressif**.
3. **Tools → Board** → select **Adafruit Feather ESP32-S3 TFT**.
4. **Tools → Manage Libraries**, install:
   - Adafruit GFX Library
   - Adafruit ST7735 and ST7789 Library
   - Adafruit NeoPixel

**Configure + upload:**

```bash
cd firmware/powertrap
cp secrets.example.h secrets.h
```

Edit `secrets.h`:

- `WIFI_SSID` / `WIFI_PASS` — your network.
- `SERVER_URL` — `http://YOUR_VPS_IP:8080/heartbeat`.
- `SHARED_TOKEN` — **must match** the server `.env`.
- `DEVICE_ID` — a name for this board.

Then plug in the board, pick the port, and hit **Upload**.

The TFT shows: a big `ONLINE` / `WIFI...` / `SEND FAIL` status, plus SSID,
signal, IP, last-good-beat age, and success/fail counts. The onboard NeoPixel is
green when the last heartbeat succeeded, red when it failed, blue while sending.

---

## 3. Try it

1. Server running, ESP showing `ONLINE`, `/status` shows **ONLINE**.
2. **Unplug the ESP.**
3. In ~70 seconds your phone gets: *"🔴 PowerTrap: powertrap-1 is DOWN…"*.
4. Plug it back in → within a beat you get: *"🟢 … recovered"*.

---

## Tuning

Edit `server/.env` (server side) to trade speed vs false alarms:

| Setting | Default | Meaning |
|---|---|---|
| `TIMEOUT_SECONDS` | 70 | Silence before it alerts (~3 missed beats) |
| `CHECK_INTERVAL_SECONDS` | 5 | How often the watchdog checks |
| `RENOTIFY_SECONDS` | 300 | Re-alert cadence while still down |
| `MAX_RENOTIFY` | 6 | Cap on repeated alerts |

The heartbeat interval itself is `HEARTBEAT_INTERVAL_MS` in the sketch (20s).
Keep `TIMEOUT_SECONDS` at roughly 3× that so a single dropped beat or a quick
WiFi reconnect never trips a false alarm.

---

## Extra alert channels (all optional)

Uncomment the relevant block in `.env` — each activates automatically:

- **Email** — any SMTP (Gmail App Password works). Great as a durable backup.
- **Twilio voice call** — an actual phone call reading the alert aloud. Only
  fires on **down** events. Uses your Twilio number + credits.
- **Twilio SMS** — set `TWILIO_ENABLE_SMS=true`.

They all fire in parallel; if one provider is down the others still get through.

---

## Nice add-ons (not built in, easy to add)

- **UPS early-warning**: plug a LiPo into the Feather and set `ENABLE_BATTERY 1`
  in the sketch (needs the *Adafruit MAX1704X* library). The board keeps running
  on battery during an outage and reports its charge %, so you get a heads-up
  *before* it dies — and the `/status` page shows the battery level.
- **Multiple devices**: run one server per `DEVICE_ID`, or extend the server's
  state map to key by the `device` field in the heartbeat body.

---

## Security notes

- The `SHARED_TOKEN` stops randoms from POSTing fake heartbeats (which would
  *suppress* your alert). Keep it long and secret.
- Over plain HTTP the token travels in the clear — fine on a trusted LAN, but
  for anything internet-facing put the server behind HTTPS (Caddy/nginx) and use
  `USE_TLS 1` in the firmware.
- Your ntfy topic name is effectively a password — keep it random.
```
