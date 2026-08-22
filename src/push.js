// Sends push notifications via Firebase Cloud Messaging so a new message
// can pop up on the recipient's lock screen / notification shade even
// when VOLT isn't open — the same mechanism WhatsApp/Telegram use.
//
// If Firebase isn't configured, this module quietly no-ops: real-time
// in-app delivery (Socket.io) keeps working regardless, you just won't
// get notifications while the app is fully closed.

const { getPushTokensForUser, removePushToken } = require('./db');

let messaging = null;

function initFirebase() {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    console.warn('⚠️  Firebase push notifications not configured (see .env.example) — skipping. In-app chat still works fully without this.');
    return;
  }

  const admin = require('firebase-admin');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      // .env stores the key with literal \n — convert back to real newlines.
      privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
  messaging = admin.messaging();
  console.log('🔔 Firebase push notifications enabled');
}

async function sendPushToUser(userId, { title, body, conversationId }) {
  if (!messaging) return;
  const tokens = getPushTokensForUser(userId);
  if (tokens.length === 0) return;

  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { conversationId: conversationId || '' },
    webpush: {
      fcmOptions: { link: '/' },
      notification: { icon: '/icon-192.png' },
    },
  });

  // Clean up tokens the device/browser has since invalidated.
  res.responses.forEach((r, i) => {
    if (!r.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.error?.code)) {
      removePushToken(tokens[i]);
    }
  });
}

module.exports = { initFirebase, sendPushToUser };
