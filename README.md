# HomeConnect

A private, mobile-first family website with a social-media-style interface.

## Static-only architecture

HomeConnect is intentionally **website only**.

- No APK build.
- No Firebase.
- No Firestore.
- No Node.js server.
- No API.
- No application backend.
- No database.
- No cloud media storage.
- No call recording.
- Responsive on Android, iPhone and desktop.
- Local notes, theme and UI state use browser localStorage.

## Important calling limitation

A real cross-device Internet audio/video call cannot work with literally no signaling/rendezvous service. WebRTC needs a way for the two devices to discover and exchange connection information.

Because this version is explicitly **backend-free**, the Call area is a local camera/microphone preview only. It does not pretend that a remote call is working when there is no signaling infrastructure.

## Run locally

Open index.html in a browser.

For camera/microphone access, use an HTTPS static host or localhost.

## Deploy as a static website

The repository contains only static web assets:

- index.html
- style.css
- app.js
- config.js
- manifest.webmanifest
- sw.js
- icon.svg

It can be hosted on GitHub Pages or another static HTTPS host.

## Password gate

The two access passwords are checked locally in the browser. This is only a UI access gate, not server-side authentication. Anyone who can inspect the website source can ultimately recover or bypass a client-side password.

For real security, server-side authentication would be required, which is deliberately outside this static-only version.
