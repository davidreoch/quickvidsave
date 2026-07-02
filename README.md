# X Video Downloader

A clean, single-page web app: paste an X (Twitter) post URL, get the video as an MP4.
Node/Express backend wrapping the standalone [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) binary.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

The `yt-dlp` binary lives in `bin/yt-dlp` (macOS standalone build — it bundles its
own Python, so your system Python version doesn't matter). To update it:

```bash
curl -L -o bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos
chmod +x bin/yt-dlp
```

For Linux hosting, download `yt-dlp_linux` instead and point `YTDLP_PATH` at it.

## Pages & SEO

The site is static HTML served from `public/`, sharing one stylesheet (`styles.css`)
and one script (`app.js`, the downloader widget — it's a no-op on pages without the form).

| URL | File | Targets |
|-----|------|---------|
| `/` | `index.html` | "x / twitter video downloader" + FAQ |
| `/download-twitter-video-iphone` | `download-twitter-video-iphone.html` | iPhone how-to |
| `/download-twitter-video-android` | `download-twitter-video-android.html` | Android how-to |
| `/twitter-gif-downloader` | `twitter-gif-downloader.html` | "twitter gif downloader" |
| `/twitter-video-downloader-pc` | `twitter-video-downloader-pc.html` | Windows/Mac how-to |

Clean (extensionless) URLs work via `extensions: ["html"]` on the static middleware.
Each page has its own title/description, canonical, Open Graph, and JSON-LD
(`HowTo` / `FAQPage` — eligible for rich results), and they cross-link via the nav,
footer, and "More guides" grid.

**Before going live:** search-and-replace `https://YOURDOMAIN.com` with your real domain
across `public/` (index + landing pages + `robots.txt` + `sitemap.xml`), add an
`og-image.png` (1200×630) to `public/`, then submit `sitemap.xml` in Google Search Console.
To add a new landing page: copy an existing one, rewrite the content, and add a `<url>`
line to `sitemap.xml`.

## How it works

- `POST /api/info` → returns title / uploader / thumbnail for the preview card.
- `GET /api/download?url=...` → streams the MP4 straight to the browser (no temp files).
- Requests are restricted to `x.com` / `twitter.com` hosts (see `ALLOWED_HOSTS` in `server.js`).

## Notes & limitations

- **Format:** picks a single progressive MP4 (audio+video in one stream) so it works
  without `ffmpeg`. If you later install `ffmpeg`, you can widen `FORMAT` in `server.js`
  to offer higher-resolution merged formats.
- **X changes things often.** X restricts unauthenticated access periodically. If
  downloads start failing, updating the `yt-dlp` binary usually fixes it. Some videos
  may require passing a cookies file to `yt-dlp` (`--cookies`).
- **Only download content you have the right to.** See the disclaimer in the footer.

## Monetization / ads

Ad slots are the `.ad-slot` divs in `public/index.html` — drop any network's snippet in.

Heads-up: **Google AdSense frequently rejects media-downloader sites.** Apply, but keep a
fallback (Ezoic, Media.net) and consider affiliate offers (VPN, cloud storage), which
convert well with this audience and have no approval gate.

## Deploy

The app is containerized. The `Dockerfile` installs deps, fetches the **Linux**
`yt-dlp` binary at build time, and includes `ffmpeg`. Any host that runs a container
works — the app reads `PORT` from the environment, which Render/Railway/Fly set for you.

**Build & run locally:**

```bash
docker build -t x-video-downloader .
docker run -p 3005:3005 x-video-downloader
# open http://localhost:3005
```

**Render (simplest):** New → Web Service → connect the repo → it auto-detects the
Dockerfile → deploy. No PORT config needed. **Railway / Fly.io** work the same way.

**Bare VPS (no Docker):** run `npm ci --omit=dev`, download `yt-dlp_linux` into
`bin/yt-dlp`, `apt install ffmpeg`, then `node server.js` behind a reverse proxy
(Caddy/Nginx) for TLS.

### After it's live

1. Point your domain at the host (the host gives you a target/CNAME).
2. Confirm downloads still work from the deployed URL — X can behave differently from a
   datacenter IP. If videos fail, updating the `yt-dlp` binary (rebuild the image) or
   supplying a `--cookies` file usually fixes it.
3. Then connect your ad network (Ezoic sits in front via nameservers/script).
