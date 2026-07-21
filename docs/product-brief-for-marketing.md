# EaseCutPro — Product Brief (for marketing/growth chats)

Paste this into a Claude chat as context, then ask Claude to act as your
marketing manager — planning launches, writing copy, positioning, pricing,
channel strategy, etc.

---

## What it is

**EaseCutPro** is a transcript-based video editor, Descript-style, that runs
**100% offline** and natively on Windows (cloud/web version also in progress
on Vercel + Supabase). It's aimed at solo creators, podcasters, and course
makers who want fast talking-head/podcast editing without cloud uploads or
per-minute transcription fees.

## Core features

- 🎙️ **Automatic transcription** with word-level timestamps, fully offline
  (via whisper.cpp)
- ✂️ **Edit by editing text** — select words/sentences in the transcript and
  delete them to cut the video
- 🔇 **One-click silence removal** — detect pauses, shorten or remove them
- 🎬 **3-track timeline** — base A-roll (derived automatically from the
  transcript edit) + 2 overlay/B-roll tracks, with magnet/snap, drag, split
- ⬆️ **Export to MP4** via ffmpeg

## Tech / trust angle

- Built with Electron + React + TypeScript, ffmpeg, whisper.cpp
- **Privacy/offline-first is a real differentiator**: no footage leaves the
  user's machine, unlike Descript/cloud competitors. This is a strong
  marketing angle for privacy-conscious creators, journalists, NDA'd
  corporate video, and anyone on a slow/metered connection.

## Business model

- Freemium via **Paddle** (Merchant of Record — handles global tax/card
  processing; payouts via Payoneer).
- Proposed Free vs Pro split:

  | | Free | Pro |
  |---|---|---|
  | Projects | 3 | Unlimited |
  | Transcription | 30 min/month | 10 hrs/month |
  | Core editing, silence removal, export | ✓ | ✓ |
  | Retake β / ProCut / AI overlays / Batch cleaner | — | ✓ |

- Target price point discussed: ~$12/mo, ~$96/yr annual.

## Current stage

- Working MVP (desktop, offline transcription + transcript-cut editing +
  export) — functional today.
- Cloud version (Vercel + Supabase + Paddle billing) is mid-build toward
  public launch; desktop app with license keys is a planned follow-up, not
  part of the first public launch.
- Not yet publicly launched — currently pre-launch / building toward a
  waitlist-driven launch.

## Audience / positioning candidates

- Podcasters and YouTubers doing talking-head edits (the classic
  Descript-style audience)
- Course creators / educators recording lots of raw footage
- Privacy-conscious creators (journalists, corporate, legal/medical) who
  can't upload footage to the cloud
- Budget-conscious creators who don't want per-minute cloud transcription
  fees

## What "managing marketing" should cover

When acting as marketing manager for EaseCutPro, help with things like:
- Waitlist → launch sequencing and messaging (announcements, reminders,
  launch-day posts)
- Landing page copy, hero messaging, feature/benefit framing
- Pricing/positioning vs. Descript, CapCut, Premiere, etc.
- Channel strategy (Reddit communities, YouTube/podcast creator Discords,
  Product Hunt, X/Twitter, newsletters)
- Content ideas that dogfood the product (e.g. a demo video cut in
  EaseCutPro itself)
- Conversion-moment copy (free → Pro upgrade prompts)
- Ongoing campaign/content calendar and iteration based on what's working

---

*Update this doc as the product/pricing/launch details change so marketing
context stays accurate.*
