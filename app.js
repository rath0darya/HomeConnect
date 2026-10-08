import {
  Invitation,
  Inviter,
  Registerer,
  SessionState,
  UserAgent
} from "https://cdn.jsdelivr.net/npm/sip.js@0.21.2/lib/index.js";

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

  let role = null;
  let accessToken = null;
  let userAgent = null;
  let registerer = null;
  let session = null;
  let incomingInvitation = null;
  let toastTimer = null;
  let registered = false;
  let callStarted = false;
  let calling = false;
  let cameraEnabled = false;

  async function sha256(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function toastMessage(message) {
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
  }

  function setStatus(message) {
    appStatus.textContent = message;
  }

  function showHome() {
    loginView.classList.add("hidden");
    homeView.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function showLogin() {
    homeView.classList.add("hidden");
    loginView.classList.remove("hidden");
  }

  function setMember() {
    if (role === "admin") {
      myAvatar.textContent = "Y";
      myName.textContent = "You";
      myRole.textContent = "SIP admin · sip:admin";
    } else {
      myAvatar.textContent = "F";
      myName.textContent = "Family";
      myRole.textContent = "SIP family · sip:family";
    }
  }

  function sipDomain() {
    return location.host;
  }

  function sipWebSocketUrl() {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return scheme + "//" + location.host + "/sip";
  }

  function targetUri() {
    return "sip:" + (role === "admin" ? "family" : "admin") + "@" + sipDomain();
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

  function attachSessionMedia(currentSession) {
    const sdh = currentSession?.sessionDescriptionHandler;
    if (!sdh) return;

    if (sdh.localMediaStream) {
      localVideo.srcObject = sdh.localMediaStream;
      localVideo.play().catch(() => {});
    }
    if (sdh.remoteMediaStream) {
      remoteVideo.srcObject = sdh.remoteMediaStream;
      remoteVideo.play().catch(() => {});
      remotePlaceholder.classList.add("hidden");
    }

    if (sdh.remoteMediaStream) {
      sdh.remoteMediaStream.onaddtrack = () => {
        remoteVideo.srcObject = sdh.remoteMediaStream;
        remoteVideo.play().catch(() => {});
        remotePlaceholder.classList.add("hidden");
      };
    }
  }

  function watchSession(currentSession, direction) {
    session = currentSession;
    callStarted = false;
    calling = direction === "outgoing";

    currentSession.stateChange.addListener((state) => {
      if (state === SessionState.Establishing) {
        callStatus.textContent = direction === "outgoing" ? "Ringing…" : "Connecting…";
        qualityBadge.textContent = "CONNECTING";
        setStatus("SIP call is negotiating WebRTC media…");
        attachSessionMedia(currentSession);
      }

      if (state === SessionState.Established) {
        callStarted = true;
        calling = false;
        incomingInvitation = null;
        startCallButton.disabled = true;
        endCallButton.disabled = false;
        micButton.disabled = false;
        cameraButton.disabled = false;
        micButton.classList.add("active");
        cameraButton.classList.remove("active");
        cameraEnabled = Boolean(currentSession.sessionDescriptionHandler?.localMediaStream?.getVideoTracks().length);
        attachSessionMedia(currentSession);
        callStatus.textContent = cameraEnabled ? "Video call connected" : "Audio call connected";
        qualityBadge.textContent = "CONNECTED";
        remotePlaceholder.classList.toggle("hidden", Boolean(remoteVideo.srcObject));
        setStatus("SIP session established. WebRTC media is live.");
      }

      if (state === SessionState.Terminated) {
        cleanupCall(false);
      }
    });

    currentSession.delegate = {
      onSessionDescriptionHandler(sdh) {
        if (sdh.remoteMediaStream) {
          sdh.remoteMediaStream.onaddtrack = () => attachSessionMedia(currentSession);
        }
        attachSessionMedia(currentSession);
      }
    };
  }

  async function connectSip() {
    if (userAgent) return;

    connectionLabel.textContent = "Connecting";
    setStatus("Connecting to the HomeConnect SIP service…");

    const iceServers = await getIceServers();
    const uri = UserAgent.makeURI("sip:" + role + "@" + sipDomain());
    if (!uri) throw new Error("Could not create SIP identity.");

    userAgent = new UserAgent({
      uri,
      authorizationUsername: role,
      authorizationPassword: accessToken,
      transportOptions: { server: sipWebSocketUrl() },
      sessionDescriptionHandlerFactoryOptions: {
        peerConnectionConfiguration: {
          iceServers,
          iceCandidatePoolSize: 4
        }
      },
      logLevel: "warn",
      delegate: {
        onInvite(invitation) {
          if (callStarted || incomingInvitation) {
            invitation.reject().catch(() => {});
            return;
          }
          incomingInvitation = invitation;
          watchSession(invitation, "incoming");
          callStatus.textContent = "Incoming SIP call";
          setStatus("Incoming SIP INVITE received. Accept or decline.");
          showIncomingCallDialog(invitation);
        },
        onConnect() {
          connectionLabel.textContent = "SIP Online";
          setStatus("SIP transport connected. Registering your HomeConnect identity…");
          registerer?.register().catch(handleSipError);
        },
        onDisconnect(error) {
          registered = false;
          connectionLabel.textContent = "Offline";
          peerBadge.textContent = "SIP offline";
          if (!homeView.classList.contains("hidden")) {
            setStatus(error ? "SIP connection lost. Reconnecting…" : "SIP disconnected.");
          }
        }
      }
    });

    registerer = new Registerer(userAgent, { expires: 600 });
    await userAgent.start();
    await registerer.register();
    registered = true;
    connectionLabel.textContent = "SIP Online";
    peerBadge.textContent = "Family account ready";
    setStatus("Registered as sip:" + role + "@" + sipDomain() + ". Ready to call.");
    toastMessage("SIP account registered");
  }

  function handleSipError(error) {
    console.error("[HomeConnect SIP]", error);
    setStatus(error?.message || "SIP operation failed.");
    toastMessage("SIP operation failed");
  }

  async function startCall() {
    if (!registered || !userAgent) {
      toastMessage("SIP account is not registered yet.");
      return;
    }
    if (session || calling) return;

    calling = true;
    startCallButton.disabled = true;
    endCallButton.disabled = false;
    callStatus.textContent = "Calling…";
    setStatus("Sending SIP INVITE to the other HomeConnect account…");

    try {
      const target = UserAgent.makeURI(targetUri());
      if (!target) throw new Error("Invalid SIP destination.");
      const inviter = new Inviter(userAgent, target, {
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false }
        }
      });
      watchSession(inviter, "outgoing");
      await inviter.invite();
    } catch (error) {
      calling = false;
      session = null;
      startCallButton.disabled = false;
      endCallButton.disabled = true;
      callStatus.textContent = "Call failed";
      handleSipError(error);
    }
  }

  async function acceptIncoming() {
    if (!incomingInvitation) return;
    const invitation = incomingInvitation;
    incomingInvitation = null;
    hideIncomingCallDialog();
    try {
      await invitation.accept({
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false }
        }
      });
      setStatus("SIP INVITE accepted. Connecting WebRTC audio…");
    } catch (error) {
      handleSipError(error);
      cleanupCall(false);
    }
  }

  async function declineIncoming() {
    if (!incomingInvitation) return;
    const invitation = incomingInvitation;
    incomingInvitation = null;
    hideIncomingCallDialog();
    try {
      await invitation.reject();
    } catch {}
    callStatus.textContent = "Call declined";
    setStatus("Incoming SIP call declined.");
    session = null;
    calling = false;
    startCallButton.disabled = false;
    endCallButton.disabled = true;
  }

  async function enableCamera() {
    if (!session || !callStarted) {
      toastMessage("Start a call first.");
      return;
    }
    const sdh = session.sessionDescriptionHandler;
    if (!sdh?.peerConnection) {
      toastMessage("WebRTC is not ready yet.");
      return;
    }

    if (!cameraEnabled) {
      try {
        setStatus("Requesting camera permission…");
        const videoStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: "user"
          }
        });
        const videoTrack = videoStream.getVideoTracks()[0];
        const sender = sdh.peerConnection.getSenders().find((item) => item.track?.kind === "video");
        if (sender) {
          await sender.replaceTrack(videoTrack);
        } else {
          sdh.peerConnection.addTrack(videoTrack, videoStream);
        }
        localVideo.srcObject = sdh.localMediaStream || videoStream;
        localVideo.play().catch(() => {});
        session.sessionDescriptionHandlerOptionsReInvite = {
          constraints: { audio: true, video: true }
        };
        await session.invite();
        cameraEnabled = true;
        cameraButton.classList.add("active");
        cameraButton.textContent = "Cam";
        setStatus("Camera enabled. SIP re-INVITE is negotiating video.");
      } catch (error) {
        console.error(error);
        toastMessage("Camera permission was denied.");
        setStatus("Camera permission is required for video.");
      }
      return;
    }

    const videoTrack = sdh.peerConnection.getSenders().find((item) => item.track?.kind === "video")?.track;
    if (videoTrack) {
      videoTrack.enabled = false;
      cameraEnabled = false;
      cameraButton.classList.remove("active");
      cameraButton.textContent = "Camera off";
      setStatus("Camera is off. Audio remains connected.");
    }
  }

  function toggleMic() {
    if (!session?.sessionDescriptionHandler?.peerConnection) return;
    const track = session.sessionDescriptionHandler.peerConnection.getSenders()
      .find((item) => item.track?.kind === "audio")?.track;
    if (!track) return;
    track.enabled = !track.enabled;
    micButton.classList.toggle("active", track.enabled);
    micButton.textContent = track.enabled ? "Mic" : "Muted";
  }

  async function cleanupCall(notify = true) {
    hideIncomingCallDialog();
    const current = session;
    session = null;
    incomingInvitation = null;
    callStarted = false;
    calling = false;
    cameraEnabled = false;

    if (notify && current) {
      try { await current.bye(); } catch {
        try { await current.cancel(); } catch {}
      }
    }

    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    remotePlaceholder.classList.remove("hidden");
    startCallButton.disabled = false;
    endCallButton.disabled = true;
    micButton.disabled = true;
    cameraButton.disabled = true;
    micButton.classList.remove("active");
    cameraButton.classList.remove("active");
    micButton.textContent = "Mic";
    cameraButton.textContent = "Cam";
    qualityBadge.textContent = "SIP/WEBRTC";
    callStatus.textContent = registered ? "Ready for another SIP call" : "SIP offline";
    setStatus(registered ? "SIP account is ready. You can call the other family account." : "SIP account is offline.");
  }

  function showIncomingCallDialog(invitation) {
    const dialog = $("incomingCallDialog");
    if (!dialog) return;
    const from = invitation?.remoteIdentity?.displayName || invitation?.remoteIdentity?.uri?.user || "Family";
    $("incomingCallText").textContent = from + " is calling your SIP account.";
    dialog.classList.remove("hidden");
  }

  function hideIncomingCallDialog() {
    $("incomingCallDialog")?.classList.add("hidden");
  }

  $("acceptCallButton")?.addEventListener("click", acceptIncoming);
  $("declineCallButton")?.addEventListener("click", declineIncoming);

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const hash = await sha256(passwordInput.value);
    role = hash === PASSWORD_HASHES.admin ? "admin" : hash === PASSWORD_HASHES.family ? "family" : null;
    if (!role) {
      loginError.textContent = "Incorrect access password.";
      passwordInput.focus();
      return;
    }

    loginError.textContent = "";
    accessToken = hash;
    passwordInput.value = "";

    setMember();
    showHome();

    try {
      await connectSip();
    } catch (error) {
      console.error(error);
      loginError.textContent = "SIP service could not be reached.";
      toastMessage("Could not connect to SIP");
      setStatus(error?.message || "SIP service unavailable.");
    }
  });

  showPassword.addEventListener("click", () => {
    const visible = passwordInput.type === "text";
    passwordInput.type = visible ? "password" : "text";
    showPassword.setAttribute("aria-label", visible ? "Show password" : "Hide password");
  });

  startCallButton.addEventListener("click", startCall);
  endCallButton.addEventListener("click", () => cleanupCall(true));
  micButton.addEventListener("click", toggleMic);
  cameraButton.addEventListener("click", enableCamera);

  function lockApp() {
    cleanupCall(true).catch(() => {});
    registerer?.unregister().catch(() => {});
    userAgent?.stop().catch(() => {});
    userAgent = null;
    registerer = null;
    session = null;
    incomingInvitation = null;
    registered = false;
    accessToken = null;
    role = null;
    showLogin();
    loginError.textContent = "";
    passwordInput.value = "";
    toastMessage("HomeConnect locked");
  }

  $("logoutButton").addEventListener("click", lockApp);
  $("lockNavButton").addEventListener("click", lockApp);
  $("heroCallButton").addEventListener("click", () => $("callSection").scrollIntoView({ behavior:"smooth", block:"center" }));

  document.querySelectorAll(".nav-item[data-target]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    if (button.dataset.target === "call") $("callSection").scrollIntoView({ behavior:"smooth", block:"center" });
    else window.scrollTo({ top:0, behavior:"smooth" });
  }));

  $("likeButton")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const liked = button.classList.toggle("active");
    button.firstChild.textContent = liked ? "♥ " : "♡ ";
    toastMessage(liked ? "Liked" : "Like removed");
  });
  $("commentButton")?.addEventListener("click", () => toastMessage("Comments are local UI only."));
  $("shareButton")?.addEventListener("click", async () => {
    try {
      if (navigator.share) await navigator.share({ title:"HomeConnect", text:"Private family SIP space", url:location.href });
      else if (navigator.clipboard) {
        await navigator.clipboard.writeText(location.href);
        toastMessage("Link copied");
      }
    } catch {}
  });
  $("storyAdd")?.addEventListener("click", () => toastMessage("Stories are local UI only."));
  window.addEventListener("beforeunload", () => {
    try { registerer?.unregister(); } catch {}
    try { userAgent?.stop(); } catch {}
  });
})();
