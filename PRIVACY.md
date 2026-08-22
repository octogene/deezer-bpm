# Privacy Policy — Deezer BPM

**Last updated:** 2026-08-22

Deezer BPM is a browser extension that shows the BPM of tracks on
[deezer.com](https://www.deezer.com) and lets you save your own BPM values for
tracks Deezer doesn't have data for. This page explains what data the
extension handles, where it goes, and why.

There is no user account, no analytics, no advertising, and no tracking of
any kind. The sections below cover everything the extension sends off your
device.

## Summary

| Data                                         | Leaves your device?                 | Where it goes                                          | Why                                                    |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------ |
| Manual BPM overrides (track ID + BPM)        | Only if you turn on **Online sync** | Our sync server (Cloudflare)                           | Let you reuse your overrides on another browser/device |
| Track/artist titles you're viewing on Deezer | Yes, always                         | Deezer's public API (`api.deezer.com`)                 | Look up the track's BPM and metadata                   |
| Your IP address                              | Only when creating a new sync code  | Cloudflare (Turnstile anti-abuse check, rate limiting) | Prevent spam/abuse of the sync service                 |

Nothing above is sold, shared with advertisers, or used to build a profile of
you.

## Data stored only on your device

Your manual BPM overrides are saved in your browser's local extension
storage (`storage.local`). This never leaves your device unless you
explicitly enable the sync feature described below. Uninstalling the
extension, or clearing its storage, deletes this data.

## Requests to Deezer's own API

To show BPM and track information, the extension makes requests directly
from your browser to Deezer's public API (`api.deezer.com`) — for example to
look up a track by ID or search by title and artist. These requests go
straight from your browser to Deezer, not through any server we operate, and
are governed by [Deezer's own privacy policy](https://www.deezer.com/legal/personal-datas).
We don't see or log this traffic.

## Optional sync feature

Sync is off by default. If you turn it on, here's exactly what happens:

- **Creating a sync code**: the extension opens an activation page served by
  our Cloudflare Worker, which asks you to complete a Cloudflare Turnstile
  challenge (a CAPTCHA alternative) before it will generate a code. Your IP
  address is sent to Cloudflare as part of that challenge and as part of
  standard abuse-prevention rate limiting on this step. We don't store your
  IP address ourselves — Cloudflare's rate limiter only keeps short-lived
  counters, and Turnstile verification is handled entirely by Cloudflare per
  its own privacy terms.
- **The sync code itself** is a random string generated on the server (125
  bits of randomness) — it is not derived from anything about you, and we
  never ask for a name, email, or any other identifying information to
  create or use one. Anyone who has the code can read and write the data
  under it, so treat it like a password: share it only between your own
  devices.
- **What gets synced**: once you paste a code into the extension on two or
  more browsers, each sync sends the track IDs and BPM values you've
  manually set to our server, and pulls back any changes made from your
  other devices. We store this as `(sync code hash, track ID, BPM value)` in
  a Cloudflare D1 database. The sync code is never stored in plain text —
  only its SHA-256 hash is kept, so we can't reverse it back to the code you
  were given.
- **Nothing else is sent.** No browsing history, no other Deezer activity,
  no device or account identifiers travel with a sync request beyond what's
  needed to apply the change (the track ID/BPM pairs and the code's hash).

### Data retention

- A sync code with no tracks saved under it is deleted after **7 days**.
- A sync code that hasn't been used to sync for **180 days** is deleted,
  along with everything stored under it.
- There is currently no self-service "delete my data now" button. If you
  want a sync code's data removed sooner, stop using it (it will expire per
  the schedule above) or [open an issue](https://github.com/octogene/deezer-bpm/issues)
  and we'll remove it manually.

### Infrastructure

The sync backend runs entirely on [Cloudflare](https://www.cloudflare.com/trust-hub/)
(Workers, D1 database, Turnstile, and rate limiting). Cloudflare acts as our
infrastructure provider and processes requests (including your IP address,
as any web request does) per its own privacy policy. We don't run our own
servers, and we don't have any other third-party processors.

## What we don't collect

- No accounts, sign-ups, names, or email addresses
- No analytics, telemetry, or crash reporting
- No advertising or ad tracking of any kind
- No browsing history beyond the individual Deezer page the extension is
  actively running on
- No selling or sharing of data with third parties for marketing purposes

## Permissions

The extension requests `storage` and `alarms` permissions (for saving your
overrides and running periodic auto-sync), and host permissions for
`deezer.com`, `api.deezer.com`, and our sync server's domain. It does not
request permission to read other websites or your general browsing activity.

## Changes to this policy

If what the extension collects or where it sends data changes, this file
will be updated and the change will be noted in the
[changelog](CHANGELOG.md).

## Contact

Questions or data-removal requests: open an issue at
[github.com/octogene/deezer-bpm](https://github.com/octogene/deezer-bpm/issues).
