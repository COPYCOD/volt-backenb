require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { issueToken, requireAuth } = require('./auth');
const {
  connect,
  findUserByPhone, findUserById, createUser, updateUserProfile,
  findUserByUsername, getOrCreateDirectConversation, listConversationsForUser,
  listMessages, savePushToken,
  createSession, touchSession, listSessionsForUser, deleteSession,
} = require('./db');
const { toPublicUser, toPublicMessage } = require('./serialize');
const { attachRealtime } = require('./realtime');
const { initFirebase } = require('./push');
initFirebase();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_VERIFY_SERVICE_SID,
  JWT_SECRET,
  PORT = 3000,
  CORS_ORIGIN = '*',
} = process.env;

// SMS is entirely optional for now. Without Twilio credentials, the server
// runs in NO-SMS MODE: /api/auth/send-code logs the person straight in by
// phone number, no code, no verification that they actually own that
// number. Fine for testing chat/calls/push with people you trust; add the
// three TWILIO_* variables later (see README) to turn on real SMS codes —
// no other code changes needed, this switches itself on automatically.
const SMS_ENABLED = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SERVICE_SID);
const twilioClient = SMS_ENABLED ? require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
if (!SMS_ENABLED) {
  console.warn('⚠️  No Twilio credentials found — running in NO-SMS MODE. Anyone can log in with any phone number, no code required. Add TWILIO_* to .env when you want real SMS verification.');
}

const app = express();

// Log every single incoming request BEFORE anything else touches it —
// including CORS preflight (OPTIONS) requests, which the cors middleware
// below would otherwise swallow silently.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} | Origin: ${req.headers.origin || '(none)'}`);
  next();
});

app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',') }));
// Media (photos/voice notes) travel as base64 inside JSON — bump the body
// limit well past Express's 100kb default so those requests don't get
// rejected outright.
app.use(express.json({ limit: '15mb' }));

// SMS costs real money per message, so this endpoint is rate-limited hard:
// max 3 code requests per phone-ish window per IP every 10 minutes.
const sendCodeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Забагато спроб. Спробуйте пізніше.' },
});

function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

// Turns a raw User-Agent string into something a person can recognize,
// e.g. "Chrome on Android" instead of the full UA blob.
function describeDevice(userAgent = '') {
  const ua = userAgent.toLowerCase();
  let os = 'Unknown OS';
  if (ua.includes('android')) os = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
  else if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac os')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';

  let browser = 'Browser';
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('chrome/')) browser = 'Chrome';
  else if (ua.includes('firefox/')) browser = 'Firefox';
  else if (ua.includes('safari/') && !ua.includes('chrome')) browser = 'Safari';

  return `${browser} on ${os}`;
}

function loginSuccess(res, user, isNewUser, req) {
  return (async () => {
    const session = await createSession({
      userId: user.id,
      userAgent: describeDevice(req.headers['user-agent']),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    });
    const token = issueToken(user.id, session.id);
    res.json({ devMode: !SMS_ENABLED, status: 'approved', token, isNewUser, user: toPublicUser(user) });
  })();
}

// ---------------------------------------------------------------------
// POST /api/auth/send-code   { phone: "+972501234567" }
// ---------------------------------------------------------------------
app.post('/api/auth/send-code', sendCodeLimiter, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone || !isValidE164(phone)) {
    return res.status(400).json({ error: 'invalid_phone', message: 'Очікується номер у форматі +972501234567' });
  }

  if (!SMS_ENABLED) {
    try {
      let user = await findUserByPhone(phone);
      let isNewUser = false;
      if (!user) { user = await createUser({ id: crypto.randomUUID(), phone }); isNewUser = true; }
      return await loginSuccess(res, user, isNewUser, req);
    } catch (err) {
      console.error('NO-SMS MODE login error:', err);
      return res.status(500).json({ error: 'server_error', message: err.message });
    }
  }

  try {
    const verification = await twilioClient.verify.v2
      .services(TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: phone, channel: 'sms' });
    res.json({ status: verification.status });
  } catch (err) {
    console.error('Twilio send-code error:', err.message);
    if (err.code === 21608) {
      return res.status(400).json({
        error: 'unverified_number',
        message: 'Цей номер не підтверджено в Twilio trial-акаунті. Додайте його в Twilio Console → Verified Caller IDs, або перейдіть на платний акаунт.',
      });
    }
    res.status(502).json({ error: 'sms_provider_error', message: err.message });
  }
});

