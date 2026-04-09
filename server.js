const { AccessToken } = require('livekit-server-sdk');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors());

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;

app.get('/token', async (req, res) => {     // ← wajib async
  const { room, identity } = req.query;

  if (!room || !identity) {
    return res.status(400).json({ error: 'room and identity are required' });
  }

  try {
    const at = new AccessToken(API_KEY, API_SECRET, {
      identity: identity,
      ttl: '2h',
    });

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();  // ← wajib await di v2

    res.json({ token });             // ← sekarang token adalah string
  } catch (e) {
    console.error('Token generation error:', e);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

app.listen(3001, '0.0.0.0', () => {
  console.log('✅ Token server running at http://localhost:3001');
  console.log('   Test: http://localhost:3001/token?room=test&identity=user1');
});