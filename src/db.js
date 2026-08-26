// Persistent account & chat storage — MongoDB Atlas (free tier, hosted
// separately from Render). This replaces the earlier JSON-file approach:
// that file lived on Render's own disk, and Render's FREE web services
// have no persistent disk — every restart/redeploy/sleep-wake cycle wiped
// it clean, which is why accounts and chats kept disappearing. A real
// hosted database survives all of that, because it isn't part of the web
// service's filesystem at all.
//
// Every exported function here is async (a real network call to the
// database), unlike the old synchronous file version — every call site
// elsewhere in the backend now needs `await`.

const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error(
    '❌ MONGODB_URI is missing. Set it in your environment variables —\n' +
    '   see README.md for how to get a free connection string from MongoDB Atlas.'
  );
  process.exit(1);
}

const client = new MongoClient(uri);
let db;

async function connect() {
  await client.connect();
  db = client.db('volt');
  await Promise.all([
    db.collection('users').createIndex({ id: 1 }, { unique: true }),
    db.collection('users').createIndex({ phone: 1 }, { unique: true }),
    db.collection('users').createIndex({ username: 1 }, { unique: true, sparse: true }),
    db.collection('conversations').createIndex({ id: 1 }, { unique: true }),
    db.collection('conversations').createIndex({ memberIds: 1 }),
    db.collection('messages').createIndex({ id: 1 }, { unique: true }),
    db.collection('messages').createIndex({ conversation_id: 1, created_at: 1 }),
    db.collection('pushTokens').createIndex({ user_id: 1 }),
    db.collection('pushTokens').createIndex({ token: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ id: 1 }, { unique: true }),
    db.collection('sessions').createIndex({ user_id: 1 }),
  ]);
  console.log('🗄️  Connected to MongoDB');
}

const NO_ID = { projection: { _id: 0 } };

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
async function findUserByPhone(phone) {
  return db.collection('users').findOne({ phone }, NO_ID);
}
async function findUserById(id) {
  return db.collection('users').findOne({ id }, NO_ID);
}
async function findUserByUsername(username) {
  return db.collection('users').findOne({ username }, NO_ID);
}
async function createUser({ id, phone, name, username, avatar_emoji, bio }) {
  const user = {
    id,
    phone,
    name: name || null,
    username: username || null,
    bio: bio || null,
    avatar_emoji: avatar_emoji || '🙂',
    avatar_photo: null,
    created_at: Date.now(),
  };
  await db.collection('users').insertOne(user);
  delete user._id;
  return user;
}
async function updateUserProfile(id, { name, username, avatar_emoji, bio, avatar_photo }) {
  const set = { name, username, avatar_emoji, bio: bio ?? null };
  if (avatar_photo !== undefined) set.avatar_photo = avatar_photo;
  await db.collection('users').updateOne({ id }, { $set: set });
  return findUserById(id);
}

// ---------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------
async function getOrCreateDirectConversation(userIdA, userIdB) {
  const existing = await db.collection('conversations').findOne(
    { is_group: false, memberIds: { $all: [userIdA, userIdB] } },
    NO_ID
  );
  if (existing) return existing;

  const convo = {
    id: crypto.randomUUID(),
    is_group: false,
    name: null,
    memberIds: [userIdA, userIdB],
    created_at: Date.now(),
  };
  await db.collection('conversations').insertOne({ ...convo });
  return convo;
}

async function getConversationMembers(conversationId) {
  const convo = await db.collection('conversations').findOne({ id: conversationId }, NO_ID);
  if (!convo) return [];
  return db.collection('users').find({ id: { $in: convo.memberIds } }, NO_ID).toArray();
}

async function listConversationsForUser(userId) {
  const convos = await db.collection('conversations').find({ memberIds: userId }, NO_ID).toArray();

  const result = await Promise.all(convos.map(async convo => {
    const otherId = convo.memberIds.find(id => id !== userId);
    const other = otherId ? await findUserById(otherId) : null;
    const lastMessageArr = await db.collection('messages')
      .find({ conversation_id: convo.id }, NO_ID)
      .sort({ created_at: -1 })
      .limit(1)
      .toArray();
    return { ...convo, otherUser: other, lastMessage: lastMessageArr[0] || null };
  }));

  return result.sort((a, b) => (b.lastMessage?.created_at || b.created_at) - (a.lastMessage?.created_at || a.created_at));
}

async function addMessage({ id, conversationId, senderId, text, mediaType, mediaData }) {
  const message = {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    text: text || '',
    media_type: mediaType || null,
    media_data: mediaData || null,
    created_at: Date.now(),
  };
  await db.collection('messages').insertOne({ ...message });
  return message;
}

async function listMessages(conversationId, limit = 100) {
  const rows = await db.collection('messages')
    .find({ conversation_id: conversationId }, NO_ID)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
  return rows.reverse();
}

// ---------------------------------------------------------------------
// Push notification tokens
// ---------------------------------------------------------------------
async function savePushToken(userId, token) {
  await db.collection('pushTokens').updateOne(
    { token },
    { $set: { user_id: userId, token, created_at: Date.now() } },
    { upsert: true }
  );
}
async function getPushTokensForUser(userId) {
  const rows = await db.collection('pushTokens').find({ user_id: userId }, NO_ID).toArray();
  return rows.map(r => r.token);
}
async function removePushToken(token) {
  await db.collection('pushTokens').deleteOne({ token });
}

// ---------------------------------------------------------------------
// Sessions (real logged-in devices — Settings -> Devices)
// ---------------------------------------------------------------------
async function createSession({ userId, userAgent, ip }) {
  const session = {
    id: crypto.randomUUID(),
    user_id: userId,
    user_agent: userAgent || 'Unknown device',
    ip: ip || null,
    created_at: Date.now(),
    last_seen_at: Date.now(),
  };
  await db.collection('sessions').insertOne({ ...session });
  return session;
}
async function touchSession(sessionId) {
  await db.collection('sessions').updateOne({ id: sessionId }, { $set: { last_seen_at: Date.now() } });
}
async function listSessionsForUser(userId) {
  const rows = await db.collection('sessions').find({ user_id: userId }, NO_ID).toArray();
  return rows.sort((a, b) => b.last_seen_at - a.last_seen_at);
}
async function deleteSession(sessionId) {
  await db.collection('sessions').deleteOne({ id: sessionId });
}

module.exports = {
  connect,
  findUserByPhone, findUserById, createUser, updateUserProfile,
  findUserByUsername,
  getOrCreateDirectConversation,
  listConversationsForUser,
  addMessage,
  listMessages,
  getConversationMembers,
  savePushToken,
  getPushTokensForUser,
  removePushToken,
  createSession,
  touchSession,
  listSessionsForUser,
  deleteSession,
};
