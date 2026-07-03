import express from "express";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3005;

// Path to the bundled standalone yt-dlp binary (bundles its own Python).
const YTDLP = process.env.YTDLP_PATH || join(__dirname, "bin", "yt-dlp");
if (!existsSync(YTDLP)) {
  console.error(`yt-dlp binary not found at ${YTDLP}. See README for setup.`);
  process.exit(1);
}

// Only allow X / Twitter hosts. This keeps the tool scoped to its stated
// purpose and avoids it becoming an open-ended fetcher (abuse / SSRF surface).
const ALLOWED_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

function parseAllowedUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: "That doesn't look like a valid URL." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { error: "URL must start with http(s)://" };
  }
  if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    return { error: "Only x.com / twitter.com post URLs are supported." };
  }
  // Normalize: strip query/hash, yt-dlp only needs the canonical status URL.
  return { url: `${u.protocol}//${u.hostname}${u.pathname}` };
}

// Format preference: a single progressive MP4 that already has audio+video,
// so we never need ffmpeg to merge separate streams. Falls back to best.
const FORMAT = "best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best";

function runYtdlp(args) {
  return spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
}

const app = express();
app.use(express.json());
// `extensions: ["html"]` lets /download-twitter-video-iphone serve the .html
// file, so landing pages get clean, SEO-friendly URLs. Canonical tags in each
// page point at the clean URL to avoid duplicate-content issues.
app.use(express.static(join(__dirname, "public"), { extensions: ["html"] }));

// Optional metadata lookup — powers the preview (title/thumbnail) in the UI.
app.post("/api/info", async (req, res) => {
  const { url, error } = parseAllowedUrl(req.body?.url || "");
  if (error) return res.status(400).json({ error });

  const child = runYtdlp([
    "--no-playlist",
    "--dump-single-json",
    "--no-warnings",
    url,
  ]);

  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", () =>
    res.status(500).json({ error: "Could not start the downloader." })
  );
  child.on("close", (code) => {
    if (code !== 0) {
      return res
        .status(422)
        .json({ error: cleanError(err) || "No video found at that URL." });
    }
    try {
      const info = JSON.parse(out);
      res.json({
        title: info.title || info.id || "video",
        uploader: info.uploader || info.uploader_id || null,
        thumbnail: info.thumbnail || null,
        duration: info.duration || null,
      });
    } catch {
      res.status(500).json({ error: "Could not read video info." });
    }
  });
});

// Streams the video straight to the client — no temp files, no disk cleanup.
// One-click flow: the widget links straight here, so there's a single yt-dlp
// extraction (not an info call + a download call) and no second button.
app.get("/api/download", (req, res) => {
  const { url, error } = parseAllowedUrl(req.query.url || "");
  if (error) return sendErrorPage(res, 400, error);

  // Optional token the widget passes so it can detect when the download starts
  // (we echo it back as a readable cookie the moment bytes begin flowing).
  const token = String(req.query.t || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 40);

  const child = runYtdlp([
    "--no-playlist",
    "--no-warnings",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--extractor-retries",
    "3",
    "-f",
    FORMAT,
    "-o",
    "-", // write the media to stdout
    url,
  ]);

  let stderr = "";
  let headersSent = false;
  let done = false; // guards against double-responding / use-after-free

  const kill = () => {
    if (!child.killed) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  };

  child.stderr.on("data", (d) => (stderr += d));

  // If the client disconnects mid-stream, writing to the socket throws EPIPE.
  // Swallow it here so it can never bubble up to an uncaughtException that would
  // crash the whole server (which on Render shows up as intermittent 404s).
  res.on("error", () => { done = true; kill(); });
  child.stdout.on("error", () => { done = true; kill(); });

  child.stdout.once("data", (chunk) => {
    if (done) return;
    // Only set download headers once we know bytes are actually flowing.
    headersSent = true;
    // Signal "download started" back to the widget so it can show a clean
    // confirmation instead of an endless spinner. Not HttpOnly on purpose —
    // the page's JS needs to read it. Short-lived and carries no data.
    if (token) {
      res.setHeader("Set-Cookie", `dlstart=${token}; Path=/; Max-Age=30; SameSite=Lax`);
    }
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="x-video-${Date.now()}.mp4"`
    );
    res.write(chunk);
    child.stdout.pipe(res);
  });

  child.on("error", () => {
    if (done) return;
    done = true;
    if (!headersSent && !res.headersSent) {
      sendErrorPage(res, 500, "Could not start the downloader. Please try again.");
    }
  });

  child.on("close", () => {
    if (done) return;
    done = true;
    if (!headersSent && !res.headersSent) {
      // No bytes ever streamed → the browser is still on our page, so we can
      // navigate it to a friendly branded error instead of dumping raw text.
      sendErrorPage(res, 422, cleanError(stderr) || "We couldn't find a video at that link.");
    } else {
      res.end(); // finished (or partial) stream — close it cleanly
    }
  });

  req.on("close", () => { done = true; kill(); }); // client bailed — stop working
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// A small, on-brand error page. Because the download uses a normal navigation,
// a failure lands the user here (styled) rather than on a wall of raw text.
function sendErrorPage(res, code, message) {
  res
    .status(code)
    .type("html")
    .send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Download didn't work — X Video Downloader</title>
<link rel="stylesheet" href="/styles.css" /></head>
<body>
  <div class="wrap">
    <header><h1>That didn't work</h1><p>${escapeHtml(message)}</p></header>
    <div class="card">
      <p style="margin:0 0 16px;color:var(--muted)">
        This usually means the link didn't contain a downloadable video. Make sure
        you copied the full post link — it should contain <em>/status/</em>.
      </p>
      <a class="dl" href="/"><button type="button">← Back to the downloader</button></a>
    </div>
  </div>
</body></html>`);
}

// yt-dlp errors are noisy; surface a single readable line.
function cleanError(raw) {
  if (!raw) return "";
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse()
    .find((l) => l.toLowerCase().includes("error"));
  return line ? line.replace(/^ERROR:\s*/i, "") : "";
}

// Last line of defense: a stray error (e.g. a socket reset during streaming)
// must never crash the process and take the whole site down. Log and continue.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

app.listen(PORT, () => {
  console.log(`X Video Downloader running at http://localhost:${PORT}`);
});
