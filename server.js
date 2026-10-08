const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const SIP_REALM = process.env.SIP_REALM || "homeconnect";
const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH || "327179bea9bc971a7b5c6e3dd92bc6da5b63de0250b99f78ab36f263e272dc2b";
const FAMILY_HASH = process.env.FAMILY_PASSWORD_HASH || "cbab50a3f910d110a23b011410f55d7bd66a529388ddeeab1b6e1cf6edefeeb0";

const credentials = Object.freeze({ admin: ADMIN_HASH, family: FAMILY_HASH });
const registrations = new Map();
const calls = new Map();
const nonces = new Map();

function logEvent(event, details = {}) {
  console.log(new Date().toISOString() + " [SIP] " + event + (Object.keys(details).length ? " " + JSON.stringify(details) : ""));
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

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
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
        customIdentifier: "homeconnect-" + sha256(token).slice(0, 16)
      })
    }
  );
  if (!response.ok) throw new Error("TURN credential request failed: HTTP " + response.status);
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
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) return json(res, 403, { error: "Forbidden" });

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
        "default-src 'self'; connect-src 'self' https://rtc.live.cloudflare.com https://cdn.jsdelivr.net wss: ws:; media-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' https://cdn.jsdelivr.net;"
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
        signaling: "sip-over-websocket",
        sip: true,
        registrations: registrations.size,
        activeCalls: calls.size,
        turnConfigured: Boolean(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN)
      });
    }

    if (req.method === "GET" && url.pathname === "/api/turn") {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (![ADMIN_HASH, FAMILY_HASH].includes(token)) return json(res, 401, { error: "Unauthorized" });
      return json(res, 200, await turnCredentials(token));
    }

    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "Internal server error" });
  }
});

const wss = new WebSocketServer({
  server,
  path: "/sip",
  handleProtocols: (protocols) => protocols.has("sip") ? "sip" : false
});

function parseSip(raw) {
  const text = raw.toString().replace(/^\uFEFF/, "");
  const split = text.indexOf("\r\n\r\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 4) : "";
  const lines = head.split("\r\n");
  const start = lines.shift() || "";
  const headers = {};
  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const name = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers[name] = headers[name] ? headers[name] + "\r\n" + value : value;
  }
  const requestMatch = start.match(/^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/);
  const responseMatch = start.match(/^SIP\/2\.0\s+(\d+)\s*(.*)$/);
  return {
    raw: text,
    start,
    headers,
    body,
    isRequest: Boolean(requestMatch),
    method: requestMatch?.[1] || null,
    uri: requestMatch?.[2] || null,
    status: responseMatch ? Number(responseMatch[1]) : null,
    reason: responseMatch?.[2] || ""
  };
}

function header(message, name) {
  return message.headers[name.toLowerCase()] || "";
}

function headerUser(value) {
  const match = String(value).match(/sip:([^@;>\s]+)/i);
  return match?.[1]?.toLowerCase() || "";
}

function callId(message) {
  return header(message, "call-id");
}

function targetUser(uri) {
  return headerUser(uri);
}

function compactResponse(request, status, reason, extra = []) {
  const via = header(request, "via");
  const lines = [
    "SIP/2.0 " + status + " " + reason,
    ...(via ? via.split("\r\n").map((v) => "Via: " + v) : []),
    "From: " + header(request, "from"),
    "To: " + header(request, "to"),
    "Call-ID: " + header(request, "call-id"),
    "CSeq: " + header(request, "cseq"),
    ...extra,
    "Content-Length: 0",
    "",
    ""
  ];
  return lines.join("\r\n");
}

function parseDigest(value) {
  if (!value || !/^Digest\s+/i.test(value)) return null;
  const result = {};
  const text = value.replace(/^Digest\s+/i, "");
  const re = /([a-zA-Z0-9_-]+)=(?:"((?:\\.|[^"])*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(text))) result[match[1].toLowerCase()] = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
  return result;
}

function digestResponse({ username, password, realm, method, uri, nonce, nc, cnonce }) {
  const ha1 = crypto.createHash("md5").update(username + ":" + realm + ":" + password).digest("hex");
  const ha2 = crypto.createHash("md5").update(method + ":" + uri).digest("hex");
  return crypto.createHash("md5").update(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":auth:" + ha2).digest("hex");
}

function issueNonce() {
  const nonce = crypto.randomBytes(24).toString("hex");
  nonces.set(nonce, Date.now());
  return nonce;
}

function challenge(request) {
  const nonce = issueNonce();
  return compactResponse(request, 401, "Unauthorized", [
    'WWW-Authenticate: Digest realm="' + SIP_REALM + '", qop="auth", nonce="' + nonce + '"'
  ]);
}

function authenticate(request, username) {
  const password = credentials[username];
  const auth = parseDigest(header(request, "authorization"));
  if (!password || !auth || auth.username !== username || auth.realm !== SIP_REALM || !auth.nonce || !nonces.has(auth.nonce)) return false;
  if (Date.now() - nonces.get(auth.nonce) > 300000) {
    nonces.delete(auth.nonce);
    return false;
  }
  const expected = digestResponse({
    username,
    password,
    realm: SIP_REALM,
    method: request.method,
    uri: auth.uri,
    nonce: auth.nonce,
    nc: auth.nc || "00000001",
    cnonce: auth.cnonce || ""
  });
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(auth.response || "")));
  } catch {
    return false;
  }
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(message);
}

