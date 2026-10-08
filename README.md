# HomeConnect

HomeConnect is a private two-account family calling website using **real SIP over WebSocket (WSS) for signaling and WebRTC for encrypted media**.

## How it works

HomeConnect now uses two fixed SIP identities:

- `sip:admin@<your-homeconnect-domain>`
- `sip:family@<your-homeconnect-domain>`

There is **no Family Joining Code**.

After login:

1. The browser creates a SIP.js User Agent.
2. It connects to `/sip` using the standardized SIP WebSocket subprotocol.
3. It authenticates and registers the user's fixed SIP account.
4. **Call Family** sends a real SIP `INVITE`.
5. The other browser receives the SIP `INVITE` and shows Accept/Decline.
6. Accepting returns the SIP answer and establishes WebRTC media.
7. Ending the call sends SIP `BYE`.
8. Audio/video are carried by WebRTC, not by the SIP WebSocket.

SIP.js is used as the browser SIP/WebRTC stack. The current SIP.js release is 0.21.2. SIP.js documents SIP over WebSocket and WebRTC calling, and its full API exposes `Inviter`, `Invitation`, `Registerer`, and WebRTC Session Description Handling. citeturn1search0turn8search0

SIP over WebSocket uses the standardized WebSocket subprotocol `sip` defined by RFC 7118. citeturn4search1

## Relationship to Blink WebRTC / Sylk

The Google Play app you linked is **Blink WebRTC** from AG Projects. AG Projects states that Blink WebRTC uses SylkSuite to translate between WebRTC and SIP; SylkServer/SylkPushServer are used when connecting it to SIP infrastructure. citeturn0search2turn0search0

SylkServer is a SIP/XMPP/WebRTC application server and includes a SIP/WebRTC gateway, while its WebRTC conferencing backend uses Janus for SFU media. citeturn0search1turn0search10

HomeConnect is intentionally smaller: for the two family browsers, the Node service acts as a SIP-over-WSS registrar/router, while the two browsers establish the actual WebRTC media session directly (or through TURN). This keeps the HomeConnect media path simple and avoids a mandatory media server.

## Security and transport

- SIP signaling: WSS when deployed over HTTPS.
- SIP authentication: SIP Digest authentication using the existing access-password hashes as the SIP credential secret.
- WebRTC media: browser WebRTC with DTLS-SRTP.
- ICE: STUN by default; Cloudflare TURN when configured.
- No Firebase.
- No database.
- No joining code.
- No call recording.

SIP Digest authentication is defined by RFC 3261/RFC 8760, and SIP.js supports authenticated User Agents. citeturn7search0turn7search6turn5search4

## Run locally

```bash
npm install
npm start
```

Open:

```
http://127.0.0.1:10000
```

For two-device Internet testing, deploy the service over public HTTPS. The browser then uses WSS for SIP and WebRTC for media.

## TURN

Configure:

- `CLOUDFLARE_TURN_KEY_ID`
- `CLOUDFLARE_TURN_API_TOKEN`

Without TURN, HomeConnect uses STUN and some restrictive mobile/ISP networks may fail to establish media.

## Important

This implementation uses **real SIP messages** on the WebSocket connection. It does not tunnel the old HomeConnect JSON signaling protocol inside SIP. The old `/signal`, joining-code creation, family-code storage, and custom `offer`/`answer`/`ice-candidate` message flow have been removed.
