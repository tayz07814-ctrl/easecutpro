# EaseCutPro — Web / self-hosted mode

Run EaseCutPro in a browser with **your PC as the backend** ("cloud"): the same
React editor runs in the browser, and your PC does all the heavy work — probing,
transcription (whisper.cpp), silence detection, waveforms, thumbnails, and
**video export** — using the exact same code the desktop app uses.

The desktop Electron app still works exactly as before; this is an *additional*
target that shares the same renderer.

## How it works

- `src/server/index.ts` is a small Express server that reuses `src/main/ffmpeg.ts`
  and `src/main/whisper.ts`.
- The browser gets a web implementation of the old `window.api`
  (`src/renderer/src/webapi.ts`) — HTTP for quick calls, and a **WebSocket job
  model** for the long ones (transcribe/export) so they survive proxy/tunnel
  request timeouts.
- Media streams from the server over HTTP with Range support (replaces the
  desktop `ecmedia://` protocol).

## Run it (local)

```bash
npm run web          # builds the client, then starts the server
# or, iterating:
npm run build        # build the client once
npm run server       # start the server (serves out/renderer)
```

Open **http://localhost:8787**.

## Configuration (environment variables)

| Var | Default | Purpose |
|-----|---------|---------|
| `EC_PORT` | `8787` | Port to listen on |
| `EC_HOST` | `0.0.0.0` | Bind address (0.0.0.0 = reachable on your LAN) |
| `EC_TOKEN` | _(empty)_ | **Access token. REQUIRED for anything beyond localhost.** Empty = no auth. |
| `EC_WORK_DIR` | `./.ecweb` | Where uploads + exports are stored |
| `EC_BROWSE_ROOTS` | _(empty)_ | `;`-separated folders the "pick files on the PC" browser may read |

Example (Windows PowerShell):

```powershell
$env:EC_TOKEN="a-long-random-string"; $env:EC_BROWSE_ROOTS="C:\Users\me\Videos"; npm run server
```

## Access from other devices on your network

1. Set a token: `EC_TOKEN=...`.
2. Start the server. It prints a `network: http://192.168.x.x:8787` URL.
3. Open that URL on your phone/laptop and enter the token.

## Access over the internet — one command

```bash
npm run remote         # Cloudflare quick tunnel — random URL, most reliable
npm run remote:named   # localtunnel — branded URL: https://easecutpro.loca.lt
```

`remote:named` gives a **short, consistent** URL (`easecutpro.loca.lt`, the same
every run). loca.lt may show a one-time reminder page on first visit — click
continue, or if it asks for a password, enter your **public IP** (the launcher
prints it). It's a bit less reliable than Cloudflare; if it acts up, fall back to
`npm run remote`. Override the name with `EC_SUBDOMAIN`:
`node scripts/remote.mjs lt` reads `EC_SUBDOMAIN=easecutpro-yourname`.

Both build the client if needed, start the server **with a token**, open the
tunnel, and print a banner:

```
   URL:    https://<random>.trycloudflare.com
   Token:  <your token>
```

Open that URL on any device (try your phone on mobile data to confirm it's truly
over the internet), enter the token. Stop everything with **Ctrl+C**.

- The token is generated once and saved to `.ectoken`, so it **stays the same**
  across runs (override with `EC_TOKEN=... npm run remote`). Keep `.ectoken`
  private — anyone with the URL **and** token can use your PC.
- The `https://<random>.trycloudflare.com` URL **changes every run**. For a
  permanent fixed URL you need a free Cloudflare account + a named tunnel.
- `cloudflared` is bundled at `tools/cloudflared.exe` (downloaded once). The WS
  job model means long exports/transcriptions won't hit the tunnel timeout.

### Manual equivalent (or with ngrok)

```bash
# terminal A
EC_TOKEN=a-long-random-string npm run server
# terminal B
tools/cloudflared.exe tunnel --url http://localhost:8787   # or: ngrok http 8787
```

## Security notes

- **Set `EC_TOKEN`** before exposing beyond localhost. Auth is a session cookie
  (`HttpOnly`, `SameSite=Lax`), checked on every `/api` and `/media` request and
  on the WebSocket upgrade.
- **Path allow-list:** every path that reaches ffmpeg/whisper or the media
  streamer is validated against the uploads/exports dirs + `EC_BROWSE_ROOTS`.
  Clients cannot make the server read or process files outside those roots.
- ffmpeg/whisper are spawned with argv arrays (no shell), so there's no shell
  injection surface.
- Use the Cloudflare/ngrok HTTPS URL (not raw HTTP) when on the internet so the
  token cookie travels encrypted.

## Loading media

- **Upload from the browser:** the file picker uploads to the server's
  `EC_WORK_DIR/uploads` and processing runs there. Works from any device.
- **Pick files already on the PC:** set `EC_BROWSE_ROOTS`; the server exposes
  `/api/files` to browse within those folders (UI for this is the next step).

## Projects & exports

- **Save project** downloads a `.ecp.json` in the browser; **Open project** reads
  one back. (Project files reference server-side media paths.)
- **Export** runs on the PC and the finished `.mp4` downloads in the browser.
