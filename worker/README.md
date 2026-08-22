# Deezer BPM sync backend (Cloudflare Worker + D1)

This Worker synchronizes manual BPM overrides between browsers without accounts.
Each private sync code identifies one revisioned sync space in D1; only its
SHA-256 hash is stored.

## Protocol

`GET /activate` serves the Turnstile-protected code creation page.
`POST /spaces` verifies its challenge and creates a server-generated code.
Unknown codes are never created implicitly by `/sync`.

`POST /sync` requires an `X-Sync-Code` header and this JSON body:

```json
{
  "baseRevision": 4,
  "force": false,
  "changes": [
    { "trackId": "123", "bpm": 128 },
    { "trackId": "456", "bpm": null }
  ]
}
```

`bpm: null` is a deletion tombstone. The response contains a bounded page from a fixed revision snapshot:

```json
{
  "revision": 5,
  "throughRevision": 5,
  "changes": [
    { "trackId": "123", "bpm": 128, "revision": 5 },
    { "trackId": "456", "bpm": null, "revision": 5 }
  ],
  "nextCursor": null
}
```

When `nextCursor` is present, send it with the original `baseRevision`,
`throughRevision`, no changes, and `force: false`. The extension commits its new
baseline only after every page succeeds.

Normal requests apply only tracks that have not changed remotely since the
client's baseline. The extension detects same-track conflicts, keeps those local,
and excludes them from automatic synchronization. A user can explicitly send
them with `force: true`.

D1 executes each request as one transaction, so simultaneous browsers cannot
partially overwrite one another.

## Prerequisites

- A Cloudflare account with Workers and D1.
- A stable Rust toolchain.
- `rustup target add wasm32-unknown-unknown`.
- Wrangler (`npm install -g wrangler` or use `npx wrangler`).

## Deploy with Terraform

The Terraform configuration creates the D1 database, applies all SQL migrations,
uploads the Rust and WebAssembly modules, provisions the SQLite Durable Object
safety budget, configures rate limiting and cleanup, enables the `workers.dev`
endpoint, and deploys the new Worker version at 100%.

Create a Cloudflare API token with **Workers Scripts: Edit** and **D1: Edit**.
Create the R2 state bucket once, then generate an R2 API token scoped to that
bucket with **Object Read & Write** permission. R2 API tokens provide a separate
Access Key ID and Secret Access Key for the S3-compatible backend.

```sh
export CLOUDFLARE_API_TOKEN="..."
npx wrangler r2 bucket create deezer-bpm-terraform-state

cd worker
cargo install worker-build
worker-build --release

cd terraform
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example backend.hcl
# Set the account ID and Turnstile keys in terraform.tfvars.
# Replace the account ID in backend.hcl.
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."
terraform init -backend-config=backend.hcl
terraform apply
```

The build must run before `terraform plan` or `terraform apply` because Terraform
uploads `build/index.js` and `build/index_bg.wasm`. Re-run it before applying each
code update. The D1 migration step also uses the token through Wrangler without
writing it to Terraform configuration or state.

The defaults allow 20 requests/minute per IP, 30/minute per code, five code
creations/minute per IP, and 300 requests/minute per Cloudflare location.
Cloudflare's edge counters are permissive and location-local. The Durable Object
also enforces strict UTC-day admission budgets before D1.

After deployment, the endpoint is
`https://<worker_name>.<account_workers_subdomain>.workers.dev`. The release
workflow reads it after Terraform applies the deployment and injects it into
`SYNC_ENDPOINT` in `background.js` and `host_permissions` in `manifest.json`
before building the extension.

### Remote state

Terraform stores state in the `deezer-bpm-terraform-state` R2 bucket using its
S3-compatible API. Native S3 lock files prevent concurrent applies. Both
`backend.hcl` and local state files are ignored by Git.

For GitHub Actions, the included `deploy-worker.yml` workflow expects these
production environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`

The extension release workflow calls the deployment workflow first and only
builds the extension after deployment succeeds. The deployment workflow can
also be run manually. Configure required reviewers on the GitHub `production`
environment if deployments need approval. The workflow generates `backend.hcl`
on its ephemeral runner and never writes R2 credentials to the repository.

If local state already exists, migrate it with:

```sh
terraform init -migrate-state -backend-config=backend.hcl
```

## Deploy with Wrangler

```sh
cd worker
wrangler login
wrangler d1 create deezer-bpm-sync
```

Copy the returned database ID into `wrangler.toml`, replacing
`replace-with-d1-database-id`, then apply the schema and deploy:

```sh
wrangler d1 migrations apply DB --remote
wrangler deploy
```

Replace the local Turnstile test keys in `wrangler.toml` before a manual
production deployment.

Put the deployed URL in `SYNC_ENDPOINT` in `background.js` and in
`manifest.json` under `host_permissions`.

## Local testing

```sh
wrangler d1 migrations apply DB --local
wrangler dev
```

Open `http://localhost:8787/activate` to create a local test code, then use it
with `/sync`.

Run the Rust checks with:

```sh
cargo fmt --check
cargo test
```

## Migration from the experimental R2 backend

There is no server-side R2-to-D1 migration. Existing extension installations
start with revision `0` and upload their current local overrides on first sync.
If R2 contains the only surviving copy of some data, export it before switching
the endpoint and import it into an updated extension.

## Security and privacy

- The sync code is the only credential. Generated codes contain about 125 bits
  of randomness; anyone who obtains one can read and modify that sync space.
- Raw codes never enter D1 or URLs. D1 stores only their SHA-256 hashes.
- Track IDs and BPM values are not end-to-end encrypted; the Worker operator can
  inspect them.
- Request bodies are capped at 1 MiB and 500 changes by default.
- Responses are paginated, spaces are capped at 5,000 tracks, and track IDs are
  length-limited.
- Per-IP, per-code, creation, and endpoint-wide rate limits run before D1.
- A SQLite Durable Object protects conservative daily request and D1 budgets.
- Empty spaces expire after seven days; inactive spaces expire after 180 days.
- Free-plan limit exhaustion rejects requests instead of enabling paid overage.
