const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const MAX_PEERS = 2;

const ACCESS_HASHES = new Set([
  process.env.ADMIN_PASSWORD_HASH || "327179bea9bc971a7b5c6e3dd92bc6da5b63de0250b99f78ab36f263e272dc2b",
  process.env.FAMILY_PASSWORD_HASH || "cbab50a3f910d110a23b011410f55d7bd66a529388ddeeab1b6e1cf6edefeeb0"
]);

const peers = new Map();
const familyLinks = new Map();
const activeRings = new Map();

function createFamilyCode() {
  let code;
  do {
    code = String(crypto.randomInt(100000, 1000000));
  } while (familyLinks.has(code));
  familyLinks.set(code, { createdAt: new Date().toISOString() });
  return code;
}

function maskCode(code) {
  return typeof code === "string" ? code.slice(0, 2) + "****" : "unknown";
}

function familyPeers(code) {
  return [...peers.values()].filter((peer) => peer.code === code);
}

function logEvent(event, details = {}) {
  console.log(new Date().toISOString() + " [CALL] " + event + (Object.keys(details).length ? " " + JSON.stringify(details) : ""));
}

function validToken(token) {
  return typeof token === "string" && ACCESS_HASHES.has(token);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function turnCredentials(token) {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

  if (!keyId || !apiToken) {
    return { iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }], turnConfigured: false };
  }

  const response = await fetch(
    "https://rtc.live.cloudflare.com/v1/turn/keys/" +
      encodeURIComponent(keyId) +
      "/credentials/generate-ice-servers",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ttl: 3600,
        customIdentifier: "homeconnect-" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)
      })
    }
  );

  if (!response.ok) {
    throw new Error("TURN credential request failed: HTTP " + response.status);
  }

  const data = await response.json();
  return {
    iceServers: Array.isArray(data.iceServers) ? data.iceServers : [],
    turnConfigured: true
  };
}

function serveStatic(req, res) {
  const requestPath = new URL(req.url, "http://localhost").pathname;
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT, relative);

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    return json(res, 403, { error: "Forbidden" });
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) return json(res, 404, { error: "Not found" });

    const ext = path.extname(filePath).toLowerCase();
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".svg": "image/svg+xml"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'self'; connect-src 'self' https://rtc.live.cloudflare.com wss:; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self';"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        service: "HomeConnect",
        signaling: true,
        turnConfigured: Boolean(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN)
      });
    }

    if (req.method === "POST" && url.pathname === "/api/family/create") {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!validToken(token) || token !== (process.env.ADMIN_PASSWORD_HASH || "327179bea9bc971a7b5c6e3dd92bc6da5b63de0250b99f78ab36f263e272dc2b")) {
        return json(res, 401, { error: "Admin authorization required" });
      }
      const code = createFamilyCode();
      logEvent("FAMILY_CREATED", { code: maskCode(code) });
      return json(res, 200, { ok: true, code });
    }

    if (req.method === "GET" && url.pathname === "/api/turn") {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!validToken(token)) return json(res, 401, { error: "Unauthorized" });

      const result = await turnCredentials(token);
      return json(res, 200, result);
    }

    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "Internal server error" });
  }
});

const wss = new WebSocketServer({ server, path: "/signal" });

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(message, except) {
  for (const peer of peers.values()) {
    if (peer.ws !== except) send(peer.ws, message);
  }
}

