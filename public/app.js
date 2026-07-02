// Shared downloader widget logic. Safe to load on any page — it only runs
// if the widget markup is present.
(function () {
  const form = document.getElementById("form");
  if (!form) return;

  const urlInput = document.getElementById("url");
  const submit = document.getElementById("submit");
  const status = document.getElementById("status");
  const preview = document.getElementById("preview");
  const thumb = document.getElementById("thumb");
  const titleEl = document.getElementById("title");
  const uploaderEl = document.getElementById("uploader");
  const dl = document.getElementById("dl");

  function setStatus(msg, kind) {
    status.className = "status " + (kind || "muted");
    status.innerHTML = msg;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    preview.classList.remove("show");
    submit.disabled = true;
    setStatus('<span class="spinner"></span>Looking up video…', "muted");

    try {
      const r = await fetch("/api/info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Something went wrong.");

      titleEl.textContent = data.title || "Video";
      uploaderEl.textContent = data.uploader ? "by " + data.uploader : "";
      if (data.thumbnail) {
        thumb.src = data.thumbnail;
        thumb.style.display = "";
      } else {
        thumb.style.display = "none";
      }
      dl.href = "/api/download?url=" + encodeURIComponent(url);
      preview.classList.add("show");
      setStatus("Ready — click Save video below.", "muted");
    } catch (err) {
      setStatus(err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  dl.addEventListener("click", () => {
    setStatus("Your download should begin shortly…", "muted");
  });
})();
