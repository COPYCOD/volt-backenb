const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'change_this_to_a_long_random_string') {
  console.warn(
    '⚠️  JWT_SECRET is missing or still the placeholder value. ' +
    'Set a real random secret in .env before deploying — anyone who ' +
    'knows this value can forge login sessions.'
  );
}

function issueToken(userId, sessionId) {
  // 30-day session. Shorten this (and add refresh tokens) for a
  // production app that needs tighter session control.
  return jwt.sign({ sub: userId, sid: sessionId }, SECRET, { expiresIn: '30d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.sub;
    req.sessionId = payload.sid;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

module.exports = { issueToken, requireAuth };
