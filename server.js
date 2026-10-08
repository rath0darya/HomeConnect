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

  if (!validToken(token)) {
    ws.close(1008, "Unauthorized");
    return;
  }

  if (peers.size >= MAX_PEERS) {
    ws.close(1013, "HomeConnect is already in use");
    return;
  }

  const id = crypto.randomUUID();
  const peer = { id, ws, role, connectedAt: new Date().toISOString() };
  peers.set(id, peer);
  logEvent("PEER_JOINED", { id, role, peerCount: peers.size });

  send(ws, { type: "welcome", peerCount: peers.size, role });
  broadcast({ type: "peer-state", peerCount: peers.size }, ws);

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
        logEvent("RING", { from: role, peerCount: peers.size });
        broadcast({ type: "incoming-call", fromRole: role }, ws);
        return;
      }

      if (message.type === "accept-call" || message.type === "decline-call" || message.type === "cancel-call") {
        logEvent(message.type.toUpperCase().replace("-", "_"), { from: role });
        broadcast({ type: message.type, fromRole: role }, ws);
        return;
      }

      broadcast(
        {
          type: message.type,
          fromRole: role,
          ...(message.description ? { description: message.description } : {}),
          ...(message.candidate ? { candidate: message.candidate } : {})
        },
        ws
      );
    } catch {
      send(ws, { type: "error", message: "Invalid signaling message." });
    }
  });

  ws.on("close", (code, reason) => {
    peers.delete(id);
    logEvent("PEER_LEFT", { id, role, code, reason: reason?.toString() || "", peerCount: peers.size });
    broadcast({ type: "peer-state", peerCount: peers.size });
    broadcast({ type: "peer-left", role });
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
