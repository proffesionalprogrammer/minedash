// ─── MineDash Connect — built-in zero-infra P2P tunnel ─────────────────────────
//
// Lets a friend reach a host's running Minecraft server without Radmin/Hamachi,
// without router config, and without a kernel driver. It's a userspace WebRTC
// data-channel tunnel:
//
//   Friend's MC client → friend MineDash (local TCP listener 127.0.0.1:<port>)
//     → encrypted RTCDataChannel (DTLS, NAT hole-punched via public STUN)
//       → host MineDash → host's localhost:<server-port>
//
// Signalling is *serverless* — there is no signalling server and no TURN relay
// (the user explicitly wanted zero hosted infrastructure). The host generates an
// "invite code" (gzip+base64 of the offer SDP), the friend pastes it and replies
// with a "reply code" (the answer SDP), exchanged out-of-band (Discord, etc.).
// Because there's no TURN relay this is P2P-only: symmetric-NAT / CGNAT pairs that
// can't hole-punch fall back to Radmin (which is why that path is kept).
//
// Topology (validated against werift 0.23):
//   HOST  = offerer. Creates a 'ctrl' channel before the offer so SCTP is
//           negotiated, then bridges every inbound RTCDataChannel to a fresh TCP
//           socket dialed at 127.0.0.1:<server-port>.
//   FRIEND = answerer. On connect, opens a local TCP listener; for each inbound
//           Minecraft socket it opens one RTCDataChannel (host receives it via
//           ondatachannel). Channels are reliable+ordered, giving TCP semantics.
//
// This module mirrors backend/launcher.js's init()/register() shape and runs in
// the main backend process (so it inherits the process-wide
// dns.setDefaultResultOrder('ipv4first') set at the top of index.js).

const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { RTCPeerConnection } = require('werift');

let io = null;
let getServerPort = null; // async (serverId) => number, injected from index.js

// Free public STUN servers (NAT discovery only — they never see game traffic).
// A few for redundancy; no TURN relay by design.
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// Tunables for the TCP↔DataChannel bridge.
const CHUNK = 16 * 1024;          // max bytes per dc.send (SCTP message size safety)
const HIGH_WATER = 1 * 1024 * 1024; // pause the TCP read side above this buffered amount
const LOW_WATER = 256 * 1024;       // resume once buffered drains below this
const GATHER_TIMEOUT = 3500;        // ms to wait for non-trickle ICE gathering
const SESSION_TTL = 30 * 60 * 1000; // sweep unconnected sessions after 30 min

// sessionId -> { role, pc, status, serverPort?, localPort?, tcpServer?, sockets:Set, channels:Set, createdAt }
const sessions = new Map();

function init(deps) {
  io = deps.io;
  getServerPort = deps.getServerPort;
  // Sweep stale sessions that never finished connecting so dangling peers don't
  // leak. Connected sessions are kept until explicitly torn down.
  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.status !== 'connected' && now - s.createdAt > SESSION_TTL) destroySession(id);
    }
  }, 60 * 1000).unref();
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function genId() {
  return crypto.randomBytes(6).toString('hex');
}

function encodeCode(type, sdp) {
  const json = JSON.stringify({ t: type, sdp });
  return zlib.gzipSync(Buffer.from(json, 'utf8')).toString('base64');
}

function decodeCode(code) {
  const json = zlib.gunzipSync(Buffer.from(String(code).trim(), 'base64')).toString('utf8');
  const obj = JSON.parse(json);
  if (!obj || !obj.sdp || !obj.t) throw new Error('malformed code');
  return obj;
}

// Normalise whatever a werift datachannel hands us into a Buffer.
function toBuf(d) {
  if (Buffer.isBuffer(d)) return d;
  if (typeof d === 'string') return Buffer.from(d, 'utf8');
  if (d instanceof ArrayBuffer) return Buffer.from(d);
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  return Buffer.from(d);
}

// Reliable+ordered channels reassemble in order, and TCP is a byte stream, so we
// don't need length framing — just keep each send under the SCTP message cap.
function sendChunked(dc, buf) {
  if (dc.readyState !== 'open') return;
  if (buf.length <= CHUNK) { dc.send(buf); return; }
  for (let i = 0; i < buf.length; i += CHUNK) dc.send(buf.subarray(i, i + CHUNK));
}

