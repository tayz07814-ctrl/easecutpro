# Code signing + releases (Windows)

Two things stand between the current build and something you can sell:

1. **Signing** — an unsigned installer shows *"Windows protected your PC —
   Windows Defender SmartScreen prevented an unrecognised app from starting"* on
   basically every download. Most people click "Don't run". It is the single
   biggest conversion killer for an indie Windows app, and no amount of polish
   inside the app compensates for it.
2. **Releases** — auto-update reads a published feed. Without one, every fix
   means asking creators to find and re-download a 230 MB installer.

The build is already wired for both. What is missing is a certificate, which
only you can buy, and a first published release.

---

## 1. Getting a certificate

| option | cost (approx/yr) | SmartScreen | notes |
|---|---|---|---|
| **Azure Trusted Signing** | ~$120 | trusted quickly | Microsoft's own service. Cheapest credible route. Needs an Azure account and a business identity check. **Recommended.** |
| **OV certificate** (Sectigo/DigiCert) | $200-400 | builds reputation over weeks | Must be stored on an approved hardware token since June 2023, which complicates CI. |
| **EV certificate** | $300-600 | trusted immediately | Hardware token required. Best experience, highest friction. |

An individual (not a registered company) can usually still get OV — expect to
prove identity. Azure Trusted Signing supports individuals under a
"public individual" identity type.

---

## 2. Wiring the certificate in

Nothing in `package.json` needs editing — electron-builder reads these from the
environment, so the certificate never enters the repo:

```bash
# a .pfx / .p12 file
set CSC_LINK=C:\path\to\certificate.pfx
set CSC_KEY_PASSWORD=your-password
npm run dist
```

For **Azure Trusted Signing**, install the electron-builder Azure signer and set:

```bash
set AZURE_TENANT_ID=...
set AZURE_CLIENT_ID=...
set AZURE_CLIENT_SECRET=...
```

then add to the `build.win` block:

```jsonc
"azureSignOptions": {
  "publisherName": "Your Registered Name",
  "endpoint": "https://eus.codesigning.azure.net",
  "certificateProfileName": "your-profile",
  "codeSigningAccountName": "your-account"
}
```

**Never commit a certificate, password, or token.** `*.pfx`, `*.p12` and `.env`
are already gitignored.

### Verifying a signed build

```bash
powershell "Get-AuthenticodeSignature 'release\EaseCutPro-Setup-0.1.0.exe' | Format-List Status, SignerCertificate"
```

`Status: Valid` and your name on the certificate means it worked. Until then it
reads `NotSigned`, which is the current state.

---

## 3. Publishing a release (turns auto-update on)

`build.publish` points at GitHub Releases for `tayz07814-ctrl/easecutpro`, and
the app checks that feed 15 s after launch and every 6 hours (`src/main/updater.ts`).

```bash
set GH_TOKEN=<a GitHub token with repo scope>
npm run dist -- --publish always
```

That uploads the installer plus `latest.yml` — **the feed file the updater
reads.** Without `latest.yml` in the release, auto-update silently does nothing.

Then, for each new version:

1. bump `version` in `package.json` (updates compare by version, so this is what
   actually triggers them)
2. `npm run dist -- --publish always`

Installed apps pick it up within hours, or on their next launch.

> The repo is **public**, so releases are publicly downloadable. If you would
> rather gate downloads, switch `build.publish` to `generic` and host
> `latest.yml` + the installer on your own URL.

### A caveat worth knowing

electron-updater **requires the installer to be signed** for updates to install
on Windows — an unsigned update is downloaded and then rejected. So signing is
not optional if you want auto-update to actually work; do it first.

---

## 4. Order I would do this in

1. **Azure Trusted Signing** — unblocks both problems at once.
2. Sign a build and verify with `Get-AuthenticodeSignature`.
3. Publish `0.1.1` with `--publish always` and confirm `latest.yml` is in the release.
4. Install `0.1.0`, publish `0.1.2`, and confirm the running app offers the update.

Until step 1, expect SmartScreen warnings on every download, and treat
auto-update as configured-but-inert.
