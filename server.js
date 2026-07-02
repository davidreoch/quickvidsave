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
app.get("/api/download", (req, res) => {
  const { url, error } = parseAllowedUrl(req.query.url || "");
  if (error) return res.status(400).send(error);

  const child = runYtdlp([
    "--no-playlist",
    "--no-warnings",
    "-f",
    FORMAT,
    "-o",
    "-", // write the media to stdout
    url,
  ]);

  let stderr = "";
  let headersSent = false;

  child.stderr.on("data", (d) => (stderr += d));

  child.stdout.once("data", (chunk) => {
    // Only set download headers once we know bytes are actually flowing.
    headersSent = true;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="x-video-${Date.now()}.mp4"`
    );
    res.write(chunk);
    child.stdout.pipe(res);
  });

  child.on("error", () => {
    if (!headersSent) res.status(500).send("Could not start the downloader.");
  });

  child.on("close", (code) => {
    if (!headersSent) {
      res
        .status(422)
        .send(cleanError(stderr) || "Could not download that video.");
    } else if (code !== 0) {
      res.end(); // partial stream; end it so the client isn't left hanging
    }
  });

  req.on("close", () => child.kill("SIGKILL")); // client bailed — stop working
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

app.listen(PORT, () => {
  console.log(`X Video Downloader running at http://localhost:${PORT}`);
});
