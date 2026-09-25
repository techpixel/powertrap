#pragma once
// -----------------------------------------------------------------------------
//  Copy this file to  secrets.h  and fill in your real values.
//  secrets.h is gitignored so your credentials never get committed.
// -----------------------------------------------------------------------------

#define WIFI_SSID     "your-wifi-ssid"
#define WIFI_PASS     "your-wifi-password"

// Full URL to the /heartbeat endpoint on your VPS.
//   http  -> set USE_TLS 0 in powertrap.ino  (default)
//   https -> set USE_TLS 1 in powertrap.ino
#define SERVER_URL    "http://YOUR_VPS_IP:8080/heartbeat"

// Must match SHARED_TOKEN in the server's .env exactly.
// Generate a long random one, e.g.:  openssl rand -hex 24
#define SHARED_TOKEN  "change-me-to-a-long-random-string"

// A friendly name for this device; shows up in the alerts.
#define DEVICE_ID     "sibo-1"
