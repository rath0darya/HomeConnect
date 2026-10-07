(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const PASSWORD_HASHES = Object.freeze({
    admin: "327179bea9bc971a7b5c6e3dd92bc6da5b63de0250b99f78ab36f263e272dc2b",
    family: "cbab50a3f910d110a23b011410f55d7bd66a529388ddeeab1b6e1cf6edefeeb0"
  });

  const loginView = $("loginView");
  const homeView = $("homeView");
  const loginForm = $("loginForm");
  const passwordInput = $("password");
  const showPassword = $("showPassword");
  const loginError = $("loginError");
  const myAvatar = $("myAvatar");
  const myName = $("myName");
  const myRole = $("myRole");
  const startCallButton = $("startCallButton");
  const endCallButton = $("endCallButton");
  const micButton = $("micButton");
  const cameraButton = $("cameraButton");
  const localVideo = $("localVideo");
  const remotePlaceholder = $("remotePlaceholder");
  const callStatus = $("callStatus");
  const appStatus = $("appStatus");
  const toast = $("toast");

  let stream = null;
  let toastTimer = null;

  async function sha256(value) {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
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

  function setStatus(message) {
    appStatus.textContent = message;
  }

  function setMember(role) {
    if (role === "admin") {
      myAvatar.textContent = "Y";
      myName.textContent = "You";
      myRole.textContent = "Private admin";
    } else {
      myAvatar.textContent = "F";
      myName.textContent = "Family";
      myRole.textContent = "Private family member";
    }
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const value = passwordInput.value;
    const hash = await sha256(value);

    let role = "";
    if (hash === PASSWORD_HASHES.admin) role = "admin";
    if (hash === PASSWORD_HASHES.family) role = "family";

    if (!role) {
      loginError.textContent = "Incorrect access password.";
      passwordInput.focus();
      return;
    }

    loginError.textContent = "";
    setMember(role);
    passwordInput.value = "";
    showHome();
    showToast("Welcome to HomeConnect");
  });

  showPassword.addEventListener("click", () => {
    const visible = passwordInput.type === "text";
    passwordInput.type = visible ? "password" : "text";
    showPassword.setAttribute("aria-label", visible ? "Show password" : "Hide password");
  });

  async function startLocalPreview() {
    if (stream) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Camera and microphone require HTTPS or localhost.");
      showToast("Media access is unavailable.");
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 60, max: 60 },
          facingMode: "user"
        }
      });

      localVideo.srcObject = stream;
      remotePlaceholder.classList.add("hidden");
      callStatus.textContent = "Local camera and microphone are active";
      startCallButton.disabled = true;
      endCallButton.disabled = false;
      micButton.disabled = false;
      cameraButton.disabled = false;
      micButton.classList.add("active");
      cameraButton.classList.add("active");
      setStatus("Local preview active. This static version has no cross-device signaling.");
      showToast("Camera & microphone ready");
    } catch (error) {
      stopLocalPreview();
      setStatus(error?.message || "Camera or microphone permission was denied.");
      showToast("Permission was not granted.");
    }
  }

  function stopLocalPreview() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    localVideo.srcObject = null;
    remotePlaceholder.classList.remove("hidden");
    callStatus.textContent = "No local call session is active";
    startCallButton.disabled = false;
    endCallButton.disabled = true;
    micButton.disabled = true;
    cameraButton.disabled = true;
    micButton.classList.remove("active");
    cameraButton.classList.remove("active");
    micButton.textContent = "Mic";
    cameraButton.textContent = "Cam";
  }

  startCallButton.addEventListener("click", startLocalPreview);
  endCallButton.addEventListener("click", () => {
    stopLocalPreview();
    setStatus("Local preview ended.");
  });

  micButton.addEventListener("click", () => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    micButton.classList.toggle("active", track.enabled);
    micButton.textContent = track.enabled ? "Mic" : "Muted";
  });

  cameraButton.addEventListener("click", () => {
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    cameraButton.classList.toggle("active", track.enabled);
    cameraButton.textContent = track.enabled ? "Cam" : "Camera off";
  });

  function lockApp() {
    stopLocalPreview();
    showLogin();
    loginError.textContent = "";
    passwordInput.value = "";
    showToast("HomeConnect locked");
  }

  $("logoutButton").addEventListener("click", lockApp);
  $("lockNavButton").addEventListener("click", lockApp);

  $("heroCallButton").addEventListener("click", () => {
    $("callSection").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  document.querySelectorAll(".nav-item[data-target]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");

      if (button.dataset.target === "call") {
        $("callSection").scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  });

  $("likeButton")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const liked = button.classList.toggle("active");
    button.firstChild.textContent = liked ? "♥ " : "♡ ";
    showToast(liked ? "Liked" : "Like removed");
  });

  $("commentButton")?.addEventListener("click", () => {
    showToast("Comments are local UI only.");
  });

  $("shareButton")?.addEventListener("click", async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: "HomeConnect", text: "Private family space", url: location.href });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(location.href);
        showToast("Link copied");
      }
    } catch {}
  });

  $("storyAdd")?.addEventListener("click", () => {
    showToast("Stories are local UI only.");
  });

  window.addEventListener("beforeunload", stopLocalPreview);
})();
