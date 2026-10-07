window.HOMECONNECT_CONFIG = {
  /*
   * Leave empty when the web app is served by server.js.
   * It will automatically use the same-origin /ws endpoint.
   *
   * For the Android APK or a separately hosted frontend, set this to
   * your secure WebSocket endpoint, for example:
   *
   * signalingUrl: "wss://your-domain.example/ws"
   */
  signalingUrl: "",

  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: "stun:stun.cloudflare.com:3478" }
  ]
};