// Backpressure on a socket→datachannel path: pause the socket when the channel's
// buffer grows, resume once it drains. Poll-based so we don't depend on werift's
// bufferedAmountLow event firing semantics — the interval only runs while paused.
function applyBackpressure(socket, dc) {
  if (dc.bufferedAmount <= HIGH_WATER || socket.isPaused()) return;
  socket.pause();
  const iv = setInterval(() => {
    if (dc.readyState !== 'open' || socket.destroyed) { clearInterval(iv); return; }
    if (dc.bufferedAmount < LOW_WATER) { clearInterval(iv); socket.resume(); }
  }, 50);
  iv.unref();
}

function waitGather(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, GATHER_TIMEOUT);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    };
  });
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p - start > 50) return reject(new Error('no free local port'));
      const srv = net.createServer();
      srv.once('error', () => { srv.close(() => tryPort(p + 1)); });
      srv.once('listening', () => { srv.close(() => resolve(p)); });
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

function emitStatus(id, state, extra = {}) {
  const s = sessions.get(id);
  if (s) s.status = state;
  if (io) io.emit(`connect_status_${id}`, { sessionId: id, state, ...extra });
}

function destroySession(id) {
  const s = sessions.get(id);
  if (!s) return;
  for (const sock of s.sockets) { try { sock.destroy(); } catch (_) {} }
  for (const ch of s.channels) { try { ch.close(); } catch (_) {} }
  if (s.tcpServer) { try { s.tcpServer.close(); } catch (_) {} }
  try { s.pc.close(); } catch (_) {}
  sessions.delete(id);
  if (io) io.emit(`connect_status_${id}`, { sessionId: id, state: 'closed' });
}

// Wire pc-level connection events to status updates. `onConnected` runs the
// role-specific work (host: nothing; friend: open the local listener).
function wireConnectionState(id, pc, onConnected) {
  let connectedOnce = false;
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState;
    if (st === 'connected' && !connectedOnce) {
      connectedOnce = true;
      Promise.resolve()
        .then(() => onConnected && onConnected())
        .catch((e) => emitStatus(id, 'failed', { detail: String(e && e.message || e) }));
    } else if (st === 'failed') {
      emitStatus(id, 'failed', {
        detail: 'Could not connect directly (strict NAT). Use Radmin VPN as a fallback.',
      });
    } else if (st === 'disconnected') {
      emitStatus(id, 'failed', { detail: 'Connection lost.' });
    } else if (st === 'closed') {
      emitStatus(id, 'closed');
    }
  };
}

// ─── HOST side: bridge an inbound datachannel → TCP socket to the MC server ─────

function bridgeHostChannel(session, dc) {
  session.channels.add(dc);
  const socket = net.connect(session.serverPort, '127.0.0.1');
  session.sockets.add(socket);

  let socketReady = false;
  const pending = []; // bytes from friend that arrived before the MC socket connected

  socket.on('connect', () => {
    socketReady = true;
    for (const b of pending) socket.write(b);
    pending.length = 0;
  });
  socket.on('data', (buf) => { sendChunked(dc, buf); applyBackpressure(socket, dc); });
  socket.on('close', () => { try { dc.close(); } catch (_) {} });
  socket.on('error', () => { try { dc.close(); } catch (_) {} });

  dc.onmessage = (ev) => {
    const b = toBuf(ev.data);
    if (socketReady) socket.write(b); else pending.push(b);
  };
  dc.onclose = () => { try { socket.end(); } catch (_) {} };
  dc.onerror = () => { try { socket.destroy(); } catch (_) {} };
}

// ─── FRIEND side: bridge a local Minecraft socket → a new datachannel ───────────

function bridgeFriendSocket(session, socket, dc) {
  session.sockets.add(socket);
  session.channels.add(dc);

  let dcOpen = false;
  const pending = []; // bytes from MC client that arrived before the channel opened

  dc.onopen = () => {
    dcOpen = true;
    for (const b of pending) sendChunked(dc, b);
    pending.length = 0;
  };
  dc.onmessage = (ev) => { try { socket.write(toBuf(ev.data)); } catch (_) {} };
  dc.onclose = () => { try { socket.end(); } catch (_) {} };
  dc.onerror = () => { try { socket.destroy(); } catch (_) {} };

  socket.on('data', (buf) => {
    if (dcOpen) { sendChunked(dc, buf); applyBackpressure(socket, dc); }
    else pending.push(buf);
  });
  socket.on('close', () => { try { dc.close(); } catch (_) {} });
  socket.on('error', () => { try { dc.close(); } catch (_) {} });
}

