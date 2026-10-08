# HomeConnect

HomeConnect is a private two-account family calling website using **real SIP over WebSocket (WSS) for signaling and WebRTC for encrypted media**.

## MySQL backend persistence

MySQL is used only for minimal family connection/presence state.

Stored:
- fixed account online/offline state
- SIP registration timestamp
- last presence heartbeat

Not stored:
- audio/video
- call recordings
- WebRTC media
- SIP message history
- call history
- chat/messages
- joining codes
- call content

The live SIP/WebSocket connection remains in memory. MySQL cannot keep a browser WebSocket alive across a Node restart; browsers reconnect and register again.

The server automatically creates one small `homeconnect_presence` table.

## Database configuration

Preferred:

```text
MYSQL_URL=mysql://USER:PASSWORD@HOST:3306/DATABASE
MYSQL_SSL=true
MYSQL_SSL_REJECT_UNAUTHORIZED=true
```

Or:

```text
MYSQL_HOST=
MYSQL_PORT=3306
MYSQL_USER=
MYSQL_PASSWORD=
MYSQL_DATABASE=homeconnect
```

Set `MYSQL_REQUIRED=true` if MySQL must be available for startup.

## SIP/WebRTC flow

1. Browser logs in with the fixed family/admin password.
2. Browser creates a SIP.js User Agent.
3. Browser connects to `/sip`.
4. SIP Digest authentication completes.
5. SIP `REGISTER` succeeds.
6. Backend updates only presence in MySQL.
7. **Call Family** sends SIP `INVITE`.
8. The other account receives the INVITE.
9. Accept establishes WebRTC media.
10. Ending the call sends SIP `BYE`.

There is no Family Joining Code.

## Run

```bash
npm install
npm start
```

For Internet calling, deploy over public HTTPS so SIP uses WSS and WebRTC has a secure browser context.

## TURN

Configure:

- `CLOUDFLARE_TURN_KEY_ID`
- `CLOUDFLARE_TURN_API_TOKEN`

Without TURN, HomeConnect falls back to STUN and some mobile/ISP networks may not establish media.

## Privacy boundary

**MySQL is connection state only. HomeConnect does not record calls or store call/media content.**
