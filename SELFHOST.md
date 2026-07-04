# EaseCutPro — Self-host on your own PC + domain (24/7)

Run EaseCutPro as a real public web app on **your own domain**, served from **your
home PC** (which has the GPU + ffmpeg + whisper). No Vercel, no rented server, no
port-forwarding — a **Cloudflare Tunnel** carries traffic from your domain to the
PC over an outbound connection, so it works even though your ISP puts you behind
**CGNAT** (confirmed: a private `10.x` hop sits between your router and the
internet, so inbound port-forwarding is impossible).

```
   Browser anywhere
        │  https://app.yourdomain.com
        ▼
   Cloudflare edge  (free TLS, hides your home IP, DDoS protection)
        │  encrypted tunnel (outbound from your PC — CGNAT-proof)
        ▼
   cloudflared.exe  on your PC   ──►   EaseCutPro server  http://localhost:8787
                                              │
                                              ▼
                                   ffmpeg · whisper (GPU) · exports
```

You already have the tunnel binary bundled at `tools/cloudflared.exe`.

---

## What you need first

1. A **domain** (e.g. `yourdomain.com`). Cheapest at-cost option: **Cloudflare
   Registrar**. Any registrar works.
2. A free **Cloudflare account** with the domain added (its nameservers pointed at
   Cloudflare). This is required — the tunnel runs through Cloudflare.

Pick the hostname you'll use, e.g. **`app.yourdomain.com`**. The steps below use
that; substitute your own.

---

## One-time setup

All commands run from `C:\easecutpro`. `cf` below = `.\tools\cloudflared.exe`.

### 1. Authenticate cloudflared with your Cloudflare account
```powershell
.\tools\cloudflared.exe tunnel login
```
A browser opens → pick your domain → **Authorize**. This saves a cert to
`%USERPROFILE%\.cloudflared\cert.pem`.

### 2. Create the tunnel
```powershell
.\tools\cloudflared.exe tunnel create easecutpro
```
Prints a **Tunnel ID** (a UUID) and writes a credentials file
`%USERPROFILE%\.cloudflared\<UUID>.json`. Note the UUID.

### 3. Route your hostname to the tunnel (creates the DNS record for you)
```powershell
.\tools\cloudflared.exe tunnel route dns easecutpro app.yourdomain.com
```

### 4. Write the tunnel config
Create `%USERPROFILE%\.cloudflared\config.yml` (replace the UUID and hostname):
```yaml
tunnel: <UUID-from-step-2>
credentials-file: C:\Users\trojan\.cloudflared\<UUID-from-step-2>.json

ingress:
  - hostname: app.yourdomain.com
    service: http://localhost:8787
  - service: http_status:404
```
> WebSockets (the transcribe/export progress channel) pass through automatically —
> no extra config needed.

### 5. Tell EaseCutPro the tunnel name (so `npm run selfhost` finds it)
Create a file `C:\easecutpro\.cftunnel` containing exactly:
```
easecutpro
```

---

## Test it (foreground) before going 24/7
```powershell
npm run selfhost
```
This builds the client, starts the server with production settings
(`EC_SECURE_COOKIES=1`, signup gated by the code it prints), and runs the tunnel.
Open **https://app.yourdomain.com** on your phone (on mobile data, to prove it's
truly over the internet). Sign up once with the printed **signup code**, then log
in. `Ctrl+C` stops everything.

When that works, move on to run it permanently.

---

## Run it 24/7 (Windows services)

Two services: the **tunnel** and the **server**. Both auto-start on boot and
auto-restart on crash. Run these in an **Administrator** PowerShell.

### A. Tunnel as a service (native cloudflared)
```powershell
.\tools\cloudflared.exe service install
```
This installs the `cloudflared` Windows service, which reads
`%USERPROFILE%\.cloudflared\config.yml` from step 4. Verify:
```powershell
Get-Service cloudflared
```

### B. Server as a service (via NSSM)
The server is a Node process, so we wrap it with **NSSM** (the Non-Sucking Service
Manager). Get it once: `choco install nssm` (if you have Chocolatey) or download
`nssm.exe` from https://nssm.cc and drop it in `C:\easecutpro\tools\`.

```powershell
# from C:\easecutpro, as Administrator
$node = (Get-Command node).Source
.\tools\nssm.exe install EaseCutProServer "$node" "node_modules\tsx\dist\cli.mjs src\server\index.ts"
.\tools\nssm.exe set EaseCutProServer AppDirectory "C:\easecutpro"
.\tools\nssm.exe set EaseCutProServer AppEnvironmentExtra EC_PORT=8787 EC_SECURE_COOKIES=1 EC_SIGNUP_CODE=PUT-A-LONG-SECRET-HERE
.\tools\nssm.exe set EaseCutProServer AppStdout "C:\easecutpro\.server.log"
.\tools\nssm.exe set EaseCutProServer AppStderr "C:\easecutpro\.server.log"
.\tools\nssm.exe start EaseCutProServer
```
Manage it later with `nssm restart EaseCutProServer` / `nssm stop ...`, or
`Get-Service EaseCutProServer`. After a code update: `npm run build` then
`nssm restart EaseCutProServer`.

> Keep your PC awake: **Settings → System → Power → Sleep → Never** (at least when
> plugged in), or the server is unreachable while it sleeps.

---

## Production / security checklist

- **Gate signups.** Set a long random `EC_SIGNUP_CODE` (done in the NSSM env
  above). Without it, anyone with the URL can create an account on your PC.
- **HTTPS cookies on.** `EC_SECURE_COOKIES=1` makes the session cookie `Secure`
  (the launcher and NSSM env set this). Always open the **https://** URL.
- **Auth is rate-limited** (10 logins / 20 signups per IP per minute) to blunt
  brute force — handled in code, nothing to configure.
- **Leave `EC_BROWSE_ROOTS` unset** in production. It lets the browser read folders
  on your PC — fine on localhost, risky when public.
- **Watch disk space.** Per-user `uploads/` and `exports/` under `.ecweb/` grow
  over time; prune old files periodically (a cleanup job is a good next addition).
- **Back up `.ecweb/users.json` + `.ecweb/.secret`** — that's your accounts and the
  cookie-signing key.

---

## Honest limits (with your 32 GB / good GPU+CPU box)

- **You + a handful of users: great.** GPU whisper is fast; one export at a time
  flies.
- **Concurrency is the ceiling.** There's no job queue with concurrency caps yet —
  two simultaneous exports split your GPU/CPU and everything slows. Fine for a few
  people, not a public launch. (Adding a queue is the upgrade when you need it.)
- **Upload bandwidth, not hardware, is the real bottleneck.** Serving a multi-GB
  export *out* uses your home **upload** speed (usually far lower than download).
- **Large video on Cloudflare's free plan.** Their TOS discourages serving heavy
  video through the proxy at scale. Light/personal use is fine; if it grows, move
  media to R2 or a paid plan.

---

## Tie-in: Google sign-in on this domain

Once `app.yourdomain.com` is live, it becomes the clean, permanent **redirect URL**
for web Google sign-in. In your Google Cloud "Web" OAuth client, add:
```
https://app.yourdomain.com/api/auth/google/callback
```
(See `GOOGLE_SETUP.md` for the rest.) The same domain serves both the app and the
OAuth callback.
