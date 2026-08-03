# Upload gateway — deploy notes

Caps R2 **writes** at 200 per user per UTC day. Until it's deployed the app keeps
using presigned PUTs (now 60-second ones), so deploying is safe to do whenever.

## Why a Worker and not just a quota

The 100 GB storage cap can't see operations at all. Overwriting one key a million
times is storage-neutral — the quota stays at zero while the Class A bill runs.
And a presigned URL can't be made single-use, so rate-limiting the *minting*
doesn't bound writes either: one mint is unlimited replay until it expires.

The only place a per-write budget can be enforced is on the path of every write.
That's this.

## Deploy

```bash
cd worker
npm i -g wrangler        # or npx wrangler

# 1. point it at the real bucket
#    edit wrangler.toml -> bucket_name

# 2. shared secret — must be IDENTICAL to the edge function's R2_TICKET_SECRET
openssl rand -hex 32     # copy this
npx wrangler secret put TICKET_SECRET

# 3. ship it
npx wrangler deploy
```

Then tell the edge function where it lives (both required — if either is unset
the app silently keeps using presigned PUTs):

```bash
supabase secrets set R2_UPLOAD_WORKER=https://easecutpro-uploads.<subdomain>.workers.dev
supabase secrets set R2_TICKET_SECRET=<same hex string as above>
supabase functions deploy r2-sign
```

## Checks after deploying

- Upload a small file — should succeed.
- Upload a file >80 MB — should go multipart and still succeed.
- Watch `wrangler tail` for `daily_write_limit` to confirm the counter engages.

## Tuning

`DAILY_WRITE_LIMIT` in `wrangler.toml` (200). A 1 GB upload costs ~13 writes
(80 MB parts + one to open the multipart), so 200/day ≈ 15 GB of legitimate
uploading — generous for a real editor, worthless to an attacker: 200 writes a
day is roughly **$0.03 a month** at ~$4.50/million.

Change it with `npx wrangler deploy` (it's a var, not a secret).

## What is NOT here

- **Reads.** Still presigned GETs, 5-minute expiry. Class B is ~12× cheaper and
  R2 charges no egress, so read abuse is a rounding error by comparison.
- **The storage quota.** Still owned by `r2-sign` against the space's
  `quota_bytes`. Note that quota is still driven by a client-writable
  `media_bytes` column — worth moving to a server-owned ledger separately.
