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

// Format preference: a single progressive MP4 that already has audio+video, so
// there is exactly one media URL to hand back (no separate streams to merge).
const FORMAT = "best[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4]/best";

function runYtdlp(args) {
  return spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
}

// --- Rate limiting -----------------------------------------------------------
// Each resolve spawns a yt-dlp process, so this is the expensive endpoint. A
// simple per-IP cap keeps one script from monopolising the box. In-memory is
// fine: a restart resetting the counters is not a meaningful abuse window.
const HITS = new Map(); // ip -> number[] (timestamps)
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 12;

function rateLimited(ip) {
  const now = Date.now();
  const recent = (HITS.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    HITS.set(ip, recent);
    return true;
  }
  recent.push(now);
  HITS.set(ip, recent);
  if (HITS.size > 5000) {
    // Cheap eviction so the map can't grow without bound.
    for (const [k, v] of HITS) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) HITS.delete(k);
    }
  }
  return false;
}

const app = express();
app.set("trust proxy", 1); // behind Render's proxy, so req.ip is the real client
app.use(express.json());
// `extensions: ["html"]` lets /download-twitter-video-iphone serve the .html
// file, so landing pages get clean, SEO-friendly URLs. Canonical tags in each
// page point at the clean URL to avoid duplicate-content issues.
app.use(express.static(join(__dirname, "public"), { extensions: ["html"] }));

// Resolve a post URL to the direct video file on X's CDN.
//
// We deliberately DO NOT proxy the video. Streaming it through here meant we
// paid egress on every byte of every download, which is what got the service
// suspended for blowing its bandwidth quota. Instead we hand the browser the
// CDN URL and it fetches the bytes straight from X — so the media never
// touches this server and our bandwidth stays flat no matter how popular a
// video is. The client still saves it with a proper filename (see app.js).
//
// Note: X's CDN 403s any request carrying a foreign Referer, so the browser
// must fetch with referrerPolicy: "no-referrer". CORS itself is fine — the CDN
// reflects the requesting origin back in Access-Control-Allow-Origin.
app.get("/api/resolve", (req, res) => {
  if (rateLimited(req.ip)) {
    return res
      .status(429)
      .json({ error: "Too many requests — give it a minute and try again." });
  }

  const { url, error } = parseAllowedUrl(req.query.url || "");
  if (error) return res.status(400).json({ error });

  const child = runYtdlp([
    "--no-playlist",
    "--no-warnings",
    "--extractor-retries",
    "3",
    "-f",
    FORMAT,
    "-g", // print the direct media URL instead of downloading it
    url,
  ]);

  let out = "";
  let err = "";
  let done = false;

  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));

  child.on("error", () => {
    if (done) return;
    done = true;
    res.status(500).json({ error: "Could not start the downloader." });
  });

  child.on("close", (code) => {
    if (done) return;
    done = true;

    // The format selector asks for a muxed MP4, so we expect exactly one URL.
    // If yt-dlp returns several, the video and audio are separate streams and
    // we'd need ffmpeg to merge them — which we can't do without proxying.
    const urls = out.trim().split("\n").filter(Boolean);
    if (code !== 0 || urls.length === 0) {
      return res.status(422).json({
        error: cleanError(err) || "We couldn't find a video at that link.",
      });
    }
    if (urls.length > 1) {
      return res.status(422).json({
        error: "That video's audio and video are stored separately, so it can't be saved directly.",
      });
    }

    res.json({
      url: urls[0],
      filename: `x-video-${Date.now()}.mp4`,
    });
  });

  req.on("close", () => {
    done = true;
    if (!child.killed) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });
});

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

// Last line of defense: a stray error must never crash the process and take the
// whole site down. Log and continue.
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err?.message || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

app.listen(PORT, () => {
  console.log(`X Video Downloader running at http://localhost:${PORT}`);
});
