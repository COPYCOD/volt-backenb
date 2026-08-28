const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { addMessage, deleteMessage, getConversationMembers, findUserById, touchSession } = require('./db');
const { toPublicMessage } = require('./serialize');
const { sendPushToUser } = require('./push');

// userId -> Set of live socket ids (a user can have several tabs/devices open)
const onlineUsers = new Map();

function attachRealtime(httpServer, { corsOrigin, jwtSecret }) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigin === '*' ? '*' : corsOrigin.split(',') },
    maxHttpBufferSize: 15 * 1024 * 1024, // voice notes / photos travel as base64 over the socket too
  });

  // Every socket must present the same JWT the REST API uses.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('missing_token'));
    try {
      const payload = jwt.verify(token, jwtSecret);
      socket.userId = payload.sub;
      socket.sessionId = payload.sid;
      next();
    } catch {
      next(new Error('invalid_token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    if (socket.sessionId) touchSession(socket.sessionId).catch(()=>{});
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    broadcastPresence(io, userId, true);

    // ---- chat messages (text, and optionally a photo or voice note) ----
    socket.on('message:send', async ({ conversationId, text, mediaType, mediaData, replyToId }, ack) => {
      try {
        const hasMedia = mediaType && mediaData;
        if (!conversationId || (!hasMedia && !text?.trim())) return ack?.({ error: 'invalid_message' });
        const members = await getConversationMembers(conversationId);
        const isMember = members.some(m => m.id === userId);
        if (!isMember) return ack?.({ error: 'not_a_member' });

        const messageRow = await addMessage({
          id: crypto.randomUUID(),
          conversationId,
          senderId: userId,
          text: (text || '').trim().slice(0, 4000),
          mediaType: hasMedia ? mediaType : null,
          mediaData: hasMedia ? mediaData : null,
          replyToId: replyToId || null,
        });
        const message = toPublicMessage(messageRow);

        // deliver to every online socket of every member (including sender's other tabs)
        for (const member of members) {
          const sockets = onlineUsers.get(member.id);
          if (sockets && sockets.size > 0) {
            sockets.forEach(sid => io.to(sid).emit('message:new', { conversationId, message }));
          } else if (member.id !== userId) {
            // offline — try a push notification instead of an in-app event
            const sender = await findUserById(userId);
            const preview = message.mediaType === 'voice' ? '🎤 Голосове повідомлення'
              : message.mediaType === 'image' ? '📷 Фото'
              : message.text;
            sendPushToUser(member.id, {
              title: sender?.name || 'VOLT',
              body: preview,
              conversationId,
            }).catch(err => console.error('push send failed:', err.message));
          }
        }
        ack?.({ ok: true, message });
      } catch (err) {
        console.error('message:send error:', err);
        ack?.({ error: 'server_error' });
      }
    });

    socket.on('typing', async ({ conversationId }) => {
      const members = await getConversationMembers(conversationId);
      members.filter(m => m.id !== userId).forEach(member => {
        const sockets = onlineUsers.get(member.id);
        if (sockets) sockets.forEach(sid => io.to(sid).emit('typing', { conversationId, userId }));
      });
    });

    // ---- delete a message (sender only) ----
    socket.on('message:delete', async ({ messageId }, ack) => {
      try {
        const conversationId = await deleteMessage(messageId, userId);
        if (!conversationId) return ack?.({ error: 'not_found_or_not_owner' });
        const members = await getConversationMembers(conversationId);
        members.forEach(member => {
          const sockets = onlineUsers.get(member.id);
          if (sockets) sockets.forEach(sid => io.to(sid).emit('message:deleted', { conversationId, messageId }));
        });
        ack?.({ ok: true });
      } catch (err) {
        console.error('message:delete error:', err);
        ack?.({ error: 'server_error' });
      }
    });

    // ---- WebRTC call signaling (server just relays SDP/ICE between two users) ----
    socket.on('call:invite', ({ toUserId, conversationId, offer }) => {
      relay(io, toUserId, 'call:invite', { fromUserId: userId, conversationId, offer });
    });
    socket.on('call:answer', ({ toUserId, answer }) => {
      relay(io, toUserId, 'call:answer', { fromUserId: userId, answer });
    });
    socket.on('call:ice-candidate', ({ toUserId, candidate }) => {
      relay(io, toUserId, 'call:ice-candidate', { fromUserId: userId, candidate });
    });
    socket.on('call:end', ({ toUserId }) => {
      relay(io, toUserId, 'call:end', { fromUserId: userId });
    });
    socket.on('call:decline', ({ toUserId }) => {
      relay(io, toUserId, 'call:decline', { fromUserId: userId });
    });

    socket.on('disconnect', () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          broadcastPresence(io, userId, false);
        }
      }
    });
  });

  return io;
}

function relay(io, toUserId, event, payload) {
  const sockets = onlineUsers.get(toUserId);
  if (!sockets || sockets.size === 0) return; // recipient offline — no push notifications wired up yet
  sockets.forEach(sid => io.to(sid).emit(event, payload));
}

function broadcastPresence(io, userId, isOnline) {
  io.emit('presence', { userId, isOnline, ts: Date.now() });
}

module.exports = { attachRealtime, onlineUsers };
