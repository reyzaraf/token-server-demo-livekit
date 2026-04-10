const { AccessToken, RoomServiceClient, EgressClient, EncodedFileType, EncodedFileOutput } = require('livekit-server-sdk');
const { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// =============================================
// Global BigInt serializer
// =============================================
app.set('json replacer', (key, value) =>
  typeof value === 'bigint' ? value.toString() : value
);

const upload = multer({ storage: multer.memoryStorage() });

// =============================================
// Validasi env wajib saat startup
// =============================================
const requiredEnv = ['API_KEY', 'API_SECRET', 'LIVEKIT_URL', 'S3_KEY_ID', 'S3_KEY_SECRET', 'S3_ENDPOINT', 'S3_BUCKET_RECORD'];
requiredEnv.forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env: ${key}`);
    process.exit(1);
  }
});

const API_KEY      = process.env.API_KEY;
const API_SECRET   = process.env.API_SECRET;
const LIVEKIT_URL  = process.env.LIVEKIT_URL;
const BASE_WEB_URL = process.env.BASE_WEB_URL || 'http://localhost:3000';

// =============================================
// S3 Client
// =============================================
const s3Client = new S3Client({
  region: process.env.S3_REGION || 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_KEY_ID,
    secretAccessKey: process.env.S3_KEY_SECRET,
  },
});

// =============================================
// LiveKit Clients
// =============================================
const roomService  = new RoomServiceClient(LIVEKIT_URL, API_KEY, API_SECRET);
const egressClient = new EgressClient(LIVEKIT_URL, API_KEY, API_SECRET);

// In-memory room store (fallback cache)
const roomStore = new Map();

// =============================================
// HELPER — Generate room code "xxxx-xxxx"
// =============================================
function generateRoomCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const part = (len) => Array.from(
    { length: len },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join('');
  return `${part(4)}-${part(4)}`;
}

// =============================================
// HELPER — Tunggu Egress jadi ACTIVE
// =============================================
async function waitForEgressActive(egressId, maxWaitMs = 30000) {
  const interval = 1500;
  const maxAttempts = Math.ceil(maxWaitMs / interval);

  for (let i = 0; i < maxAttempts; i++) {
    const infos = await egressClient.listEgress({ egressId });
    const status = infos?.[0]?.status;
    console.log(`[EGRESS WAIT] Attempt ${i + 1}/${maxAttempts}, status: ${status}`);

    if (status === 1) return { active: true, status };
    if (status >= 3) return { active: false, status };

    await new Promise(r => setTimeout(r, interval));
  }
  return { active: false, status: -1 };
}

// =============================================
// TOKEN
// =============================================
app.get('/token', async (req, res) => {
  const { room, identity, roomCode } = req.query;

  let actualRoom = room;
  if (roomCode && !room) {
    // Cek in-memory dulu, fallback ke roomCode langsung sebagai roomName
    const roomData = roomStore.get(roomCode);
    actualRoom = roomData ? roomData.roomName : roomCode;
  }

  if (!actualRoom || !identity) {
    return res.status(400).json({ error: 'room and identity are required' });
  }

  try {
    const at = new AccessToken(API_KEY, API_SECRET, { identity, ttl: '2h' });
    at.addGrant({
      roomJoin: true,
      room: actualRoom,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();
    res.json({ token, roomName: actualRoom });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

// =============================================
// ROOM — Create + Share Link
// =============================================
app.post('/room/create', async (req, res) => {
  const { hostName } = req.body;
  if (!hostName) return res.status(400).json({ error: 'hostName is required' });

  // roomName = roomCode agar bisa diakses cross-platform (web & mobile)
  const roomCode       = generateRoomCode();
  const actualRoomName = roomCode;

  roomStore.set(roomCode, {
    roomName: actualRoomName,
    createdAt: Date.now(),
    host: hostName,
  });

  try {
    await roomService.createRoom({
      name: actualRoomName,
      emptyTimeout: 300,
      maxParticipants: 20,
    });
  } catch (e) {
    console.error('Create room error:', e.message);
  }

  res.json({
    roomCode,
    roomName: actualRoomName,
    shareLink: `${BASE_WEB_URL}/join/${roomCode}`,
  });
});

// =============================================
// ROOM — Resolve Share Code
// =============================================
app.get('/join/:roomCode', async (req, res) => {
  const roomCode = req.params.roomCode;

  // Cek in-memory dulu
  const room = roomStore.get(roomCode);
  if (room) return res.json({ roomName: room.roomName, roomCode });

  // Fallback — cek langsung ke LiveKit (untuk room yang dibuat dari platform lain)
  try {
    const rooms = await roomService.listRooms([roomCode]);
    if (rooms.length > 0) return res.json({ roomName: roomCode, roomCode });
  } catch (e) {}

  res.status(404).json({ error: 'Room not found or expired' });
});

// =============================================
// RECORDING — Start
// =============================================
app.post('/recording/start', async (req, res) => {
  const { roomName, hostName, identity } = req.body;
  console.log(`\n[START REC] Room: ${roomName}, Host: ${hostName}, Identity: ${identity}`);

  if (!roomName) return res.status(400).json({ error: 'roomName is required' });
  if (!identity) return res.status(400).json({ error: 'identity is required' });

  // Tunggu participant join (max 10 detik)
  let found = false;
  for (let i = 1; i <= 10; i++) {
    const participants = await roomService.listParticipants(roomName);
    const participant = participants.find(p => p.identity === identity);
    console.log(`[START REC] Attempt ${i}/10 — Participant: ${participant ? 'found' : 'not found'}`);

    if (participant) { found = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!found) return res.status(400).json({ error: `Participant "${identity}" not found in room` });

  // Delay 2 detik beri waktu track publish
  await new Promise(r => setTimeout(r, 2000));

  const filename = `recordings/${roomName}-${Date.now()}.mp4`;
  console.log(`[START REC] Target file: ${filename}`);

  try {
    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: filename,
      output: {
        case: 's3',
        value: {
          accessKey: process.env.S3_KEY_ID,
          secret: process.env.S3_KEY_SECRET,
          region: process.env.S3_REGION || 'us-east-1',
          bucket: process.env.S3_BUCKET_RECORD,
          endpoint: process.env.S3_ENDPOINT,
          forcePathStyle: true,
        },
      },
    });

    console.log('[START REC] Calling startParticipantEgress...');
    const info = await egressClient.startParticipantEgress(
      roomName,
      identity,
      { file: fileOutput }
    );

    console.log(`[START REC] SUCCESS! EgressID: ${info.egressId}`);
    res.json({ egressId: info.egressId, filename, status: 'recording' });
  } catch (e) {
    console.error('[START REC] FAILED:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// RECORDING — Stop
// =============================================
app.post('/recording/stop', async (req, res) => {
  const { egressId } = req.body;
  console.log(`\n[STOP REC] EgressID: ${egressId}`);
  if (!egressId) return res.status(400).json({ error: 'egressId is required' });

  try {
    const infos = await egressClient.listEgress({ egressId });
    const egress = infos?.[0];

    if (!egress) {
      console.log('[STOP REC] Egress not found');
      return res.status(404).json({ error: 'Egress not found' });
    }

    console.log(`[STOP REC] Current status: ${egress.status}`);

    if (egress.status === 0) {
      console.log('[STOP REC] Still STARTING, waiting up to 30s for ACTIVE...');
      const result = await waitForEgressActive(egressId);
      console.log(`[STOP REC] Wait result: active=${result.active}, status=${result.status}`);

      if (!result.active) {
        return res.json({
          stopped: false,
          reason: 'Egress ended before becoming active',
          status: result.status,
        });
      }
    }

    if (egress.status >= 3) {
      console.log(`[STOP REC] Already ended, status: ${egress.status}`);
      return res.json({ stopped: false, reason: 'Egress already ended', status: egress.status });
    }

    const info = await egressClient.stopEgress(egressId);
    console.log(`[STOP REC] Stopped. Status: ${info.status}`);
    res.json({ stopped: true, status: info.status, info });
  } catch (e) {
    console.error('[STOP REC] FAILED:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// RECORDING — Status / Debug
// =============================================
app.get('/recording/status/:egressId', async (req, res) => {
  const { egressId } = req.params;
  console.log(`\n[STATUS REC] Checking: ${egressId}`);
  try {
    const infos = await egressClient.listEgress({ egressId });
    const egress = infos[0];
    if (!egress) return res.status(404).json({ error: 'Egress not found' });

    console.log(`[STATUS REC] Status: ${egress.status}, Error: ${egress.error || 'none'}`);

    res.json({
      egressId: egress.egressId,
      status: egress.status,
      error: egress.error || null,
      fileResults: (egress.fileResults || []).map(f => ({
        filename: f.filename,
        startedAt: f.startedAt?.toString() || null,
        endedAt: f.endedAt?.toString() || null,
        duration: f.duration?.toString() || null,
        size: f.size?.toString() || null,
        location: f.location || null,
      })),
      startedAt: egress.startedAt?.toString() || null,
      endedAt: egress.endedAt?.toString() || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// RECORDING — List dari S3
// =============================================
app.get('/recordings', async (req, res) => {
  console.log('\n[LIST REC] Fetching dari S3...');
  try {
    const data = await s3Client.send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_RECORD,
      Prefix: 'recordings/',
    }));

    console.log(`[LIST REC] Total items: ${data.Contents?.length || 0}`);

    const files = (data.Contents || [])
      .filter(obj => obj.Key.endsWith('.mp4'))
      .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
      .map(obj => {
        const cleanKey   = obj.Key.replace('recordings/', '');
        const roomName   = cleanKey.replace(/-\d+\.mp4$/, '') || 'Unknown Room';
        const recordedAt = parseInt(obj.Key.match(/-(\d+)\.mp4$/)?.[1] || new Date(obj.LastModified).getTime());
        return {
          key: obj.Key,
          filename: obj.Key.split('/').pop(),
          size: obj.Size,
          lastModified: obj.LastModified,
          roomName,
          recordedAt,
        };
      });

    console.log(`[LIST REC] MP4 files: ${files.length}`);
    res.json({ recordings: files });
  } catch (e) {
    console.error('[LIST REC] S3 ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// RECORDING — Presigned URL
// =============================================
app.get('/recordings/url', async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'key is required' });

  try {
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET_RECORD, Key: key }),
      { expiresIn: 3600 }
    );
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
// TEST S3 Connection
// =============================================
app.get('/test-s3', async (req, res) => {
  try {
    await s3Client.send(new ListObjectsV2Command({
      Bucket: process.env.S3_BUCKET_RECORD,
      MaxKeys: 1,
    }));
    res.send('✅ Koneksi S3 OK! Credentials dan bucket valid.');
  } catch (e) {
    res.status(500).send(`❌ Koneksi S3 Gagal: ${e.message}`);
  }
});

// =============================================
// UPLOAD — Chat attachment
// =============================================
app.post('/upload/chat', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filename = `chat/${Date.now()}-${req.file.originalname}`;

  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET_CHAT,
      Key: filename,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const fileUrl = `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET_CHAT}/${filename}`;
    res.json({ url: fileUrl, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =============================================
app.listen(3001, '0.0.0.0', () => {
  console.log('\n✅ Server running at http://localhost:3001');
  console.log('   GET  /token');
  console.log('   POST /room/create');
  console.log('   GET  /join/:roomCode');
  console.log('   POST /recording/start');
  console.log('   POST /recording/stop');
  console.log('   GET  /recording/status/:egressId');
  console.log('   GET  /recordings');
  console.log('   GET  /recordings/url?key=recordings/xxx.mp4');
  console.log('   GET  /test-s3');
  console.log('   POST /upload/chat\n');
});