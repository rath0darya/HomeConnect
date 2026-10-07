# HomeConnect

Private family audio/video calling app with a social-media-style responsive interface.

## Architecture

- No Firebase.
- No Firestore.
- No application database.
- No call recording.
- No media storage.
- Audio/video uses WebRTC peer-to-peer transport.
- The WebSocket service is only for authentication and WebRTC signaling.
- WebRTC media is encrypted by the browser using DTLS-SRTP.

A signaling endpoint is technically required for Internet WebRTC rendezvous. There is no way to establish an arbitrary Internet-to-Internet WebRTC session with literally zero rendezvous/signaling infrastructure.

## Passwords

Default credentials are:

- Admin: `RuhiSinghRajput`
- Family: `Praveen@8897`

For deployment, override them with environment variables:

```text
HOMECONNECT_ADMIN_PASSWORD=...
HOMECONNECT_FAMILY_PASSWORD=...
```

## Web

```bash
npm install
npm start
```

Open:

```text
http://127.0.0.1:8080
```

For Internet camera/microphone access, publish the site through HTTPS and expose the WebSocket endpoint as WSS.

## Android

The `android/` directory is an Android WebView shell using AndroidX WebKit's secure asset loader. The same responsive HomeConnect interface is packaged into the APK.

The APK build is automated by GitHub Actions and is copied into:

```text
download/HomeConnect.apk
```

The APK needs a secure WSS signaling endpoint in `config.js` for Internet calling. Leaving `signalingUrl` empty only works when the web app itself is served by the HomeConnect server.

## Important limitation

A completely backend-free Internet video-call system is not technically possible because peers need a rendezvous/signaling mechanism. HomeConnect deliberately keeps this mechanism minimal: it does not carry or store the audio/video media.