wss.on("connection", (ws, request) => {
  const url = new URL(request.url, "http://localhost");
  const token = url.searchParams.get("token");
  const role = url.searchParams.get("role") === "admin" ? "admin" : "family";
  const code = url.searchParams.get("code") || "";

  if (!validToken(token)) {
    ws.close(1008, "Unauthorized");
    return;
  }

  if (!/^[0-9]{6}$/.test(code) || !familyLinks.has(code)) {
    logEvent("JOIN_REJECTED", { role, code: maskCode(code), reason: "invalid-family-code" });
    ws.close(1008, "Invalid family joining code");
    return;
  }

  const existing = familyPeers(code);
  if (existing.some((peer) => peer.role === role)) {
    logEvent("JOIN_REJECTED", { role, code: maskCode(code), reason: "same-role-already-connected" });
    ws.close(1008, "This family member is already connected");
    return;
  }

  if (existing.length >= MAX_PEERS) {
    logEvent("JOIN_REJECTED", { role, code: maskCode(code), reason: "family-full" });
    ws.close(1013, "Family is already connected");
    return;
  }

  const id = crypto.randomUUID();
  const peer = { id, ws, role, code, connectedAt: new Date().toISOString() };
  peers.set(id, peer);
  const count = familyPeers(code).length;
  logEvent("PEER_JOINED", { id, role, code: maskCode(code), familyPeerCount: count });

  send(ws, { type: "welcome", peerCount: count, role, code });
  for (const member of familyPeers(code)) {
    if (member.ws !== ws) send(member.ws, { type: "peer-state", peerCount: count });
  }
  send(ws, { type: "peer-state", peerCount: count });

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      logEvent("SIGNAL", { from: role, type: message.type });
      const allowed = new Set([
        "start-call",
        "accept-call",
        "decline-call",
        "cancel-call",
        "offer",
        "answer",
        "ice-candidate",
        "hangup",
        "ping"
      ]);
      if (!allowed.has(message.type)) return;

      if (message.type === "ping") {
        send(ws, { type: "pong" });
        return;
      }

      if (message.type === "start-call") {
        const members = familyPeers(code);
        if (members.length < 2) {
          logEvent("RING_REJECTED", { from: role, code: maskCode(code), reason: "family-member-not-online", familyPeerCount: members.length });
          send(ws, { type: "call-error", reason: "peer-not-online" });
          return;
        }
        const activeRing = activeRings.get(code);
        if (activeRing && activeRing.fromRole !== role) {
          logEvent("RING_REJECTED", { from: role, reason: "another-ring-active", activeFrom: activeRing.fromRole });
          send(ws, { type: "call-error", reason: "another-ring-active" });
          return;
        }
        activeRings.set(code, { fromRole: role, startedAt: new Date().toISOString() });
        const target = members.find((peer) => peer.ws !== ws);
        logEvent("RING", { from: role, to: target?.role || "unknown", code: maskCode(code), familyPeerCount: members.length });
        if (target) send(target.ws, { type: "incoming-call", fromRole: role });
        return;
      }

      if (message.type === "accept-call" || message.type === "decline-call" || message.type === "cancel-call") {
        logEvent(message.type.toUpperCase().replace("-", "_"), { from: role, code: maskCode(code), activeRing: activeRings.get(code) || null });
        if (message.type !== "accept-call") activeRings.delete(code);
        for (const member of familyPeers(code)) {
          if (member.ws !== ws) send(member.ws, { type: message.type, fromRole: role });
        }
        return;
      }

      if (message.type === "hangup") activeRings.delete(code);
      for (const member of familyPeers(code)) {
        if (member.ws !== ws) send(member.ws, {
          type: message.type,
          fromRole: role,
          ...(message.description ? { description: message.description } : {}),
          ...(message.candidate ? { candidate: message.candidate } : {})
        });
      }
    } catch {
      send(ws, { type: "error", message: "Invalid signaling message." });
    }
  });

  ws.on("close", (closeCode, reason) => {
    peers.delete(id);
    if (activeRings.get(code)?.fromRole === role) activeRings.delete(code);
    const count = familyPeers(code).length;
    logEvent("PEER_LEFT", { id, role, code: maskCode(code), familyPeerCount: count, closeCode, reason: reason?.toString() || "" });
    for (const member of familyPeers(code)) {
      send(member.ws, { type: "peer-state", peerCount: count });
      send(member.ws, { type: "peer-left", role });
    }
  });

  ws.on("error", (error) => {
    logEvent("WEBSOCKET_ERROR", { id, role, error: error.message });
    peers.delete(id);
  });
});

setInterval(() => {
  for (const peer of peers.values()) {
    if (peer.ws.readyState === peer.ws.OPEN) peer.ws.ping();
  }
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("HomeConnect listening on port " + PORT);
  logEvent("SERVER_READY", { port: PORT, turnConfigured: Boolean(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN) });
});
