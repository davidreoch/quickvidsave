// Shared downloader widget logic. Safe to load on any page — it only runs
// if the widget markup is present. All enhancements below are added in JS so
// every page (home + landing pages) gets them without editing each file.
//
// One-click flow: the form submit triggers the download directly (a single
// server-side extraction, no separate "look up" step and no second button).
// The browser saves the file via Content-Disposition — which is also the most
// reliable way to actually save on iOS Safari. We show honest progress and,
// the moment bytes start flowing, a clean "download started" confirmation
// (the server sets a short-lived cookie we poll for).
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

  // Mirror the server's accepted hosts so we can reject an obviously-wrong link
  // instantly, instead of making the user wait ~12s for a server-side error.
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

  let pollTimer = null;
  let waitTimer = null;
  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    if (waitTimer) clearTimeout(waitTimer);
    pollTimer = waitTimer = null;
  }

  function startDownload(url) {
    stopTimers();

    // Unique token so we can recognise *our* download starting.
    const token = "t" + Date.now() + Math.floor(Math.random() * 1e6);
    document.cookie = "dlstart=; Path=/; Max-Age=0"; // clear any stale value

    // Kick off the download inside this user gesture. No `download` attribute:
    // that lets the server decide (attachment → saves & we stay here; an error
    // response → the browser shows our friendly error page instead).
    const a = document.createElement("a");
    a.href = "/api/download?t=" + token + "&url=" + encodeURIComponent(url);
    document.body.appendChild(a);
    a.click();
    a.remove();

    submit.disabled = true;
    submit.textContent = "Fetching…";
    setStatus(
      '<span class="spinner"></span>Fetching your video from X… this usually takes 10–20 seconds.',
      "muted"
    );

    // Keep it from feeling broken on slower/HD videos.
    waitTimer = setTimeout(() => {
      setStatus(
        '<span class="spinner"></span>Still working — longer or HD videos take a little more time.',
        "muted"
      );
    }, 18000);

    function reset() {
      submit.disabled = false;
      submit.textContent = submitLabel;
    }

    // Watch for the "download started" signal from the server.
    let waited = 0;
    pollTimer = setInterval(() => {
      waited += 500;
      if (document.cookie.indexOf("dlstart=" + token) !== -1) {
        stopTimers();
        reset();
        setStatus("✓ Your download has started — check your downloads.", "muted");
        document.cookie = "dlstart=; Path=/; Max-Age=0";
      } else if (waited > 90000) {
        stopTimers();
        reset();
        setStatus(
          "Taking longer than expected. If nothing downloaded, the link may not contain a video — try another.",
          "muted"
        );
      }
    }, 500);
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