// ---------------------------------------------------------------------
// POST /api/auth/verify-code   { phone, code }
// ---------------------------------------------------------------------
app.post('/api/auth/verify-code', async (req, res) => {
  if (!SMS_ENABLED) return res.status(400).json({ error: 'sms_disabled', message: 'Сервер працює в режимі без SMS — код не потрібен.' });
  const { phone, code } = req.body || {};
  if (!phone || !isValidE164(phone) || !code) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  try {
    const check = await twilioClient.verify.v2
      .services(TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== 'approved') {
      return res.status(401).json({ error: 'wrong_code', message: 'Невірний код.' });
    }

    let user = await findUserByPhone(phone);
    let isNewUser = false;
    if (!user) { user = await createUser({ id: crypto.randomUUID(), phone }); isNewUser = true; }
    await loginSuccess(res, user, isNewUser, req);
  } catch (err) {
    console.error('Twilio verify-code error:', err.message);
    if (err.code === 20404) {
      return res.status(410).json({ error: 'code_expired', message: 'Код прострочено. Запросіть новий.' });
    }
    res.status(502).json({ error: 'sms_provider_error', message: err.message });
  }
});

// ---------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------
app.get('/api/me', requireAuth, async (req, res) => {
  if (req.sessionId) touchSession(req.sessionId).catch(()=>{});
  const user = await findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  res.json({ user: toPublicUser(user) });
});

app.put('/api/me', requireAuth, async (req, res) => {
  const { name, username, avatar_emoji, bio, avatar_photo } = req.body || {};
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'invalid_name' });
  }
  const user = await updateUserProfile(req.userId, {
    name: name.trim(),
    username: (username || '').trim() || null,
    avatar_emoji: avatar_emoji || '🙂',
    bio: (bio || '').trim() || null,
    avatar_photo: avatar_photo !== undefined ? avatar_photo : undefined,
  });
  res.json({ user: toPublicUser(user) });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/me/push-token', requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'missing_token' });
  await savePushToken(req.userId, token);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Sessions (real logged-in devices — Settings -> Devices)
// ---------------------------------------------------------------------
app.get('/api/sessions', requireAuth, async (req, res) => {
  const rows = await listSessionsForUser(req.userId);
  const sessions = rows.map(s => ({
    id: s.id,
    device: s.user_agent,
    ip: s.ip,
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at,
    current: s.id === req.sessionId,
  }));
  res.json({ sessions });
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  if (req.params.id === req.sessionId) {
    return res.status(400).json({ error: 'cannot_delete_current_session', message: 'Не можна завершити поточний сеанс звідси — скористайтесь «Вийти».' });
  }
  await deleteSession(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------
app.post('/api/conversations/direct', requireAuth, async (req, res) => {
  const { phone, username } = req.body || {};
  const cleanUsername = username ? username.replace(/^@/, '').trim() : null;
  const other = phone ? await findUserByPhone(phone) : (cleanUsername ? await findUserByUsername(cleanUsername) : null);
  if (!other) return res.status(404).json({ error: 'user_not_found', message: 'Користувача з таким номером/юзернеймом ще немає у VOLT.' });
  if (other.id === req.userId) return res.status(400).json({ error: 'cannot_message_self' });

  const convo = await getOrCreateDirectConversation(req.userId, other.id);
  res.json({ conversation: { id: convo.id, otherUser: toPublicUser(other) } });
});

app.get('/api/conversations', requireAuth, async (req, res) => {
  const rows = await listConversationsForUser(req.userId);
  const convos = rows.map(c => ({
    id: c.id,
    otherUser: c.otherUser ? toPublicUser(c.otherUser) : null,
    lastMessage: c.lastMessage ? toPublicMessage(c.lastMessage) : null,
  }));
  res.json({ conversations: convos });
});

app.get('/api/conversations/:id/messages', requireAuth, async (req, res) => {
  const rows = await listMessages(req.params.id);
  res.json({ messages: rows.map(toPublicMessage) });
});

// Express-level error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'server_error', message: 'Внутрішня помилка сервера. Спробуйте ще раз.' });
});

const httpServer = http.createServer(app);
attachRealtime(httpServer, { corsOrigin: CORS_ORIGIN, jwtSecret: JWT_SECRET });

process.on('unhandledRejection', (err) => console.error('Unhandled promise rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

connect()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`⚡ VOLT backend (REST + realtime) running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to connect to MongoDB — server not started:', err.message);
    process.exit(1);
  });
