window.HOMECONNECT_CONFIG = Object.freeze({
  mode: "sip-webrtc",
  backend: true,
  signalingPath: "/sip",
  sipTransport: "SIP over WebSocket",
  sipLibrary: "SIP.js 0.21.2",
  turnEndpoint: "/api/turn",
  database: false,
  firebase: false
});