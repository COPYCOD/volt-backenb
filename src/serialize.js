// Single source of truth for how DB rows look on the wire (camelCase),
// used by both the REST routes (server.js) and the realtime layer
// (realtime.js) so a message never has two different shapes depending on
// which path delivered it — that mismatch was the root cause of the
// "every message renders as mine" bug.

function toPublicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    phone: u.phone,
    name: u.name,
    username: u.username,
    avatarEmoji: u.avatar_emoji,
    avatarPhoto: u.avatar_photo || null,
    bio: u.bio,
    createdAt: u.created_at,
  };
}

function toPublicMessage(m) {
  if (!m) return null;
  return {
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    text: m.text,
    mediaType: m.media_type || null,   // null | 'image' | 'voice'
    mediaData: m.media_data || null,   // base64 data URL, when mediaType is set
    replyToId: m.reply_to_id || null,
    createdAt: m.created_at,
  };
}

module.exports = { toPublicUser, toPublicMessage };
