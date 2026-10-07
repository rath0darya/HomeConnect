import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const ADMIN_PASSWORD = process.env.HOMECONNECT_ADMIN_PASSWORD || "RuhiSinghRajput";
const FAMILY_PASSWORD = process.env.HOMECONNECT_FAMILY_PASSWORD || "Praveen@8897";

const clients = new Map();
const roles = new Map();
const activeCall = { callId: null, caller: null, callee: null };

const ROOT = path.resolve(process.cwd());
const PUBLIC_FILES = new Set(["index.html", "style.css", "app.js", "config.js"]);

function id() { return crypto.randomUUID(); }

function equalSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function auth(password) {
  if (equalSecret(password, ADMIN_PASSWORD)) return { role: "admin", name: "You" };
  if (equalSecret(password, FAMILY_PASSWORD)) return { role: "family", name: "Family" };
  return null;
}

function send(client, data) {
  if (!client?.socket || client.socket.readyState !== WebSocket.OPEN) return false;
  try {
    client.socket.send(JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function peerOf(client) {
  for (const other of clients.values()) {
    if (other !== client && other.role !== client.role && other.connected) return other;
  }
  return null;
}

function clearCall(reason = "ended", except = null) {
  if (!activeCall.callId) return;

  for (const session of [activeCall.caller, activeCall.callee]) {
    const participant = clients.get(session);
    if (participant && participant !== except) {
      send(participant, { type: "call-ended", callId: activeCall.callId, reason });
    }
  }

  activeCall.callId = null;
  activeCall.caller = null;
  activeCall.callee = null;
}

function removeClient(client) {
  if (!client) return;

  if (roles.get(client.role) === client) roles.delete(client.role);
  if (clients.get(client.sessionId) === client) clients.delete(client.sessionId);

  if (client.expiryTimer) clearTimeout(client.expiryTimer);
}

function expireDisconnected(client) {
  client.expiryTimer = setTimeout(() => {
    if (client.connected) return;

    const wasParticipant =
      activeCall.caller === client.sessionId ||
      activeCall.callee === client.sessionId;

    if (wasParticipant) clearCall("peer-left", client);

    const peer = peerOf(client);
    removeClient(client);

    if (peer) send(peer, { type: "peer-offline" });
  }, 45_000);
}

function join(ws, message) {
  if (ws.client) return;

  const identity = auth(message.password);

  if (!identity) {
    ws.send(JSON.stringify({ type: "auth-failed", message: "Incorrect password." }));
    ws.close(4001, "Authentication failed");
    return;
  }

  const sessionId =
    typeof message.sessionId === "string" && message.sessionId.length >= 10
      ? message.sessionId
      : id();

  const existing = clients.get(sessionId);
  const occupied = roles.get(identity.role);

  if (occupied && occupied !== existing && occupied.connected) {
    ws.send(JSON.stringify({
      type: "role-in-use",
      message: "This family account is already active on another device."
    }));
    ws.close(4003, "Role already connected");
    return;
  }

  let client = existing;

  if (client) {
    if (client.role !== identity.role) {
      ws.send(JSON.stringify({ type: "auth-failed", message: "Invalid session." }));
      ws.close(4001, "Invalid session");
      return;
    }

    clearTimeout(client.expiryTimer);
    client.expiryTimer = null;
    client.socket = ws;
    client.connected = true;
    client.isAlive = true;
  } else {
    client = {
      sessionId,
      role: identity.role,
      name: identity.name,
      socket: ws,
      connected: true,
      isAlive: true,
      expiryTimer: null
    };

    clients.set(sessionId, client);
    roles.set(identity.role, client);
  }

  ws.client = client;

  const peer = peerOf(client);

  send(client, {
    type: "authenticated",
    sessionId,
    role: client.role,
    name: client.name,
    peerOnline: Boolean(peer)
  });

  if (peer) {
    send(peer, { type: "peer-online" });
    send(client, { type: "peer-online" });
  }
}

function route(ws, message) {
  const client = ws.client;

  if (message.type === "join") {
    join(ws, message);
    return;
  }

  if (!client) {
    ws.send(JSON.stringify({ type: "server-error", message: "Authenticate first." }));
    return;
  }

  if (message.type === "logout") {
    clearCall("logout", client);
    const peer = peerOf(client);
    removeClient(client);
    if (peer) send(peer, { type: "peer-offline" });
    ws.close(1000, "Logout");
    return;
  }

  if (message.type === "ping") {
    send(client, { type: "pong", timestamp: Date.now() });
    return;
  }

  if (message.type === "call-invite") {
    if (activeCall.callId) {
      send(client, { type: "call-busy", callId: message.callId || null });
      return;
    }

    const peer = peerOf(client);

    if (!peer) {
      send(client, { type: "peer-offline" });
      return;
    }

    activeCall.callId = message.callId || id();
    activeCall.caller = client.sessionId;
    activeCall.callee = peer.sessionId;

    send(peer, {
      type: "incoming-call",
      callId: activeCall.callId,
      callerRole: client.role,
      callerName: client.name
    });

    return;
  }

  if (message.type === "call-accepted") {
    if (message.callId !== activeCall.callId || client.sessionId !== activeCall.callee) return;

    const caller = clients.get(activeCall.caller);
    if (caller) send(caller, { type: "call-accepted", callId: activeCall.callId });
    return;
  }

  if (message.type === "call-declined") {
    if (message.callId !== activeCall.callId || client.sessionId !== activeCall.callee) return;

    const caller = clients.get(activeCall.caller);
    if (caller) send(caller, { type: "call-declined", callId: activeCall.callId });
    clearCall("declined", client);
    return;
  }

  if (message.type === "call-ended") {
    if (message.callId !== activeCall.callId) return;
    clearCall("ended", client);
    return;
  }

  const signaling = new Set([
    "offer",
    "answer",
    "ice-candidate",
    "ice-restart-request"
  ]);

  if (signaling.has(message.type)) {
    if (message.callId !== activeCall.callId) return;

    const targetSession =
      client.sessionId === activeCall.caller
        ? activeCall.callee
        : client.sessionId === activeCall.callee
          ? activeCall.caller
          : null;

    const target = targetSession ? clients.get(targetSession) : null;

    if (!target) {
      send(client, { type: "peer-offline" });
      return;
    }

    send(target, { ...message, fromRole: client.role });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      name: "HomeConnect",
      status: "ok",
      database: false,
      media: "WebRTC peer-to-peer"
    }));
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);

  if (!PUBLIC_FILES.has(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  fs.readFile(path.join(ROOT, file), (error, data) => {
    if (error) {
      res.writeHead(500);
      res.end("Server error");
      return;
    }

    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8"
    };

    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });

    res.end(data);
  });
});

const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: 1024 * 1024
});

wss.on("connection", (ws) => {
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
    if (ws.client) ws.client.isAlive = true;
  });

  ws.on("message", (data) => {
    try {
      route(ws, JSON.parse(data.toString()));
    } catch {
      send(ws.client, {
        type: "server-error",
        message: "Invalid signaling message."
      });
    }
  });

  ws.on("close", () => {
    const client = ws.client;
    if (!client || client.socket !== ws) return;

    client.socket = null;
    client.connected = false;

    const peer = peerOf(client);
    if (peer) send(peer, { type: "peer-offline" });

    expireDisconnected(client);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 20_000);

heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log(`HomeConnect listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket signaling: ws://${HOST}:${PORT}/ws`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const client of clients.values()) {
    try { client.socket?.close(1001, "Server shutdown"); } catch {}
  }
  wss.close(() => server.close(() => process.exit(0)));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
