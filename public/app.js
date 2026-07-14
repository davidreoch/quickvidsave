// Shared downloader widget logic. Safe to load on any page — it only runs
// if the widget markup is present. All enhancements below are added in JS so
// every page (home + landing pages) gets them without editing each file.
//
// How the download works, and why:
//
// The server no longer streams the video to us. It used to, and we paid egress
// on every byte — which blew the host's bandwidth quota and got the site
// suspended. Now the server only *resolves* the post to X's direct CDN URL
// (a few hundred bytes), and the browser fetches the media straight from X.
// The bytes never touch our server, so bandwidth stays flat however popular a
// video gets.
//
// Two things make that work:
//   1. X's CDN 403s any request carrying a foreign Referer → fetch with
//      referrerPolicy: "no-referrer".
//   2. It reflects our origin back in Access-Control-Allow-Origin, so we can
//      read the bytes and hand them to the user as a real file download with a
//      proper filename — keeping the one-click save.
//
// If the direct fetch ever fails (an old browser, a CORS change at X's end), we
// fall back to opening the video so the user can still save it manually.
(function () {
  const form = document.getElementById("form");
  if (!form) return;

  const urlInput = document.getElementById("url");
  const submit = document.getElementById("submit");
  const status = document.getElementById("status");
  if (!urlInput || !submit || !status) return;

  const submitLabel = submit.textContent || "Download";

  // Accessibility: announce status changes to screen readers, label the field.
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  if (!urlInput.getAttribute("aria-label")) {
    urlInput.setAttribute("aria-label", "X (Twitter) post link");
  }

  function setStatus(msg, kind) {
    status.className = "status " + (kind || "muted");
    status.innerHTML = msg;
  }

  function busy(on) {
    submit.disabled = on;
    submit.textContent = on ? "Working…" : submitLabel;
  }

  // Mirror the server's accepted hosts so we can reject an obviously-wrong link
  // instantly, instead of making the user wait for a server-side error.
  function checkXUrl(raw) {
    let u;
    try {
      u = new URL(raw.trim());
    } catch {
      return "invalid";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "invalid";
    const host = u.hostname.toLowerCase().replace(/^(www\.|mobile\.)/, "");
    if (host !== "x.com" && host !== "twitter.com") return "notx";
    if (!/\/status\/\d+/.test(u.pathname)) return "nostatus";
    return "ok";
  }

  // Save a blob to the user's device with a real filename.
  function saveBlob(blob, filename) {
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a moment to start the save before releasing the blob.
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
  }

  // Pull the video from X's CDN, reporting progress as it goes.
  async function fetchVideo(cdnUrl) {
    const res = await fetch(cdnUrl, { referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error("cdn " + res.status);

    const total = Number(res.headers.get("content-length")) || 0;
    // Without a readable stream we can't show progress — just take the blob.
    if (!res.body || !res.body.getReader) return res.blob();

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) {
        const pct = Math.min(99, Math.round((received / total) * 100));
        setStatus('<span class="spinner"></span>Saving your video… ' + pct + "%", "muted");
      } else {
        const mb = (received / 1048576).toFixed(1);
        setStatus('<span class="spinner"></span>Saving your video… ' + mb + " MB", "muted");
      }
    }
    return new Blob(chunks, { type: "video/mp4" });
  }

  async function startDownload(url) {
    busy(true);
    setStatus('<span class="spinner"></span>Finding your video…', "muted");

    // 1. Ask our server for the direct CDN URL (cheap — no media passes through).
    let info;
    try {
      const res = await fetch("/api/resolve?url=" + encodeURIComponent(url));
      info = await res.json();
      if (!res.ok) throw new Error(info && info.error);
    } catch (e) {
      busy(false);
      setStatus(
        (e && e.message) || "We couldn't find a video at that link. Try another.",
        "error"
      );
      return;
    }

    // 2. Fetch the media straight from X and save it with a proper filename.
    try {
      const blob = await fetchVideo(info.url);
      saveBlob(blob, info.filename || "x-video.mp4");
      busy(false);
      setStatus("✓ Saved — check your downloads.", "muted");
    } catch {
      // Direct fetch failed. The video is still perfectly reachable, so open it
      // rather than dead-ending: the user can long-press / right-click to save.
      busy(false);
      window.open(info.url, "_blank", "noopener");
      setStatus(
        "Your video opened in a new tab — press and hold it, then choose <em>Save video</em>.",
        "muted"
      );
    }
  }

  // Validate, then download. Instant, helpful errors for bad input.
  function submitUrl(raw) {
    const url = (raw || "").trim();
    if (!url) {
      urlInput.focus();
      return;
    }
    const verdict = checkXUrl(url);
    if (verdict === "notx") {
      setStatus("That doesn't look like an X / twitter.com link.", "error");
      urlInput.focus();
      return;
    }
    if (verdict === "nostatus") {
      setStatus("Paste the full post link — it should contain <em>/status/</em>.", "error");
      urlInput.focus();
      return;
    }
    if (verdict === "invalid") {
      setStatus("That doesn't look like a valid link.", "error");
      urlInput.focus();
      return;
    }
    startDownload(url);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitUrl(urlInput.value);
  });

  // Clear the error state as soon as the user starts fixing the link.
  urlInput.addEventListener("input", () => {
    if (status.classList.contains("error")) setStatus("", "muted");
  });

  // One-tap "Paste" button — a big deal on mobile, where pasting is fiddly.
  // Only shown when the browser exposes clipboard reads (feature-detected);
  // Firefox and older browsers just fall back to manual paste + Download.
  if (navigator.clipboard && navigator.clipboard.readText) {
    const paste = document.createElement("button");
    paste.type = "button";
    paste.className = "paste-btn";
    paste.textContent = "📋 Paste link";
    paste.setAttribute("aria-label", "Paste a link from your clipboard and download");
    form.insertAdjacentElement("afterend", paste);

    paste.addEventListener("click", async () => {
      let text = "";
      try {
        text = (await navigator.clipboard.readText()).trim();
      } catch {
        setStatus(
          "Couldn't read the clipboard. Long-press the box to paste, then press Download.",
          "muted"
        );
        return;
      }
      if (!text) {
        setStatus("Your clipboard is empty — copy an X post link first.", "muted");
        return;
      }
      urlInput.value = text;
      if (checkXUrl(text) === "ok") {
        submitUrl(text); // valid link → go straight to downloading (true one-tap)
      } else {
        setStatus(
          "Pasted — but that doesn't look like an X post link. Check it and press Download.",
          "muted"
        );
        urlInput.focus();
      }
    });
  }

  // Desktop convenience: focus the field so you can paste immediately.
  // Skipped on touch devices so we don't pop the on-screen keyboard.
  try {
    if (window.matchMedia && !window.matchMedia("(pointer: coarse)").matches) {
      urlInput.focus();
    }
  } catch {}
})();
