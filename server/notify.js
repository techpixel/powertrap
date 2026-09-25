// =============================================================================
//  Notifiers — pluggable alert channels.
//  Every channel switches ON automatically when its env vars are present.
//  Channels fire in parallel; one failing never blocks the others.
// =============================================================================
const env = process.env;

const DEVICE = env.DEVICE_ID || 'sibo';

// ---- which channels are configured? ----------------------------------------
const ntfyOn      = () => !!env.NTFY_TOPIC;
const emailOn     = () => !!(env.SMTP_HOST && env.MAIL_TO);
const twilioCallOn = () =>
  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && env.TWILIO_TO);
const twilioSmsOn = () =>
  twilioCallOn() && String(env.TWILIO_ENABLE_SMS).toLowerCase() === 'true';

export function enabledChannels() {
  const list = [];
  if (ntfyOn()) list.push('ntfy(push)');
  if (emailOn()) list.push('email');
  if (twilioCallOn()) list.push('twilio(call)');
  if (twilioSmsOn()) list.push('twilio(sms)');
  return list;
}

// ---- individual channels ----------------------------------------------------
async function pushNtfy({ title, message, priority, tags, click }) {
  const base = (env.NTFY_URL || 'https://ntfy.sh').replace(/\/$/, '');
  const url = `${base}/${env.NTFY_TOPIC}`;
  const headers = {
    Title: title,
    Priority: String(priority || env.NTFY_PRIORITY || 'high'),
    Tags: (tags || []).join(','),
  };
  if (click) headers.Click = click;
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;

  const res = await fetch(url, { method: 'POST', headers, body: message });
  if (!res.ok) throw new Error(`ntfy ${res.status} ${await res.text()}`);
}

let _mailer = null;
async function getMailer() {
  if (_mailer) return _mailer;
  const { default: nodemailer } = await import('nodemailer');
  _mailer = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: String(env.SMTP_SECURE).toLowerCase() === 'true', // true for port 465
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return _mailer;
}

async function sendEmail({ title, message }) {
  const mailer = await getMailer();
  await mailer.sendMail({
    from: env.MAIL_FROM || env.SMTP_USER,
    to: env.MAIL_TO,
    subject: title,
    text: message,
  });
}

let _twilio = null;
async function getTwilio() {
  if (_twilio) return _twilio;
  const { default: twilio } = await import('twilio');
  _twilio = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return _twilio;
}

async function placeCall({ message }) {
  const client = await getTwilio();
  const spoken = message.replace(/&/g, 'and').replace(/[<>]/g, '');
  await client.calls.create({
    to: env.TWILIO_TO,
    from: env.TWILIO_FROM,
    twiml: `<Response><Pause length="1"/><Say voice="alice" loop="2">${spoken}</Say></Response>`,
  });
}

async function sendSms({ message }) {
  const client = await getTwilio();
  await client.messages.create({
    to: env.TWILIO_TO,
    from: env.TWILIO_FROM,
    body: message,
  });
}

// ---- dispatch ---------------------------------------------------------------
// kind: 'down' | 'up' | 'test'.  A phone call only happens for 'down'.
async function dispatch(kind, { title, message, priority, tags, click }) {
  const jobs = [];
  if (ntfyOn()) jobs.push(['ntfy', pushNtfy({ title, message, priority, tags, click })]);
  if (emailOn()) jobs.push(['email', sendEmail({ title, message })]);
  if (kind === 'down' && twilioCallOn()) jobs.push(['call', placeCall({ message })]);
  if (twilioSmsOn()) jobs.push(['sms', sendSms({ message })]);

  if (jobs.length === 0) {
    console.warn('[notify] no channels configured — set NTFY_TOPIC and/or SMTP_* in .env');
    return;
  }

  const results = await Promise.allSettled(jobs.map((j) => j[1]));
  results.forEach((r, i) => {
    const name = jobs[i][0];
    if (r.status === 'fulfilled') console.log(`[notify] ${name} sent (${kind})`);
    else console.error(`[notify] ${name} FAILED: ${r.reason?.message || r.reason}`);
  });
}

// ---- public helpers ---------------------------------------------------------
function human(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

export function sendDownAlert({ silenceMs, timeoutSeconds, statusUrl }) {
  const title = `🔴 SIBO: ${DEVICE} is DOWN`;
  const message =
    `No heartbeat from "${DEVICE}" for ${human(silenceMs)} ` +
    `(alert threshold ${timeoutSeconds}s). It may have lost power, lost WiFi, or crashed.`;
  return dispatch('down', {
    title,
    message,
    priority: env.NTFY_PRIORITY || 'high',
    tags: ['rotating_light', 'warning'],
    click: statusUrl,
  });
}

export function sendRecovery({ downForMs, meta, statusUrl }) {
  const title = `🟢 SIBO: ${DEVICE} recovered`;
  const upt = meta?.uptime != null ? `, device uptime ${meta.uptime}s` : '';
  const message = `"${DEVICE}" is sending heartbeats again. It was down for ~${human(downForMs)}${upt}.`;
  return dispatch('up', {
    title,
    message,
    priority: 'default',
    tags: ['white_check_mark'],
    click: statusUrl,
  });
}

export function sendTest() {
  return dispatch('test', {
    title: `🔔 SIBO test`,
    message: `If you can read this, "${DEVICE}" alerts are working. Enabled: ${enabledChannels().join(', ') || 'none'}.`,
    priority: 'default',
    tags: ['bell'],
  });
}
