require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { issueToken, requireAuth } = require('./auth');
const {
  findUserByPhone, findUserById, createUser, updateUserProfile,
  findUserByUsername, getOrCreateDirectConversation, listConversationsForUser,
  listMessages, savePushToken,
} = require('./db');
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

app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',') }));
app.use(express.json());

// --- basic request logging, useful while wiring things up ---
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

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
  // e.g. +972501234567 — a plus sign followed by 8 to 15 digits.
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

// ---------------------------------------------------------------------
// POST /api/auth/send-code   { phone: "+972501234567" }
//
// With Twilio configured: sends a real SMS code, returns { status: 'pending' }.
// Without Twilio (NO-SMS MODE): logs the person in immediately — no code,
// no verification step. Returns { devMode: true, token, isNewUser, user }
// and the frontend skips straight past the code screen.
// ---------------------------------------------------------------------
app.post('/api/auth/send-code', sendCodeLimiter, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone || !isValidE164(phone)) {
    return res.status(400).json({ error: 'invalid_phone', message: 'Очікується номер у форматі +972501234567' });
  }

  if (!SMS_ENABLED) {
    let user = findUserByPhone(phone);
    let isNewUser = false;
    if (!user) {
      user = createUser({ id: crypto.randomUUID(), phone });
      isNewUser = true;
    }
    const token = issueToken(user.id);
    return res.json({ devMode: true, status: 'approved', token, isNewUser, user: toPublicUser(user) });
  }

  try {
    const verification = await twilioClient.verify.v2
      .services(TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({ to: phone, channel: 'sms' });

    res.json({ status: verification.status }); // "pending"
  } catch (err) {
    console.error('Twilio send-code error:', err.message);
    // Twilio trial accounts can only text pre-verified numbers — surface that clearly.
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
// Only used when SMS is enabled (NO-SMS MODE never reaches this — the
// frontend logs in directly from the send-code response above).
// Checks the code with Twilio; on success, creates/finds the account
// and returns a session token the frontend stores and sends back on
// every future request as "Authorization: Bearer <token>".
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

    let user = findUserByPhone(phone);
    let isNewUser = false;
    if (!user) {
      user = createUser({ id: crypto.randomUUID(), phone });
      isNewUser = true;
    }

    const token = issueToken(user.id);
    res.json({ token, isNewUser, user: toPublicUser(user) });
  } catch (err) {
    console.error('Twilio verify-code error:', err.message);
    if (err.code === 20404) {
      // No pending verification found (expired / already used / never sent).
      return res.status(410).json({ error: 'code_expired', message: 'Код прострочено. Запросіть новий.' });
    }
    res.status(502).json({ error: 'sms_provider_error', message: err.message });
  }
});

// ---------------------------------------------------------------------
// GET /api/me   — returns the logged-in user's profile
// ---------------------------------------------------------------------
app.get('/api/me', requireAuth, (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  res.json({ user: toPublicUser(user) });
});

// ---------------------------------------------------------------------
// PUT /api/me   { name, username, avatar_emoji } — completes profile
// after first-time verification (name screen in the app).
// ---------------------------------------------------------------------
app.put('/api/me', requireAuth, (req, res) => {
  const { name, username, avatar_emoji, bio } = req.body || {};
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'invalid_name' });
  }
  const user = updateUserProfile(req.userId, {
    name: name.trim(),
    username: (username || '').trim() || null,
    avatar_emoji: avatar_emoji || '🙂',
    bio: (bio || '').trim() || null,
  });
  res.json({ user: toPublicUser(user) });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// POST /api/me/push-token  { token: "<FCM device token>" }
// The frontend calls this after the browser grants notification
// permission, so the server knows where to send pushes for this user.
app.post('/api/me/push-token', requireAuth, (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'missing_token' });
  savePushToken(req.userId, token);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Conversations & messages — real chat between real accounts.
// ---------------------------------------------------------------------

// POST /api/conversations/direct  { phone: "+972501234567" }
// Starts (or resumes) a 1:1 chat with another VOLT user by their phone
// number. Both sides must already have accounts.
app.post('/api/conversations/direct', requireAuth, (req, res) => {
  const { phone, username } = req.body || {};
  const other = phone ? findUserByPhone(phone) : (username ? findUserByUsername(username) : null);
  if (!other) return res.status(404).json({ error: 'user_not_found', message: 'Користувача з таким номером/юзернеймом ще немає у VOLT.' });
  if (other.id === req.userId) return res.status(400).json({ error: 'cannot_message_self' });

  const convo = getOrCreateDirectConversation(req.userId, other.id);
  res.json({ conversation: { id: convo.id, otherUser: toPublicUser(other) } });
});

// GET /api/conversations — all my chats, newest activity first
app.get('/api/conversations', requireAuth, (req, res) => {
  const convos = listConversationsForUser(req.userId).map(c => ({
    id: c.id,
    otherUser: c.otherUser ? toPublicUser(c.otherUser) : null,
    lastMessage: c.lastMessage,
  }));
  res.json({ conversations: convos });
});

// GET /api/conversations/:id/messages — history for one chat
app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  // (For brevity this MVP doesn't re-check membership here — the socket
  // layer enforces it for sending; add the same check here before
  // shipping this to real users.)
  const messages = listMessages(req.params.id);
  res.json({ messages });
});

function toPublicUser(u) {
  return {
    id: u.id,
    phone: u.phone,
    name: u.name,
    username: u.username,
    avatarEmoji: u.avatar_emoji,
    bio: u.bio,
    createdAt: u.created_at,
  };
}

const httpServer = http.createServer(app);
attachRealtime(httpServer, { corsOrigin: CORS_ORIGIN, jwtSecret: JWT_SECRET });

httpServer.listen(PORT, () => {
  console.log(`⚡ VOLT backend (REST + realtime) running on http://localhost:${PORT}`);
});