function sendSimpleResponse(ws, request, status, reason) {
  send(ws, compactResponse(request, status, reason));
}

function otherRegistered(username) {
  return registrations.get(username);
}

function removeCall(call) {
  if (!call) return;
  calls.delete(call.id);
}

wss.on("connection", (ws) => {
  let username = null;
  logEvent("WS_CONNECTED");

  ws.on("message", (raw) => {
    let message;
    try {
      message = parseSip(raw);
    } catch {
      return;
    }

    logEvent("MESSAGE", {
      direction: message.isRequest ? "request" : "response",
      method: message.method || message.status,
      callId: callId(message)
    });

    if (!message.isRequest) {
      const id = callId(message);
      const call = calls.get(id);
      if (call) send(ws === call.a.ws ? call.b.ws : call.a.ws, message.raw);
      if ([200, 487, 486, 603].includes(message.status) && call && message.status !== 200) removeCall(call);
      return;
    }

    const method = message.method;

    if (method === "REGISTER") {
      const requestedUser = headerUser(header(message, "to")) || headerUser(message.uri);
      if (!credentials[requestedUser]) {
        sendSimpleResponse(ws, message, 403, "Forbidden");
        return;
      }
      if (!authenticate(message, requestedUser)) {
        send(ws, challenge(message));
        return;
      }

      const expiresHeader = header(message, "expires");
      const contact = header(message, "contact");
      const expiresMatch = contact.match(/expires\s*=\s*(\d+)/i) || expiresHeader.match(/^\d+$/) && ["", expiresHeader];
      const expires = Number(expiresMatch?.[1] || expiresHeader || 600);
      if (expires === 0) {
        registrations.delete(requestedUser);
        username = null;
        sendSimpleResponse(ws, message, 200, "OK");
        logEvent("UNREGISTERED", { user: requestedUser });
        return;
      }

      username = requestedUser;
      registrations.set(requestedUser, { ws, contact, registeredAt: Date.now() });
      send(ws, compactResponse(message, 200, "OK", [
        "Contact: " + (contact || "<sip:" + requestedUser + "@homeconnect>"),
        "Expires: " + Math.min(expires, 600)
      ]));
      logEvent("REGISTERED", { user: requestedUser });
      return;
    }

    if (method === "OPTIONS") {
      sendSimpleResponse(ws, message, 200, "OK");
      return;
    }

    if (!username || registrations.get(username)?.ws !== ws) {
      sendSimpleResponse(ws, message, 403, "Forbidden");
      return;
    }

    const id = callId(message);

    if (method === "INVITE") {
      const target = targetUser(message.uri);
      const destination = otherRegistered(target);
      if (!destination || destination.ws === ws) {
        sendSimpleResponse(ws, message, 480, "Temporarily Unavailable");
        return;
      }
      if (calls.has(id)) {
        sendSimpleResponse(ws, message, 482, "Loop Detected");
        return;
      }
      calls.set(id, {
        id,
        a: { user: username, ws },
        b: { user: target, ws: destination.ws },
        createdAt: Date.now()
      });
      sendSimpleResponse(ws, message, 100, "Trying");
      send(destination.ws, message.raw);
      logEvent("INVITE", { from: username, to: target, callId: id });
      return;
    }

    const call = calls.get(id);
    if (!call) {
      if (method === "BYE" || method === "CANCEL") sendSimpleResponse(ws, message, 481, "Call/Transaction Does Not Exist");
      return;
    }

    const destination = ws === call.a.ws ? call.b.ws : call.a.ws;
    send(destination, message.raw);

    if (method === "BYE" || method === "CANCEL") {
      setTimeout(() => removeCall(call), 5000);
    }
  });

  ws.on("close", () => {
    if (username && registrations.get(username)?.ws === ws) registrations.delete(username);
    for (const [id, call] of calls) {
      if (call.a.ws === ws || call.b.ws === ws) {
        const other = call.a.ws === ws ? call.b.ws : call.a.ws;
        if (other?.readyState === other.OPEN) {
          const bye = [
            "BYE sip:" + (call.a.ws === ws ? call.b.user : call.a.user) + "@homeconnect SIP/2.0",
            "From: <sip:server@homeconnect>",
            "To: <sip:" + (call.a.ws === ws ? call.b.user : call.a.user) + "@homeconnect>",
            "Call-ID: " + id,
            "CSeq: 1 BYE",
            "Content-Length: 0",
            "",
            ""
          ].join("\r\n");
          send(other, bye);
        }
        calls.delete(id);
      }
    }
    logEvent("WS_CLOSED", { user: username || "unregistered" });
  });

  ws.on("error", (error) => logEvent("WS_ERROR", { user: username || "unregistered", error: error.message }));
});

setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [nonce, created] of nonces) if (created < cutoff) nonces.delete(nonce);
  for (const [id, call] of calls) if (call.createdAt < cutoff) calls.delete(id);
}, 60000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("HomeConnect SIP/WebRTC listening on port " + PORT);
  logEvent("SERVER_READY", {
    port: PORT,
    transport: "SIP over WebSocket",
    realm: SIP_REALM,
    turnConfigured: Boolean(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN)
  });
});
