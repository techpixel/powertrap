// =============================================================================
//  PowerTrap server — receives heartbeats and alerts when they stop.
// =============================================================================
import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { sendDownAlert, sendRecovery, sendTest, enabledChannels } from './notify.js';

// ---- config -----------------------------------------------------------------
const cfg = {
  port: Number(process.env.PORT || 8080),
  token: process.env.SHARED_TOKEN || '',
  device: process.env.DEVICE_ID || 'sibo',
  timeoutMs: Number(process.env.TIMEOUT_SECONDS || 70) * 1000,     // alert after this much silence
  checkMs: Number(process.env.CHECK_INTERVAL_SECONDS || 5) * 1000, // how often the watchdog runs
  renotifyMs: Number(process.env.RENOTIFY_SECONDS || 300) * 1000,  // re-alert cadence while down
  maxRenotify: Number(process.env.MAX_RENOTIFY || 6),             // cap on repeated alerts
  publicUrl: process.env.PUBLIC_URL || '',                        // used for notification click links
  basicAuthUser: process.env.BASIC_AUTH_USER || '',              // guards the /status page (browser login)
  basicAuthPass: process.env.BASIC_AUTH_PASS || '',
};

if (!cfg.token) {
  console.error('FATAL: SHARED_TOKEN is not set. Copy .env.example to .env and set it.');
  process.exit(1);
}

// ---- state ------------------------------------------------------------------
// Start "seen now" so a server restart gives the device time to check back in
// (no false alarm on deploy). We wait timeoutMs before the first possible alert.
const state = {
  bootAt: Date.now(),
  lastSeen: Date.now(),
  lastMeta: null,
  down: false,
  downSince: 0,
  lastNotifiedAt: 0,
  notifyCount: 0,
  alertsSent: 0,
};

// ---- app --------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '8kb' }));

function authed(req) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.token;
  return token === cfg.token;
}

// Constant-time string compare that won't throw on length mismatch.
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// HTTP Basic Auth for the browser-facing /status page. No-op unless both
// BASIC_AUTH_USER and BASIC_AUTH_PASS are set, so existing deploys stay open.
function basicAuth(req, res, next) {
  if (!cfg.basicAuthUser || !cfg.basicAuthPass) return next();

  const h = req.get('authorization') || '';
  if (h.startsWith('Basic ')) {
    const [user, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
    if (user != null && pass != null && safeEqual(user, cfg.basicAuthUser) && safeEqual(pass, cfg.basicAuthPass)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', `Basic realm="PowerTrap ${cfg.device}", charset="UTF-8"`);
  return res.status(401).send('Authentication required.');
}

// The ESP posts here on a fixed interval.
app.post('/heartbeat', (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const now = Date.now();
  const wasDown = state.down;
  const downSince = state.downSince;

  state.lastSeen = now;
  state.lastMeta = req.body || {};

  if (wasDown) {
    state.down = false;
    state.notifyCount = 0;
    console.log(`[watchdog] ${cfg.device} RECOVERED after ${Math.round((now - downSince) / 1000)}s`);
    sendRecovery({ downForMs: now - downSince, meta: state.lastMeta, statusUrl: statusLink() })
      .catch((e) => console.error('[notify] recovery error', e));
  }

  res.json({ ok: true, timeoutSeconds: cfg.timeoutMs / 1000 });
});

// Manual test of the alert pipeline:  curl -X POST -H "Authorization: Bearer TOKEN" .../test-alert
app.post('/test-alert', (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  sendTest().catch((e) => console.error('[notify] test error', e));
  res.json({ ok: true, channels: enabledChannels() });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Root just points at the human-facing status page.
app.get('/', (_req, res) => res.redirect('/status'));

// Human-friendly status page (auto-refreshes). Guarded by HTTP Basic Auth.
app.get('/status', basicAuth, (_req, res) => {
  const silence = Date.now() - state.lastSeen;
  const up = !state.down;
  const meta = state.lastMeta || {};
  res.type('html').send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>SIBO · ${cfg.device}</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:2rem;}
  .card{max-width:520px;margin:auto;background:#171a21;border:1px solid #262b36;border-radius:14px;padding:1.5rem 1.75rem;}
  h1{font-size:1.1rem;margin:0 0 1rem;letter-spacing:.5px;color:#7cd;}
  .badge{display:inline-block;padding:.35rem .9rem;border-radius:999px;font-weight:700;}
  .up{background:#12351f;color:#5ee08a;} .down{background:#3a1414;color:#ff6b6b;}
  table{width:100%;border-collapse:collapse;margin-top:1.1rem;}
  td{padding:.4rem 0;border-top:1px solid #262b36;}
  td:first-child{color:#8a93a6;width:42%;}
  code{color:#9ecbff;}
</style>
<div class="card">
  <h1>SIBO · ${cfg.device}</h1>
  <span class="badge ${up ? 'up' : 'down'}">${up ? 'ONLINE' : 'DOWN'}</span>
  <table>
    <tr><td>last heartbeat</td><td>${Math.round(silence / 1000)}s ago</td></tr>
    <tr><td>alert threshold</td><td>${cfg.timeoutMs / 1000}s of silence</td></tr>
    <tr><td>device uptime</td><td>${meta.uptime != null ? meta.uptime + 's' : '—'}</td></tr>
    <tr><td>wifi rssi</td><td>${meta.rssi != null ? meta.rssi + ' dBm' : '—'}</td></tr>
    ${meta.battery != null ? `<tr><td>battery</td><td>${meta.battery}%</td></tr>` : ''}
    <tr><td>alerts sent</td><td>${state.alertsSent}</td></tr>
    <tr><td>channels</td><td><code>${enabledChannels().join(', ') || 'none'}</code></td></tr>
    <tr><td>server uptime</td><td>${Math.round((Date.now() - state.bootAt) / 1000)}s</td></tr>
  </table>
</div>`);
});

function statusLink() {
  return cfg.publicUrl ? `${cfg.publicUrl.replace(/\/$/, '')}/status` : undefined;
}

// ---- watchdog ---------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  const silence = now - state.lastSeen;
  if (silence <= cfg.timeoutMs) return;

  if (!state.down) {
    state.down = true;
    state.downSince = state.lastSeen; // it "went down" at the last time we heard from it
    state.notifyCount = 0;
    console.warn(`[watchdog] ${cfg.device} DOWN — no heartbeat for ${Math.round(silence / 1000)}s`);
  }

  const dueForRenotify = now - state.lastNotifiedAt >= cfg.renotifyMs;
  if (state.notifyCount < cfg.maxRenotify && (state.notifyCount === 0 || dueForRenotify)) {
    state.lastNotifiedAt = now;
    state.notifyCount += 1;
    state.alertsSent += 1;
    sendDownAlert({ silenceMs: silence, timeoutSeconds: cfg.timeoutMs / 1000, statusUrl: statusLink() })
      .catch((e) => console.error('[notify] down error', e));
  }
}, cfg.checkMs);

// ---- go ---------------------------------------------------------------------
app.listen(cfg.port, () => {
  console.log(`SIBO server listening on :${cfg.port}`);
  console.log(`  device        : ${cfg.device}`);
  console.log(`  alert after   : ${cfg.timeoutMs / 1000}s of silence`);
  console.log(`  re-alert every: ${cfg.renotifyMs / 1000}s (max ${cfg.maxRenotify})`);
  console.log(`  channels      : ${enabledChannels().join(', ') || 'NONE — configure .env!'}`);
});