async function startFriendListener(session, id) {
  const port = await findFreePort(25565);
  let n = 0;
  const server = net.createServer((socket) => {
    const dc = session.pc.createDataChannel(`conn-${++n}`);
    bridgeFriendSocket(session, socket, dc);
  });
  server.on('error', (e) => emitStatus(id, 'failed', { detail: 'Local listener error: ' + e.message }));
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  session.tcpServer = server;
  session.localPort = port;
  emitStatus(id, 'connected', { localPort: port });
}

// ─── HTTP routes ─────────────────────────────────────────────────────────────

function register(app) {
  // Host a session for a specific (already-running) server → returns invite code.
  app.post('/api/connect/host/:serverId', async (req, res) => {
    try {
      const serverPort = await getServerPort(req.params.serverId);
      const id = genId();
      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      const session = {
        role: 'host', pc, serverPort, status: 'gathering',
        sockets: new Set(), channels: new Set(), createdAt: Date.now(),
      };
      sessions.set(id, session);

      // Friend opens one channel per MC socket; bridge each to the local server.
      pc.ondatachannel = (e) => { if (e.channel.label !== 'ctrl') bridgeHostChannel(session, e.channel); };
      wireConnectionState(id, pc);

      // 'ctrl' channel is never used for data — it just forces SCTP into the offer
      // SDP so the friend (answerer) can open channels later.
      pc.createDataChannel('ctrl');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitGather(pc);

      const inviteCode = encodeCode('offer', pc.localDescription.sdp);
      emitStatus(id, 'awaiting-reply');
      res.json({ sessionId: id, inviteCode });
    } catch (e) {
      res.status(500).json({ error: 'Failed to create session: ' + (e.message || e) });
    }
  });

  // Host applies the friend's reply code → completes the handshake.
  app.post('/api/connect/host/:sessionId/answer', async (req, res) => {
    const s = sessions.get(req.params.sessionId);
    if (!s || s.role !== 'host') return res.status(404).json({ error: 'Session not found' });
    try {
      const { t, sdp } = decodeCode(req.body && req.body.replyCode);
      if (t !== 'answer') return res.status(400).json({ error: 'Expected a reply code' });
      emitStatus(req.params.sessionId, 'connecting');
      await s.pc.setRemoteDescription({ type: 'answer', sdp });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: 'Invalid reply code' });
    }
  });

  // Friend joins using the host's invite code → returns the reply code to send back.
  app.post('/api/connect/join', async (req, res) => {
    try {
      const { t, sdp } = decodeCode(req.body && req.body.inviteCode);
      if (t !== 'offer') return res.status(400).json({ error: 'Expected an invite code' });
      const id = genId();
      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
      const session = {
        role: 'join', pc, status: 'connecting',
        sockets: new Set(), channels: new Set(), createdAt: Date.now(),
      };
      sessions.set(id, session);

      // Once connected, stand up the local listener Minecraft connects to.
      wireConnectionState(id, pc, () => startFriendListener(session, id));

      await pc.setRemoteDescription({ type: 'offer', sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitGather(pc);

      const replyCode = encodeCode('answer', pc.localDescription.sdp);
      res.json({ sessionId: id, replyCode });
    } catch (e) {
      res.status(400).json({ error: 'Invalid invite code' });
    }
  });

  // Status poll fallback (the socket channel is the primary update path).
  app.get('/api/connect/:sessionId', (req, res) => {
    const s = sessions.get(req.params.sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    res.json({ sessionId: req.params.sessionId, role: s.role, status: s.status, localPort: s.localPort || null });
  });

  // Tear a session down (either side).
  app.delete('/api/connect/:sessionId', (req, res) => {
    destroySession(req.params.sessionId);
    res.json({ ok: true });
  });
}

module.exports = { init, register };
