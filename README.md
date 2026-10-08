# HomeConnect

HomeConnect is a responsive family video-calling website that works over the **Internet**, not only on the same LAN/Wi-Fi.

## Architecture

- Responsive website/PWA.
- WebRTC for browser-to-browser audio/video.
- WebSocket signaling at `/signal`.
- STUN for NAT discovery.
- Cloudflare Realtime TURN credentials through `/api/turn` when configured.
- No Firebase.
- No database.
- No call recording.
- No media server/SFU: media stays peer-to-peer when possible and uses TURN only when direct connectivity is blocked.

WebRTC requires signaling so the two browsers can exchange SDP/ICE information. ICE uses STUN/TURN to find a usable path across NAT/firewalls. citeturn0search0turn0search1

## Run locally

```bash
npm install
npm start
```

Open:

```
http://127.0.0.1:10000
```

Local testing can verify the signaling flow. For real phone-to-phone Internet calling, deploy the Node service on a public HTTPS host.

## Recommended deployment

Render Web Services support public WebSockets and HTTPS/TLS, which fits this architecture. Use a **Web Service**, not a Static Site. citeturn2search0turn2search4

Start command:

```
npm start
```

The server listens on Render's `PORT` environment variable.

## TURN setup

For the strongest Internet connectivity, configure Cloudflare Realtime TURN:

1. Create a Cloudflare Realtime TURN key.
2. Keep the TURN key/API token only in the server environment.
3. Set:
   - `CLOUDFLARE_TURN_KEY_ID`
   - `CLOUDFLARE_TURN_API_TOKEN`
4. HomeConnect requests short-lived TURN credentials from `/api/turn`.

Cloudflare documents short-lived TURN credential generation and recommends keeping the long-lived TURN key server-side. citeturn3search0

Without TURN configuration, HomeConnect still uses Cloudflare's free STUN service, but some restrictive networks may fail because TURN is the relay fallback. citeturn3search3turn3search5

## Access passwords

The existing two password hashes remain supported:

- Admin
- Family

For production, set `ADMIN_PASSWORD_HASH` and `FAMILY_PASSWORD_HASH` as deployment environment variables instead of relying on repository defaults.

This is still a small private-family application; it is not a substitute for a full identity provider.

## Important

The actual audio/video does **not** go through the WebSocket signaling server. Signaling only exchanges connection setup information. WebRTC then establishes the media path directly where possible, or through TURN when NAT/firewalls require a relay. citeturn0search0turn3search3
