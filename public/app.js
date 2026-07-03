// Shared downloader widget logic. Safe to load on any page — it only runs
// if the widget markup is present.
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

  function setStatus(msg, kind) {
    status.className = "status " + (kind || "muted");
    status.innerHTML = msg;
  }

  let pollTimer = null;
  let waitTimer = null;
  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    if (waitTimer) clearTimeout(waitTimer);
    pollTimer = waitTimer = null;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
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

    // Watch for the "download started" signal from the server.
    let waited = 0;
    pollTimer = setInterval(() => {
      waited += 500;
      if (document.cookie.indexOf("dlstart=" + token) !== -1) {
        stopTimers();
        submit.disabled = false;
        setStatus("✓ Your download has started — check your downloads.", "muted");
        document.cookie = "dlstart=; Path=/; Max-Age=0";
      } else if (waited > 90000) {
        stopTimers();
        submit.disabled = false;
        setStatus(
          "Taking longer than expected. If nothing downloaded, the link may not contain a video — try another.",
          "muted"
        );
      }
    }, 500);
  });
})();
