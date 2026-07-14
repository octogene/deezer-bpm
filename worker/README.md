# Deezer BPM sync backend (Cloudflare Worker + R2)

This tiny Worker lets the extension sync a user's **manual BPM overrides** CSV
between browsers **without accounts**. Each user gets a random *sync code*; the
Worker stores their CSV in R2 under `SHA-256(code)`. Knowing the code lets you
read and write that one file; that's the whole auth model.

It is written in **Rust** ([`workers-rs`](https://github.com/cloudflare/workers-rs))
and compiled to WebAssembly.

## What it does

- `GET /csv` — header `X-Sync-Code`. Returns the stored CSV (200) with an
  `X-Updated-At` header (ms since epoch, R2's upload time), or `404` if none.
- `PUT /csv` — header `X-Sync-Code`, body = CSV (≤ 256 KB). **Validates** the CSV
  (see below), stores it, and returns `{ "updatedAt": <ms> }`.
- Any other path/method, a malformed code, or an invalid CSV is rejected.

### CSV validation

On `PUT` the body must match the extension's export format, or the request is
rejected with `400 invalid CSV: …`:

- an optional leading `#` comment line,
- a `track_id,bpm` header row,
- then rows of `<digits>,<bpm>` where `bpm` is an integer in `1..=999`.

Zero data rows is allowed (a user may have cleared all their overrides). This
guarantees only well-formed override files ever land in R2.

## Prerequisites

- A stable Rust toolchain (via [rustup](https://rustup.rs)).
- The wasm target: `rustup target add wasm32-unknown-unknown`.
- `worker-build` is installed automatically by the `[build]` command in
  `wrangler.toml`; no manual step needed.

## Deploy (once)

```sh
cd worker
npm install -g wrangler         # or: npx wrangler ...
wrangler login
wrangler r2 bucket create deezer-bpm-sync
wrangler deploy                 # runs `worker-build --release`, then uploads
```

`wrangler deploy` prints the Worker URL, e.g.
`https://deezer-bpm-sync.<your-subdomain>.workers.dev`.

### Point the extension at your Worker

Put that URL in **two** places (they must match), then reload/repackage:

1. `SYNC_ENDPOINT` in `background.js` and `popup/popup.js`.
2. `host_permissions` in `manifest.json`
   (`"https://deezer-bpm-sync.<your-subdomain>.workers.dev/*"`).

## Local testing

```sh
wrangler dev   # compiles the Rust crate to wasm, then serves it
# store
curl -X PUT localhost:8787/csv -H 'X-Sync-Code: testtesttesttest' \
  --data $'# Deezer BPM manual overrides; format=1\r\ntrack_id,bpm\r\n123,128\r\n'
# read back
curl -i localhost:8787/csv -H 'X-Sync-Code: testtesttesttest'
# a different code sees nothing
curl -i localhost:8787/csv -H 'X-Sync-Code: someoneelsecode1'   # -> 404
# a malformed CSV is rejected
curl -i -X PUT localhost:8787/csv -H 'X-Sync-Code: testtesttesttest' \
  --data $'track_id,bpm\r\n123,2000\r\n'                          # -> 400
```

## Security notes / tradeoffs

- **No encryption.** The CSV is stored as-is, so whoever operates this Worker/R2
  (you) can read every user's overrides. The data is low-sensitivity
  (`track_id,bpm`), which is why this was accepted.
- **The sync code is the only secret.** It's 160 bits of CSPRNG randomness, so it
  can't be guessed. Anyone who obtains a user's code can read/write that user's
  file — treat it like a password. Losing it means losing access to the synced copy.
- **Codes never appear in URLs**, only in the `X-Sync-Code` header, so they don't
  leak into request logs.
- **Abuse limits:** body is capped at 256 KB and the code shape is validated. For
  extra protection add a Cloudflare **Rate Limiting** rule on the Worker route
  (dashboard → Security → WAF/Rate limiting); the Worker itself is stateless.
