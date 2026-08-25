// Persistent account & chat storage — a plain JSON file on disk, loaded
// into memory and written back after every change.
//
// Why not a real database? better-sqlite3 (and most fast embedded DBs)
// need to compile native C++ code when you `npm install`, which fails on
// several free hosts depending on their exact Node/build-tool version --
// that's the "gyp ERR!" build failure you may have hit. A JSON file needs
// zero compilation, so `npm install` always just works. It's plenty for
// an MVP with a handful of users; swap this file for a real Postgres/Mongo
// client later without touching any other file — everything else only
// calls the functions exported at the bottom.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, '..', 'volt-data.json');

function emptyData() {
  return { users: [], conversations: [], conversationMembers: [], messages: [], pushTokens: [], sessions: [] };
}

function loadData() {
  if (!fs.existsSync(DB_FILE)) return emptyData();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...emptyData(), ...parsed }; // fills in any new arrays added since the file was last written
  } catch {
    return emptyData();
  }
}

let data = loadData();

function save() {
  // Synchronous write is fine at MVP traffic levels — simplicity over
  // throughput. Swap for a real DB before this becomes a bottleneck.
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to write ${DB_FILE}:`, err.message);
    throw err;
  }
}

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
function findUserByPhone(phone) {
  return data.users.find(u => u.phone === phone) || null;
}
function findUserById(id) {
  return data.users.find(u => u.id === id) || null;
}
function findUserByUsername(username) {
  return data.users.find(u => u.username === username) || null;
}
function createUser({ id, phone, name, username, avatar_emoji, bio }) {
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
  data.users.push(user);
  save();
  return user;
}
function updateUserProfile(id, { name, username, avatar_emoji, bio, avatar_photo }) {
  const user = findUserById(id);
  if (!user) return null;
  user.name = name;
  user.username = username;
  user.avatar_emoji = avatar_emoji;
  user.bio = bio ?? null;
  if (avatar_photo !== undefined) user.avatar_photo = avatar_photo; // base64 data URL, or null to clear
  save();
  return user;
}

// ---------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------
function getOrCreateDirectConversation(userIdA, userIdB) {
  const existingIds = data.conversationMembers
    .filter(m => m.user_id === userIdA)
    .map(m => m.conversation_id);
  for (const convId of existingIds) {
    const members = data.conversationMembers.filter(m => m.conversation_id === convId).map(m => m.user_id);
    const convo = data.conversations.find(c => c.id === convId);
    if (convo && !convo.is_group && members.includes(userIdB)) return convo;
  }

  const id = crypto.randomUUID();
  const convo = { id, is_group: false, name: null, created_at: Date.now() };
  data.conversations.push(convo);
  data.conversationMembers.push({ conversation_id: id, user_id: userIdA });
  data.conversationMembers.push({ conversation_id: id, user_id: userIdB });
  save();
  return convo;
}

function getConversationMembers(conversationId) {
  const userIds = data.conversationMembers
    .filter(m => m.conversation_id === conversationId)
    .map(m => m.user_id);
  return data.users.filter(u => userIds.includes(u.id));
}

function listConversationsForUser(userId) {
  const convoIds = data.conversationMembers
    .filter(m => m.user_id === userId)
    .map(m => m.conversation_id);

  const result = convoIds.map(convId => {
    const convo = data.conversations.find(c => c.id === convId);
    const memberIds = data.conversationMembers
      .filter(m => m.conversation_id === convId)
      .map(m => m.user_id);
    const otherId = memberIds.find(id => id !== userId);
    const other = otherId ? findUserById(otherId) : null;
    const msgs = data.messages
      .filter(m => m.conversation_id === convId)
      .sort((a, b) => b.created_at - a.created_at);
    return { ...convo, otherUser: other, lastMessage: msgs[0] || null };
  });

  return result.sort((a, b) => (b.lastMessage?.created_at || b.created_at) - (a.lastMessage?.created_at || a.created_at));
}

function addMessage({ id, conversationId, senderId, text, mediaType, mediaData }) {
  const message = {
    id,
    conversation_id: conversationId,
    sender_id: senderId,
    text: text || '',
    media_type: mediaType || null,   // null | 'image' | 'voice'
    media_data: mediaData || null,   // base64 data URL
    created_at: Date.now(),
  };
  data.messages.push(message);
  save();
  return message;
}

function listMessages(conversationId, limit = 100) {
  return data.messages
    .filter(m => m.conversation_id === conversationId)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-limit);
}

// ---------------------------------------------------------------------
// Push notification tokens
// ---------------------------------------------------------------------
function savePushToken(userId, token) {
  const exists = data.pushTokens.some(t => t.user_id === userId && t.token === token);
  if (!exists) {
    data.pushTokens.push({ user_id: userId, token, created_at: Date.now() });
    save();
  }
}
function getPushTokensForUser(userId) {
  return data.pushTokens.filter(t => t.user_id === userId).map(t => t.token);
}
function removePushToken(token) {
  data.pushTokens = data.pushTokens.filter(t => t.token !== token);
  save();
}

// ---------------------------------------------------------------------
// Sessions (real logged-in devices, shown in Settings -> Devices)
// ---------------------------------------------------------------------
function createSession({ userId, userAgent, ip }) {
  const session = {
    id: crypto.randomUUID(),
    user_id: userId,
    user_agent: userAgent || 'Unknown device',
    ip: ip || null,
    created_at: Date.now(),
    last_seen_at: Date.now(),
  };
  data.sessions.push(session);
  save();
  return session;
}
function touchSession(sessionId) {
  const s = data.sessions.find(s => s.id === sessionId);
  if (s) { s.last_seen_at = Date.now(); save(); }
}
function listSessionsForUser(userId) {
  return data.sessions
    .filter(s => s.user_id === userId)
    .sort((a, b) => b.last_seen_at - a.last_seen_at);
}
function deleteSession(sessionId) {
  data.sessions = data.sessions.filter(s => s.id !== sessionId);
  save();
}

module.exports = {
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
