(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const feed = $("feed");
  const toast = $("toast");
  const noteDialog = $("noteDialog");
  const noteText = $("noteText");
  const photoInput = $("photoInput");

  const defaultNotes = [
    { name: "Family", avatar: "F", text: "HomeConnect is ready for the family.", time: "Just now" },
    { name: "Home", avatar: "H", text: "A simple private space for the moments that matter.", time: "Today" }
  ];

  let notes = JSON.parse(localStorage.getItem("homeconnect-notes") || "null") || defaultNotes;

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[char]));
  }

  function render() {
    feed.innerHTML = notes.map((item) => `
      <article class="feed-item card">
        <div class="feed-avatar">${escapeHTML(item.avatar || "F")}</div>
        <div><b>${escapeHTML(item.name)}</b><p>${escapeHTML(item.text)}</p></div>
        <time>${escapeHTML(item.time)}</time>
      </article>
    `).join("");
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  $("themeButton").addEventListener("click", () => {
    document.body.classList.toggle("light");
    localStorage.setItem("homeconnect-theme", document.body.classList.contains("light") ? "light" : "dark");
  });

  if (localStorage.getItem("homeconnect-theme") === "light") {
    document.body.classList.add("light");
  }

  $("familyButton").addEventListener("click", () => {
    $("family").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;

      if (action === "message") {
        noteDialog.showModal();
      } else if (action === "photo") {
        photoInput.click();
      } else if (action === "call") {
        showToast("A real cross-device call needs a signaling service.");
      }
    });
  });

  $("saveNote").addEventListener("click", (event) => {
    const value = noteText.value.trim();
    if (!value) {
      event.preventDefault();
      showToast("Write a message first.");
      return;
    }

    notes.unshift({
      name: "You",
      avatar: "Y",
      text: value,
      time: "Just now"
    });

    notes = notes.slice(0, 12);
    localStorage.setItem("homeconnect-notes", JSON.stringify(notes));
    noteText.value = "";
    render();
    showToast("Family note added on this device.");
  });

  photoInput.addEventListener("change", () => {
    if (photoInput.files?.length) {
      showToast("Photo selected. Static mode keeps it on this device.");
      photoInput.value = "";
    }
  });

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  render();
})();