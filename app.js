(() => {
  "use strict";

  const CONFIG = window.HOMECONNECT_CONFIG || {};
  const DEFAULT_ICE = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: "stun:stun.cloudflare.com:3478" }
  ];

  const ICE_SERVERS = CONFIG.iceServers || DEFAULT_ICE;

  const $ = (id) => document.getElementById(id);

  const loginView = $("loginView");
  const homeView = $("homeView");
  const loginForm = $("loginForm");
  const passwordInput = $("password");
  const showPassword = $("showPassword");
  const loginError = $("loginError");
  const connectionPill = $("connectionPill");
  const myAvatar = $("myAvatar");
  const myName = $("myName");
  const myRole = $("myRole");
  const peerBadge = $("peerBadge");
  const remoteName = $("remoteName");
  const callTitle = $("callTitle");
  const callStatus = $("callStatus");
  const appStatus = $("appStatus");
  const remoteVideo = $("remoteVideo");
  const localVideo = $("localVideo");
  const remotePlaceholder = $("remotePlaceholder");
  const videoOverlay = $("videoOverlay");
  const overlayText = $("overlayText");
  const qualityBadge = $("qualityBadge");
  const startCallButton = $("startCallButton");
  const endCallButton = $("endCallButton");
  const micButton = $("micButton");
  const cameraButton = $("cameraButton");
  const speakerButton = $("speakerButton");
  const incomingModal = $("incomingModal");
  const incomingName = $("incomingName");
  const answerButton = $("answerButton");
  const declineButton = $("declineButton");
  const logoutButton = $("logoutButton");
  const lockNavButton = $("lockNavButton");
  const callNavButton = $("callNavButton");

  let socket = null;
  let password = "";
  let authenticated = false;
  let role = "";
  let displayName = "";
  let peerOnline = false;
  let sessionId = sessionStorage.getItem("homeconnect-session") || crypto.randomUUID();

  sessionStorage.setItem("homeconnect-session", sessionId);

  let pc = null;
  let localStream = null;
  let currentCallId = null;
  let callRole = null;
  let pendingOffer = null;
  let pendingCandidates = [];
  let incomingAccepted = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let shuttingDown = false;
  let statsTimer = null;

  const SIGNALING_URL = (() => {
    if (CONFIG.signalingUrl) return CONFIG.signalingUrl;

    if (location.protocol === "https:") {
      return `wss://${location.host}/ws`;
    }

    if (location.protocol === "http:") {
      return `ws://${location.host}/ws`;
    }

    return "";
  })();

  function setStatus(text) {
    appStatus.textContent = text;
  }

  function setConnection(online) {
    connectionPill.classList.toggle("online", online);
    connectionPill.classList.toggle("offline", !online);
    connectionPill.querySelector("span").textContent = online ? "Connected" : "Offline";
  }

  function setPeerOnline(online) {
    peerOnline = online;
    peerBadge.classList.toggle("online", online);
    peerBadge.classList.toggle("offline", !online);
    peerBadge.textContent = online ? "Family online" : "Family offline";
    updateButtons();
  }

  function updateButtons() {
    startCallButton.disabled = !authenticated || !peerOnline || Boolean(currentCallId);
    endCallButton.disabled = !currentCallId;

    const activeMedia = Boolean(localStream);
    micButton.disabled = !activeMedia;
    cameraButton.disabled = !activeMedia || !localStream?.getVideoTracks().length;
    speakerButton.disabled = !remoteVideo.srcObject;
  }

  function showHome() {
    loginView.classList.add("hidden");
    homeView.classList.remove("hidden");
  }

  function showLogin(message = "") {
    authenticated = false;
    loginView.classList.remove("hidden");
    homeView.classList.add("hidden");
    loginError.textContent = message;
    setConnection(false);
    passwordInput.focus();
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setStatus("Signaling connection unavailable.");
      return false;
    }

    socket.send(JSON.stringify(message));
    return true;
  }

  function connect() {
    if (!SIGNALING_URL) {
      loginError.textContent = "No signaling endpoint configured.";
      return;
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }

    setStatus("Connecting securely…");

    try {
      socket = new WebSocket(SIGNALING_URL);
    } catch {
      showLogin("Could not create the signaling connection.");
      return;
    }

    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      send({
        type: "join",
        password,
        sessionId
      });
    });

    socket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      await handleSignal(message);
    });

    socket.addEventListener("close", () => {
      setConnection(false);

      if (shuttingDown) return;

      if (!authenticated) {
        showLogin("Unable to connect to HomeConnect.");
        return;
      }

      setStatus("Connection lost. Reconnecting…");
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (!authenticated) {
        loginError.textContent = "Unable to reach the HomeConnect signaling service.";
      }
    });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);

    const delay = Math.min(1000 * Math.pow(1.7, reconnectAttempts++), 12000);

    reconnectTimer = setTimeout(() => {
      if (!shuttingDown && password) connect();
    }, delay);
  }

  async function handleSignal(message) {
    switch (message.type) {
      case "authenticated":
        authenticated = true;
        role = message.role;
        displayName = message.name;
        myName.textContent = displayName;
        myRole.textContent = role === "admin" ? "HomeConnect owner" : "Family member";
        myAvatar.textContent = displayName.charAt(0).toUpperCase();
        setConnection(true);
        setPeerOnline(Boolean(message.peerOnline));
        setStatus(peerOnline ? "Ready to call." : "Waiting for your family member.");
        showHome();
        break;

      case "auth-failed":
        password = "";
        socket?.close();
        showLogin(message.message || "Incorrect password.");
        break;

      case "role-in-use":
        password = "";
        socket?.close();
        showLogin("This family account is already active on another device.");
        break;

      case "peer-online":
        setPeerOnline(true);
        if (!currentCallId) setStatus("Family member is online.");
        break;

      case "peer-offline":
        setPeerOnline(false);
        if (!currentCallId) setStatus("Family member is offline.");
        break;

      case "incoming-call":
        await handleIncomingCall(message);
        break;

      case "call-accepted":
        if (message.callId === currentCallId) {
          callTitle.textContent = "Call connected";
          callStatus.textContent = "Live";
          videoOverlay.classList.add("hidden");
          setStatus("Connected.");
        }
        break;

      case "call-declined":
        if (message.callId === currentCallId) {
          setStatus("Call declined.");
          cleanupCall();
        }
        break;

      case "call-busy":
        if (!currentCallId || message.callId === currentCallId) {
          setStatus("Family member is already on another call.");
          cleanupCall();
        }
        break;

      case "offer":
        await handleOffer(message);
        break;

      case "answer":
        await handleAnswer(message);
        break;

      case "ice-candidate":
        await handleIceCandidate(message);
        break;

      case "ice-restart-request":
        if (callRole === "caller" && message.callId === currentCallId) {
          await makeOffer(true);
        }
        break;

      case "call-ended":
        if (!currentCallId || message.callId === currentCallId) {
          cleanupCall();
          setStatus("Call ended.");
        }
        break;

      case "pong":
        break;

      case "server-error":
        setStatus(message.message || "Signaling error.");
        break;
    }
  }

  async function prepareMedia() {
    if (localStream) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera and microphone are not available in this browser.");
    }

    const highQuality = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 2,
        sampleRate: 48000
      },
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 60, max: 60 },
        facingMode: "user"
      }
    };

    try {
      localStream = await navigator.mediaDevices.getUserMedia(highQuality);
    } catch {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
    }

    localVideo.srcObject = localStream;
    localVideo.classList.remove("hidden");

    localStream.getVideoTracks().forEach((track) => {
      track.contentHint = "motion";
    });

    updateButtons();
  }

  async function createPeer() {
    if (pc) return pc;

    pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && currentCallId) {
        send({
          type: "ice-candidate",
          callId: currentCallId,
          candidate: event.candidate
        });
      }
    };

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        remotePlaceholder.classList.add("hidden");
        updateButtons();
        remoteVideo.play().catch(() => {});
      }
    };

    pc.onconnectionstatechange = async () => {
      const state = pc?.connectionState;

      if (state === "connected") {
        callTitle.textContent = "Call connected";
        callStatus.textContent = "Live";
        videoOverlay.classList.add("hidden");
        setStatus("Connected with encrypted WebRTC media.");
        qualityBadge.textContent = "HD";
        startStats();
      } else if (state === "connecting") {
        overlayText.textContent = "Connecting…";
        videoOverlay.classList.remove("hidden");
      } else if (state === "disconnected") {
        overlayText.textContent = "Network reconnecting…";
        videoOverlay.classList.remove("hidden");
        setStatus("Network reconnecting…");
      } else if (state === "failed") {
        setStatus("Direct connection failed. Trying ICE recovery…");
        send({
          type: "ice-restart-request",
          callId: currentCallId
        });
      } else if (state === "closed") {
        cleanupCall();
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc?.iceConnectionState === "failed") {
        send({
          type: "ice-restart-request",
          callId: currentCallId
        });
      }
    };

    for (const track of localStream?.getTracks() || []) {
      const sender = pc.addTrack(track, localStream);
      tuneSender(sender);
    }

    return pc;
  }

  async function tuneSender(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;

      if (sender.track?.kind === "video") {
        params.encodings[0].maxBitrate = 8000000;
        params.encodings[0].maxFramerate = 60;
      } else if (sender.track?.kind === "audio") {
        params.encodings[0].maxBitrate = 192000;
      }

      await sender.setParameters(params);
    } catch {
      // Browser may reject optional tuning; normal WebRTC remains active.
    }
  }

  async function makeOffer(iceRestart = false) {
    if (!pc) return;

    const offer = await pc.createOffer(
      iceRestart ? { iceRestart: true } : undefined
    );

    await pc.setLocalDescription(offer);

    send({
      type: "offer",
      callId: currentCallId,
      description: pc.localDescription,
      restart: iceRestart
    });
  }

  async function startCall() {
    if (!peerOnline || currentCallId) return;

    try {
      await prepareMedia();

      currentCallId = crypto.randomUUID();
      callRole = "caller";
      pendingOffer = null;
      pendingCandidates = [];

      await createPeer();

      send({
        type: "call-invite",
        callId: currentCallId
      });

      callTitle.textContent = "Calling family…";
      callStatus.textContent = "Ringing";
      overlayText.textContent = "Calling…";
      videoOverlay.classList.remove("hidden");
      setStatus("Calling…");
      updateButtons();

      await makeOffer(false);
    } catch (error) {
      cleanupCall();
      setStatus(error.message || "Could not start the call.");
    }
  }

  async function handleIncomingCall(message) {
    if (currentCallId) {
      send({
        type: "call-busy",
        callId: message.callId
      });
      return;
    }

    currentCallId = message.callId;
    callRole = "callee";
    incomingAccepted = false;
    pendingOffer = null;
    pendingCandidates = [];

    incomingName.textContent = message.callerName || "Family";
    remoteName.textContent = message.callerName || "Family";
    incomingModal.classList.remove("hidden");
    callTitle.textContent = "Incoming call";
    callStatus.textContent = "Waiting for answer";
    setStatus("Incoming family call.");
    updateButtons();
  }

  async function answerCall() {
    if (!currentCallId || callRole !== "callee") return;

    incomingModal.classList.add("hidden");

    try {
      await prepareMedia();
      await createPeer();

      incomingAccepted = true;

      send({
        type: "call-accepted",
        callId: currentCallId
      });

      if (pendingOffer) {
        await pc.setRemoteDescription(pendingOffer);
        await flushCandidates();

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        send({
          type: "answer",
          callId: currentCallId,
          description: pc.localDescription
        });

        pendingOffer = null;
      }

      callTitle.textContent = "Connecting…";
      callStatus.textContent = "Joining call";
      overlayText.textContent = "Connecting…";
      videoOverlay.classList.remove("hidden");
      setStatus("Joining call.");
      updateButtons();
    } catch (error) {
      send({
        type: "call-ended",
        callId: currentCallId
      });

      cleanupCall();
      setStatus(error.message || "Could not answer the call.");
    }
  }

  function declineCall() {
    if (currentCallId) {
      send({
        type: "call-declined",
        callId: currentCallId
      });
    }

    incomingModal.classList.add("hidden");
    cleanupCall();
    setStatus("Call declined.");
  }

  async function handleOffer(message) {
    if (message.callId !== currentCallId) return;

    if (callRole === "callee" && !incomingAccepted) {
      pendingOffer = message.description;
      return;
    }

    if (!pc) {
      await prepareMedia();
      await createPeer();
    }

    await pc.setRemoteDescription(message.description);
    await flushCandidates();

    if (callRole === "callee") {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      send({
        type: "answer",
        callId: currentCallId,
        description: pc.localDescription
      });
    }
  }

  async function handleAnswer(message) {
    if (!pc || message.callId !== currentCallId) return;

    await pc.setRemoteDescription(message.description);
    await flushCandidates();
  }

  async function handleIceCandidate(message) {
    if (message.callId !== currentCallId || !message.candidate) return;

    if (!pc || !pc.remoteDescription) {
      pendingCandidates.push(message.candidate);
      return;
    }

    try {
      await pc.addIceCandidate(message.candidate);
    } catch {}
  }

  async function flushCandidates() {
    if (!pc?.remoteDescription) return;

    const candidates = pendingCandidates.splice(0);

    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {}
    }
  }

  function startStats() {
    clearInterval(statsTimer);

    statsTimer = setInterval(async () => {
      if (!pc) return;

      try {
        const stats = await pc.getStats();
        let packetsLost = 0;
        let packetsReceived = 0;

        stats.forEach((report) => {
          if (report.type === "inbound-rtp" && report.kind === "video") {
            packetsLost += report.packetsLost || 0;
            packetsReceived += report.packetsReceived || 0;
          }
        });

        const total = packetsLost + packetsReceived;

        if (total > 0 && packetsLost / total < 0.02) {
          qualityBadge.textContent = "HD+";
        } else if (total > 0) {
          qualityBadge.textContent = "Adaptive";
        }
      } catch {}
    }, 5000);
  }

  function stopTracks() {
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    localVideo.srcObject = null;
  }

  function cleanupCall() {
    clearInterval(statsTimer);
    statsTimer = null;

    if (pc) {
      try {
        pc.close();
      } catch {}
    }

    pc = null;
    stopTracks();

    currentCallId = null;
    callRole = null;
    pendingOffer = null;
    pendingCandidates = [];
    incomingAccepted = false;

    incomingModal.classList.add("hidden");
    remoteVideo.srcObject = null;
    remotePlaceholder.classList.remove("hidden");
    videoOverlay.classList.add("hidden");

    callTitle.textContent = "Ready when you are";
    callStatus.textContent = peerOnline ? "Family member is online" : "Waiting for family member";
    qualityBadge.textContent = "HD";

    micButton.classList.remove("active");
    cameraButton.classList.remove("active");
    speakerButton.classList.remove("active");

    updateButtons();
  }

  function endCall() {
    if (currentCallId) {
      send({
        type: "call-ended",
        callId: currentCallId
      });
    }

    cleanupCall();
    setStatus("Call ended.");
  }

  function toggleMic() {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    micButton.classList.toggle("active", track.enabled);
    micButton.textContent = track.enabled ? "Mic" : "Muted";
  }

  function toggleCamera() {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;

    track.enabled = !track.enabled;
    cameraButton.classList.toggle("active", track.enabled);
    cameraButton.textContent = track.enabled ? "Cam" : "Camera off";
  }

  function toggleSpeaker() {
    if (!("setSinkId" in HTMLMediaElement.prototype)) {
      setStatus("Speaker routing is controlled by the device.");
      return;
    }

    remoteVideo.setSinkId("default").then(() => {
      speakerButton.classList.toggle("active");
    }).catch(() => {});
  }

  function logout() {
    shuttingDown = true;

    if (currentCallId) {
      send({
        type: "call-ended",
        callId: currentCallId
      });
    }

    send({ type: "logout" });

    cleanupCall();
    password = "";
    sessionStorage.removeItem("homeconnect-session");

    try {
      socket?.close();
    } catch {}

    socket = null;
    authenticated = false;
    role = "";
    displayName = "";
    sessionId = crypto.randomUUID();
    sessionStorage.setItem("homeconnect-session", sessionId);

    shuttingDown = false;
    passwordInput.value = "";
    loginError.textContent = "";
    showLogin();
  }

  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const value = passwordInput.value.trim();

    if (!value) {
      loginError.textContent = "Enter your access password.";
      return;
    }

    password = value;
    loginError.textContent = "";
    connect();
  });

  showPassword.addEventListener("click", () => {
    passwordInput.type = passwordInput.type === "password" ? "text" : "password";
  });

  startCallButton.addEventListener("click", startCall);
  endCallButton.addEventListener("click", endCall);
  answerButton.addEventListener("click", answerCall);
  declineButton.addEventListener("click", declineCall);
  micButton.addEventListener("click", toggleMic);
  cameraButton.addEventListener("click", toggleCamera);
  speakerButton.addEventListener("click", toggleSpeaker);
  logoutButton.addEventListener("click", logout);
  lockNavButton.addEventListener("click", logout);
  callNavButton.addEventListener("click", () => {
    document.querySelector(".call-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  window.addEventListener("beforeunload", () => {
    try {
      socket?.close();
    } catch {}
  });

  setConnection(false);
  setPeerOnline(false);
})();
