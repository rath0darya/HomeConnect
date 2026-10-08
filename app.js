(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PASSWORD_HASHES = Object.freeze({
    admin: "327179bea9bc971a7b5c6e3dd92bc6da5b63de0250b99f78ab36f263e272dc2b",
    family: "cbab50a3f910d110a23b011410f55d7bd66a529388ddeeab1b6e1cf6edefeeb0"
  });

  const loginView = $("loginView"), homeView = $("homeView"), loginForm = $("loginForm");
  const passwordInput = $("password"), showPassword = $("showPassword"), loginError = $("loginError");
  const myAvatar = $("myAvatar"), myName = $("myName"), myRole = $("myRole");
  const startCallButton = $("startCallButton"), endCallButton = $("endCallButton");
  const micButton = $("micButton"), cameraButton = $("cameraButton");
  const localVideo = $("localVideo"), remoteVideo = $("remoteVideo");
  const remotePlaceholder = $("remotePlaceholder"), callStatus = $("callStatus");
  const appStatus = $("appStatus"), toast = $("toast"), connectionLabel = $("connectionLabel");
  const peerBadge = $("peerBadge"), qualityBadge = $("qualityBadge");

  let role = null, accessToken = null, socket = null, stream = null, pc = null;
  let remoteStream = null, toastTimer = null, callStarted = false, peerOnline = false;
  let pendingCandidates = [], heartbeatTimer = null, incomingCall = false, calling = false;

  async function sha256(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function toastMessage(message) {
    toast.textContent = message; toast.classList.remove("hidden");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
  }
  function setStatus(message) { appStatus.textContent = message; }
  function showHome() { loginView.classList.add("hidden"); homeView.classList.remove("hidden"); window.scrollTo({top:0,behavior:"instant"}); }
  function showLogin() { homeView.classList.add("hidden"); loginView.classList.remove("hidden"); }
  function setMember() {
    if (role === "admin") { myAvatar.textContent = "Y"; myName.textContent = "You"; myRole.textContent = "Private admin"; }
    else { myAvatar.textContent = "F"; myName.textContent = "Family"; myRole.textContent = "Private family member"; }
  }
  function wsUrl() {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return scheme + "//" + location.host + (window.HOMECONNECT_CONFIG.signalingPath || "/signal");
  }

  async function getIceServers() {
    try {
      const response = await fetch(window.HOMECONNECT_CONFIG.turnEndpoint || "/api/turn", {
        headers: { Authorization: "Bearer " + accessToken },
        cache: "no-store"
      });
      if (!response.ok) throw new Error("TURN endpoint returned " + response.status);
      const data = await response.json();
      return data.iceServers?.length ? data.iceServers : [{ urls: ["stun:stun.cloudflare.com:3478"] }];
    } catch (error) {
      console.warn("TURN unavailable:", error);
      qualityBadge.textContent = "STUN";
      return [{ urls: ["stun:stun.cloudflare.com:3478"] }];
    }
  }

  function connectSignaling() {
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    connectionLabel.textContent = "Connecting";
    setStatus("Connecting to the HomeConnect Internet service…");
    const url = wsUrl() + "?token=" + encodeURIComponent(accessToken) + "&role=" + encodeURIComponent(role);
    socket = new WebSocket(url);

    socket.onopen = () => {
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => sendSignal({ type: "ping" }), 20000);
      connectionLabel.textContent = "Online";
      setStatus("Internet signaling connected. Waiting for the other family member.");
      toastMessage("HomeConnect is online");
    };
    socket.onmessage = async (event) => {
      try { await handleSignal(JSON.parse(event.data)); } catch (error) { console.error(error); setStatus("Call negotiation error."); }
    };
    socket.onerror = () => {
      connectionLabel.textContent = "Offline";
      setStatus("Internet signaling is unavailable. Open the deployed HomeConnect web service.");
    };
    socket.onclose = () => {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      connectionLabel.textContent = "Offline";
      if (!homeView.classList.contains("hidden")) setStatus("Internet signaling disconnected. Reconnecting…");
      setTimeout(() => { if (accessToken && !homeView.classList.contains("hidden")) connectSignaling(); }, 1800);
    };
  }

  function sendSignal(message) {
    console.log("[HomeConnect]", new Date().toISOString(), message.type, message);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      toastMessage("HomeConnect is not connected to the Internet service.");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  async function ensureMedia() {
    if (stream) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Camera and microphone require HTTPS.");
      toastMessage("Media access requires HTTPS.");
      return false;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
        video: false
      });
      localVideo.srcObject = stream;
      micButton.disabled = false; cameraButton.disabled = false;
      micButton.classList.add("active"); cameraButton.classList.remove("active");
      return true;
    } catch (error) {
      setStatus(error?.message || "Camera or microphone permission was denied.");
      toastMessage("Camera/microphone permission is required.");
      return false;
    }
  }

  async function createPeerConnection() {
    if (pc) return pc;
    const iceServers = await getIceServers();
    pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
    remoteStream = new MediaStream();
    remoteVideo.srcObject = remoteStream;

    stream?.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        if (!remoteStream.getTracks().some((existing) => existing.id === track.id)) remoteStream.addTrack(track);
      });
      remotePlaceholder.classList.add("hidden");
      remoteVideo.play().catch(() => {});
      qualityBadge.textContent = "CONNECTED";
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ type:"ice-candidate", candidate:event.candidate.toJSON() });
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc?.iceConnectionState;
      if (state === "checking") { callStatus.textContent = "Connecting over the Internet…"; qualityBadge.textContent = "CONNECTING"; }
      if (state === "connected" || state === "completed") { callStatus.textContent = "Internet call connected"; qualityBadge.textContent = "CONNECTED"; setStatus("Call connected. Audio/video are live."); }
      if (state === "disconnected") setStatus("Internet connection interrupted. Trying to recover…");
      if (state === "failed") setStatus("Direct connection failed. TURN may be required for this network.");
      if (state === "closed") qualityBadge.textContent = "WEBRTC";
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === "failed") setStatus("WebRTC connection failed. Check Internet/TURN configuration.");
    };

    for (const candidate of pendingCandidates.splice(0)) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
    return pc;
  }

  async function startCall() {
    if (!peerOnline) { toastMessage("The other family member is not online."); setStatus("Waiting for the other family member to open HomeConnect."); return; }
    if (calling || callStarted || incomingCall) return;
    calling = true;
    startCallButton.disabled = true; endCallButton.disabled = false;
    callStatus.textContent = "Ringing…";
    setStatus("Calling the other family member. Waiting for Accept…");
    sendSignal({ type:"start-call" });
  }

  async function beginOutgoingMediaCall() {
    calling = false;
    if (!(await ensureMedia())) { sendSignal({type:"cancel-call"}); return; }
    await createPeerConnection();
    callStarted = true;
    remotePlaceholder.classList.remove("hidden");
    callStatus.textContent = "Connecting…";
    setStatus("Call accepted. Connecting audio…");
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);
    sendSignal({ type:"offer", description: pc.localDescription });
  }

  async function acceptOffer(description) {
    incomingCall = false;
    if (!(await ensureMedia())) return;
    await createPeerConnection();
    callStarted = true;
    startCallButton.disabled = true; endCallButton.disabled = false;
    await pc.setRemoteDescription(description);
    for (const candidate of pendingCandidates.splice(0)) {
      try { await pc.addIceCandidate(candidate); } catch {}
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ type:"answer", description: pc.localDescription });
    remotePlaceholder.classList.remove("hidden");
    callStatus.textContent = "Joining the Internet call…";
    setStatus("Call accepted. Connecting audio/video…");
  }

  async function handleSignal(message) {
    if (message.type === "welcome") {
      peerOnline = message.peerCount > 1;
      peerBadge.textContent = peerOnline ? "Family online" : "Waiting for family";
      return;
    }
    if (message.type === "peer-state") {
      peerOnline = Number(message.peerCount) >= 2;
      peerBadge.textContent = peerOnline ? "Family online" : "Waiting for family";
      setStatus(peerOnline ? "Both family members are online. You can ring them." : "Waiting for the other family member to open HomeConnect.");
      return;
    }
    if (message.type === "peer-joined") {
      peerOnline = true; peerBadge.textContent = "Family online";
      setStatus("Both family members are online. You can ring them.");
      return;
    }
    if (message.type === "peer-left") {
      peerOnline = false; peerBadge.textContent = "Waiting for family";
      if (callStarted) endCall(false);
      setStatus("The other family member went offline.");
      return;
    }
    if (message.type === "incoming-call") {
      if (callStarted || incomingCall) return;
      incomingCall = true;
      callStatus.textContent = "Incoming call";
      setStatus("Incoming call. Accept or decline.");
      showIncomingCallDialog(message.fromRole);
      return;
    }
    if (message.type === "accept-call") {
      if (calling) await beginOutgoingMediaCall();
      return;
    }
    if (message.type === "decline-call") {
      calling = false;
      startCallButton.disabled = false; endCallButton.disabled = true;
      callStatus.textContent = "Call declined";
      setStatus("The other family member declined the call.");
      toastMessage("Call declined");
      return;
    }
    if (message.type === "cancel-call") {
      incomingCall = false;
      hideIncomingCallDialog();
      toastMessage("Call cancelled");
      setStatus("The incoming call was cancelled.");
      return;
    }
    if (message.type === "offer") {
      if (!incomingCall && !callStarted) return;
      await acceptOffer(message.description);
      return;
    }
    if (message.type === "answer") {
      if (!pc) return;
      await pc.setRemoteDescription(message.description);
      for (const candidate of pendingCandidates.splice(0)) {
        try { await pc.addIceCandidate(candidate); } catch {}
      }
      return;
    }
    if (message.type === "ice-candidate") {
      if (!pc || !pc.remoteDescription) pendingCandidates.push(message.candidate);
      else { try { await pc.addIceCandidate(message.candidate); } catch {} }
      return;
    }
    if (message.type === "hangup") {
      endCall(false);
      toastMessage("Call ended by the other family member.");
    }
  }

  async function endCall(notify = true) {
    if (notify) sendSignal({ type:"hangup" });
    callStarted = false;
    calling = false;
    incomingCall = false;
    hideIncomingCallDialog();
    pendingCandidates = [];
    if (pc) { pc.ontrack = null; pc.close(); pc = null; }
    remoteStream = null;
    remoteVideo.srcObject = null;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }
    localVideo.srcObject = null;
    remotePlaceholder.classList.remove("hidden");
    callStatus.textContent = peerOnline ? "Ready for another call" : "Waiting for family";
    startCallButton.disabled = false; endCallButton.disabled = true;
    micButton.disabled = true; cameraButton.disabled = true;
    micButton.classList.remove("active"); cameraButton.classList.remove("active");
    micButton.textContent = "Mic"; cameraButton.textContent = "Cam";
    qualityBadge.textContent = "WEBRTC";
    setStatus(peerOnline ? "Call ended. You can start another Internet call." : "Waiting for the other family member.");
  }

  function showIncomingCallDialog(fromRole) {
    const dialog = $("incomingCallDialog");
    if (!dialog) return;
    $("incomingCallText").textContent = (fromRole === "admin" ? "Admin" : "Family member") + " is calling you.";
    dialog.classList.remove("hidden");
  }

  function hideIncomingCallDialog() {
    $("incomingCallDialog")?.classList.add("hidden");
  }

  $("acceptCallButton")?.addEventListener("click", async () => {
    if (!incomingCall) return;
    hideIncomingCallDialog();
    sendSignal({ type:"accept-call" });
    await ensureMedia();
    await createPeerConnection();
    callStarted = true;
    startCallButton.disabled = true; endCallButton.disabled = false;
    callStatus.textContent = "Joining call…";
    setStatus("Call accepted. Waiting for audio connection…");
  });

  $("declineCallButton")?.addEventListener("click", () => {
    if (!incomingCall) return;
    incomingCall = false;
    hideIncomingCallDialog();
    sendSignal({ type:"decline-call" });
    callStatus.textContent = "Call declined";
    setStatus("You declined the incoming call.");
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const hash = await sha256(passwordInput.value);
    role = hash === PASSWORD_HASHES.admin ? "admin" : hash === PASSWORD_HASHES.family ? "family" : null;
    if (!role) { loginError.textContent = "Incorrect access password."; passwordInput.focus(); return; }
    loginError.textContent = ""; accessToken = hash; passwordInput.value = "";
    setMember(); showHome(); connectSignaling();
  });

  showPassword.addEventListener("click", () => {
    const visible = passwordInput.type === "text";
    passwordInput.type = visible ? "password" : "text";
    showPassword.setAttribute("aria-label", visible ? "Show password" : "Hide password");
  });

  startCallButton.addEventListener("click", startCall);
  endCallButton.addEventListener("click", () => endCall(true));
  micButton.addEventListener("click", () => {
    const track = stream?.getAudioTracks()[0]; if (!track) return;
    track.enabled = !track.enabled; micButton.classList.toggle("active", track.enabled);
    micButton.textContent = track.enabled ? "Mic" : "Muted";
  });
  cameraButton.addEventListener("click", async () => {
    if (!callStarted) { toastMessage("Start or join a call first."); return; }
    let track = stream?.getVideoTracks()[0];
    if (!track) {
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({
          video: { width:{ideal:1920,max:1920}, height:{ideal:1080,max:1080}, frameRate:{ideal:30,max:60}, facingMode:"user" }
        });
        track = videoStream.getVideoTracks()[0];
        stream.addTrack(track);
        localVideo.srcObject = stream;
        await createPeerConnection();
        pc.addTrack(track, stream);
        const offer = await pc.createOffer({offerToReceiveAudio:true, offerToReceiveVideo:true});
        await pc.setLocalDescription(offer);
        sendSignal({type:"offer", description:pc.localDescription});
        cameraButton.classList.add("active");
        cameraButton.textContent = "Cam";
      } catch (error) {
        toastMessage("Camera permission was denied.");
      }
      return;
    }
    track.enabled = !track.enabled;
    cameraButton.classList.toggle("active", track.enabled);
    cameraButton.textContent = track.enabled ? "Cam" : "Camera off";
  });

  function lockApp() {
    endCall(true);
    clearInterval(heartbeatTimer); heartbeatTimer = null;
    socket?.close(); socket = null; accessToken = null; role = null; peerOnline = false;
    showLogin(); loginError.textContent = ""; passwordInput.value = ""; toastMessage("HomeConnect locked");
  }
  $("logoutButton").addEventListener("click", lockApp);
  $("lockNavButton").addEventListener("click", lockApp);
  $("heroCallButton").addEventListener("click", () => $("callSection").scrollIntoView({behavior:"smooth",block:"center"}));

  document.querySelectorAll(".nav-item[data-target]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    if (button.dataset.target === "call") $("callSection").scrollIntoView({behavior:"smooth",block:"center"});
    else window.scrollTo({top:0,behavior:"smooth"});
  }));

  $("likeButton")?.addEventListener("click", (event) => {
    const button = event.currentTarget, liked = button.classList.toggle("active");
    button.firstChild.textContent = liked ? "♥ " : "♡ "; toastMessage(liked ? "Liked" : "Like removed");
  });
  $("commentButton")?.addEventListener("click", () => toastMessage("Comments are local UI only."));
  $("shareButton")?.addEventListener("click", async () => {
    try {
      if (navigator.share) await navigator.share({title:"HomeConnect",text:"Private family space",url:location.href});
      else if (navigator.clipboard) { await navigator.clipboard.writeText(location.href); toastMessage("Link copied"); }
    } catch {}
  });
  $("storyAdd")?.addEventListener("click", () => toastMessage("Stories are local UI only."));
  window.addEventListener("beforeunload", () => { if (socket) socket.close(); });
})();
