//! Cloudflare Worker that synchronizes manual BPM overrides through D1.

use std::collections::HashSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use worker::d1::{D1Database, D1Type};
use worker::wasm_bindgen::JsValue;
use worker::*;

const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_CREATE_BODY_BYTES: usize = 16 * 1024;
const MAX_CURSOR_BYTES: usize = 256;
const RATE_LIMIT_RETRY_SECONDS: u32 = 60;
const MILLIS_PER_DAY: u64 = 86_400_000;
const SECONDS_PER_DAY: i64 = 86_400;
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_CHAR_COUNT: usize = 25;
const BUDGET_OBJECT_NAME: &str = "account";

const IP_LIMITER: &str = "IP_RATE_LIMITER";
const CODE_LIMITER: &str = "CODE_RATE_LIMITER";
const CREATE_LIMITER: &str = "CREATE_RATE_LIMITER";
const GLOBAL_LIMITER: &str = "GLOBAL_RATE_LIMITER";
const BUDGET_BINDING: &str = "SAFETY_BUDGET";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncRequest {
    base_revision: i32,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    changes: Vec<ClientChange>,
    through_revision: Option<i32>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientChange {
    track_id: String,
    bpm: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    turnstile_token: String,
}

#[derive(Debug, Deserialize)]
struct SpaceRow {
    revision: i32,
}

#[derive(Debug, Deserialize)]
struct CountRow {
    count: i32,
}

#[derive(Debug, Deserialize)]
struct StoredChange {
    track_id: String,
    bpm: Option<i32>,
    deleted: i32,
    revision: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerChange {
    track_id: String,
    bpm: Option<i32>,
    revision: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncResponse {
    revision: i32,
    through_revision: i32,
    changes: Vec<ServerChange>,
    next_cursor: Option<String>,
    /// True when the submitted changes were skipped because the space is at its
    /// row cap. Reads still succeed so a full space can keep pulling.
    capacity_exceeded: bool,
}

#[derive(Debug, Serialize)]
struct CreateResponse {
    code: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    code: &'a str,
}

#[derive(Debug, Serialize, Deserialize)]
struct Cursor {
    base_revision: i32,
    through_revision: i32,
    last_revision: i32,
    last_track_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Admission {
    kind: AdmissionKind,
    read_rows: u64,
    write_rows: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum AdmissionKind {
    Sync,
    Create,
    /// Records D1 rows that were actually read after the fact. Settlements never
    /// count a request and are never rejected: the work already happened, so
    /// refusing one would lose the accounting without undoing the cost.
    Settlement,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct BudgetState {
    day: u64,
    requests: u64,
    creations: u64,
    read_rows: u64,
    write_rows: u64,
}

#[derive(Debug, Deserialize)]
struct TurnstileResponse {
    success: bool,
}

#[derive(Clone, Copy)]
struct Limits {
    max_changes: usize,
    max_delta_rows: usize,
    max_tracks_per_space: i32,
    max_track_id_length: usize,
    daily_requests: u64,
    daily_creations: u64,
    daily_read_rows: u64,
    daily_write_rows: u64,
}

#[durable_object(fetch)]
pub struct SafetyBudget {
    state: State,
    env: Env,
}

impl DurableObject for SafetyBudget {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let admission: Admission = req.json().await?;
        let limits = Limits::from_env(&self.env)?;
        let day = Date::now().as_millis() / MILLIS_PER_DAY;
        let storage = self.state.storage();
        let mut budget = storage
            .get::<BudgetState>("budget")
            .await?
            .unwrap_or_default();

        if budget.day != day {
            budget = BudgetState {
                day,
                ..BudgetState::default()
            };
        }

        let settlement = admission.kind == AdmissionKind::Settlement;
        let requests = budget.requests.saturating_add(u64::from(!settlement));
        let creations = budget
            .creations
            .saturating_add(u64::from(admission.kind == AdmissionKind::Create));
        let read_rows = budget.read_rows.saturating_add(admission.read_rows);
        let write_rows = budget.write_rows.saturating_add(admission.write_rows);

        if !settlement
            && (requests > limits.daily_requests
                || creations > limits.daily_creations
                || read_rows > limits.daily_read_rows
                || write_rows > limits.daily_write_rows)
        {
            return Response::error("daily safety budget exhausted", 503);
        }

        budget.requests = requests;
        budget.creations = creations;
        budget.read_rows = read_rows;
        budget.write_rows = write_rows;
        storage.put("budget", budget).await?;

        Response::ok("admitted")
    }
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, ctx: Context) -> Result<Response> {
    if req.method() == Method::Options {
        return with_cors(Response::empty()?.with_status(204));
    }

    match (req.method(), req.path().as_str()) {
        (Method::Get, "/activate") => {
            // Cheap to serve, but it is still a public route: keep it behind the
            // same edge limiters as the POST endpoints.
            if !apply_common_limits(&req, &env).await? {
                return rate_limited();
            }
            activation_page(&env)
        }
        (Method::Post, "/spaces") => create_space(&mut req, &env).await,
        (Method::Post, "/sync") => sync(&mut req, &env, &ctx).await,
        _ => with_cors(json_error("not found", "not_found", 404)?),
    }
}

#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    if let Err(error) = cleanup(&env).await {
        console_error!("sync-space cleanup failed: {error}");
    }
}

async fn create_space(req: &mut Request, env: &Env) -> Result<Response> {
    if !apply_common_limits(req, env).await? {
        return rate_limited();
    }

    let client_ip = client_ip(req)?;
    if !apply_limit(env, CREATE_LIMITER, &client_ip).await? {
        return rate_limited();
    }

    if content_length(req) > MAX_CREATE_BODY_BYTES {
        return with_cors(json_error("payload too large", "payload_too_large", 413)?);
    }

    let body = req.bytes().await?;
    if body.len() > MAX_CREATE_BODY_BYTES {
        return with_cors(json_error("payload too large", "payload_too_large", 413)?);
    }

    let payload: CreateRequest = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => return with_cors(json_error("invalid JSON body", "invalid_json", 400)?),
    };

    if payload.turnstile_token.is_empty() || payload.turnstile_token.len() > 4096 {
        return with_cors(json_error(
            "invalid challenge token",
            "invalid_challenge",
            400,
        )?);
    }

    if !verify_turnstile(env, &payload.turnstile_token, &client_ip).await? {
        return with_cors(json_error(
            "challenge verification failed",
            "invalid_challenge",
            403,
        )?);
    }

    if !admit(
        env,
        Admission {
            kind: AdmissionKind::Create,
            read_rows: 1,
            write_rows: 1,
        },
    )
    .await?
    {
        return budget_exhausted();
    }

    let code = generate_code()?;
    let hash = sync_hash(&code);
    let now = (Date::now().as_millis() / 1000) as i64;
    let args = [
        D1Type::Text(&hash),
        D1Type::Integer(i32::try_from(now).unwrap_or(i32::MAX)),
    ];
    env.d1("DB")?
        .prepare(
            "INSERT INTO sync_spaces
             (sync_hash, revision, created_at, last_active_at, track_count, active)
             VALUES (?1, 0, ?2, ?2, 0, 1)",
        )
        .bind_refs(&args)?
        .run()
        .await?;

    with_cors(Response::from_json(&CreateResponse { code })?)
}

/// Everything a `/sync` request needs after validation, so the individual
/// stages do not each take six positional arguments.
struct SyncScope<'a> {
    env: &'a Env,
    ctx: &'a Context,
    db: D1Database,
    hash: String,
    limits: Limits,
}

impl SyncScope<'_> {
    /// Record rows that were actually read, after the response is built.
    ///
    /// The pre-request admission only reserves the cost of the space lookup and
    /// the incoming change probe, so a request for an unknown code cannot burn a
    /// whole page of the daily read budget. This settles the real cost of the
    /// delta query afterwards, off the response path, so the budget stays
    /// accurate without adding latency or a second blocking round-trip.
    fn settle_read_rows(&self, rows: u64) {
        if rows == 0 {
            return;
        }
        let env = self.env.clone();
        self.ctx.wait_until(async move {
            let admission = Admission {
                kind: AdmissionKind::Settlement,
                read_rows: rows,
                write_rows: 0,
            };
            if let Err(error) = admit(&env, admission).await {
                console_error!("safety budget settlement failed: {error}");
            }
        });
    }
}

async fn sync(req: &mut Request, env: &Env, ctx: &Context) -> Result<Response> {
    if !apply_common_limits(req, env).await? {
        return rate_limited();
    }

    if content_length(req) > MAX_BODY_BYTES {
        return with_cors(json_error("payload too large", "payload_too_large", 413)?);
    }

    let code = req.headers().get("X-Sync-Code")?.unwrap_or_default();
    if !valid_code(&code) {
        return with_cors(json_error("invalid sync code", "invalid_sync_code", 400)?);
    }

    let hash = sync_hash(&code);
    if !apply_limit(env, CODE_LIMITER, &hash).await? {
        return rate_limited();
    }

    let body = req.bytes().await?;
    if body.len() > MAX_BODY_BYTES {
        return with_cors(json_error("payload too large", "payload_too_large", 413)?);
    }

    let payload: SyncRequest = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => return with_cors(json_error("invalid JSON body", "invalid_json", 400)?),
    };
    let limits = Limits::from_env(env)?;
    if let Err(message) = validate_request(&payload, limits) {
        return with_cors(json_error(&message, "invalid_request", 400)?);
    }

    // Reserve only what is certain: the space lookup, plus one probe row per
    // incoming change for the eligibility join. The delta page is settled after
    // it is read. Reserving a worst-case page here would let a flood of requests
    // for non-existent codes close the breaker for every real user.
    let changes = payload.changes.len() as u64;
    if !admit(
        env,
        Admission {
            kind: AdmissionKind::Sync,
            read_rows: changes.saturating_add(1),
            write_rows: changes,
        },
    )
    .await?
    {
        return budget_exhausted();
    }

    let scope = SyncScope {
        env,
        ctx,
        db: env.d1("DB")?,
        hash,
        limits,
    };
    let space = match read_space(&scope.db, &scope.hash).await? {
        Some(space) => space,
        None => {
            return with_cors(json_error(
                "sync space not found",
                "sync_space_not_found",
                404,
            )?)
        }
    };

    if payload.base_revision > space.revision {
        return with_cors(json_error(
            "client revision is newer than this sync space",
            "revision_ahead",
            409,
        )?);
    }

    if let Some(cursor) = payload.cursor.as_deref() {
        return continue_sync(&scope, &payload, cursor, space).await;
    }

    start_sync(&scope, &payload, space).await
}

async fn start_sync(
    scope: &SyncScope<'_>,
    payload: &SyncRequest,
    space: SpaceRow,
) -> Result<Response> {
    let db = &scope.db;
    let hash = scope.hash.as_str();
    let limits = scope.limits;

    if payload.changes.is_empty() {
        return delta_response(scope, payload.base_revision, space.revision, None, false).await;
    }

    let changes_json = serde_json::to_string(&payload.changes)?;
    let capacity_check = rejected_capacity_statement(
        db,
        hash,
        &changes_json,
        payload.base_revision,
        payload.force,
        limits.max_tracks_per_space,
    )?;

    let upsert_args = [
        D1Type::Text(&changes_json),
        D1Type::Text(hash),
        D1Type::Boolean(payload.force),
        D1Type::Integer(payload.base_revision),
        D1Type::Integer(limits.max_tracks_per_space),
    ];
    let upsert = db
        .prepare(
            r#"
            WITH incoming AS (
              SELECT
                CAST(json_extract(value, '$.trackId') AS TEXT) AS track_id,
                CAST(json_extract(value, '$.bpm') AS INTEGER) AS bpm,
                CASE WHEN json_type(value, '$.bpm') = 'null' THEN 1 ELSE 0 END AS deleted
              FROM json_each(?1)
            ),
            eligible AS (
              SELECT
                incoming.track_id,
                incoming.bpm,
                incoming.deleted,
                CASE
                  WHEN incoming.deleted = 0 AND (current.track_id IS NULL OR current.deleted = 1)
                    THEN 1
                  ELSE 0
                END AS is_new
              FROM incoming
              LEFT JOIN overrides AS current
                ON current.sync_hash = ?2 AND current.track_id = incoming.track_id
              WHERE (?3 = 1 OR current.revision IS NULL OR current.revision <= ?4)
                AND (
                  current.track_id IS NULL
                  OR current.deleted != incoming.deleted
                  OR COALESCE(current.bpm, -1) != COALESCE(incoming.bpm, -1)
                )
            ),
            -- Brand-new tracks are admitted in track_id order, up to whatever
            -- room is left under the cap. Capacity-neutral changes (edits and
            -- deletes to tracks that already exist) never compete for that
            -- room, so they always go through below regardless of new_rank.
            ranked_new AS (
              SELECT
                track_id,
                bpm,
                deleted,
                ROW_NUMBER() OVER (ORDER BY track_id) AS new_rank
              FROM eligible
              WHERE is_new = 1
            ),
            admitted AS (
              SELECT track_id, bpm, deleted FROM eligible WHERE is_new = 0
              UNION ALL
              SELECT ranked_new.track_id, ranked_new.bpm, ranked_new.deleted
              FROM ranked_new
              JOIN sync_spaces AS space ON space.sync_hash = ?2
              WHERE space.track_count + ranked_new.new_rank <= ?5
            )
            INSERT INTO overrides (sync_hash, track_id, bpm, deleted, revision)
            SELECT
              ?2,
              admitted.track_id,
              CASE WHEN admitted.deleted = 1 THEN NULL ELSE admitted.bpm END,
              admitted.deleted,
              space.revision + 1
            FROM admitted
            JOIN sync_spaces AS space ON space.sync_hash = ?2
            ON CONFLICT(sync_hash, track_id) DO UPDATE SET
              bpm = excluded.bpm,
              deleted = excluded.deleted,
              revision = excluded.revision
            "#,
        )
        .bind_refs(&upsert_args)?;

    let hash_arg = D1Type::Text(hash);
    let advance = db
        .prepare(
            "UPDATE sync_spaces
             SET
               revision = revision + 1,
               track_count = (
                 SELECT COUNT(*) FROM overrides WHERE sync_hash = ?1 AND deleted = 0
               ),
               last_active_at = unixepoch()
             WHERE sync_hash = ?1
               AND EXISTS (
                 SELECT 1
                 FROM overrides
                 WHERE sync_hash = ?1 AND revision = sync_spaces.revision + 1
               )",
        )
        .bind_refs(&hash_arg)?;

    let revision = db
        .prepare("SELECT revision FROM sync_spaces WHERE sync_hash = ?1")
        .bind_refs(&hash_arg)?;

    // All four statements run inside one D1 batch transaction, so
    // capacity_check and the upsert's own ranked_new/admitted CTEs see an
    // identical, unchanging snapshot of track_count and the existing rows --
    // unlike a separate pre-batch check, this can't race against a
    // concurrent /sync request to the same space.
    let results = db
        .batch(vec![capacity_check, upsert, advance, revision])
        .await?;

    let rejected_count = results
        .first()
        .ok_or_else(|| Error::RustError("D1 capacity-check result missing".into()))?
        .results::<CountRow>()?
        .into_iter()
        .next()
        .map(|row| row.count)
        .unwrap_or(0);

    let through_revision = results
        .get(3)
        .ok_or_else(|| Error::RustError("D1 revision result missing".into()))?
        .results::<SpaceRow>()?
        .into_iter()
        .next()
        .map(|row| row.revision)
        .ok_or_else(|| Error::RustError("D1 sync space missing".into()))?;

    // The upsert admits every capacity-neutral change unconditionally and
    // only as many brand-new tracks as still fit under the cap, so a batch
    // that also carries an over-cap new track still gets everything else
    // applied instead of being dropped wholesale.
    let capacity_exceeded = rejected_count > 0;

    delta_response(
        scope,
        payload.base_revision,
        through_revision,
        None,
        capacity_exceeded,
    )
    .await
}

async fn continue_sync(
    scope: &SyncScope<'_>,
    payload: &SyncRequest,
    encoded_cursor: &str,
    space: SpaceRow,
) -> Result<Response> {
    let cursor = match decode_cursor(encoded_cursor) {
        Ok(cursor) => cursor,
        Err(_) => return with_cors(json_error("invalid cursor", "invalid_cursor", 400)?),
    };
    let through_revision = payload.through_revision.unwrap_or(-1);

    if cursor.base_revision != payload.base_revision
        || cursor.through_revision != through_revision
        || through_revision > space.revision
        || cursor.last_revision < payload.base_revision
        || cursor.last_revision > through_revision
    {
        return with_cors(json_error("invalid cursor", "invalid_cursor", 400)?);
    }

    delta_response(
        scope,
        payload.base_revision,
        through_revision,
        Some(cursor),
        false,
    )
    .await
}

async fn delta_response(
    scope: &SyncScope<'_>,
    base_revision: i32,
    through_revision: i32,
    cursor: Option<Cursor>,
    capacity_exceeded: bool,
) -> Result<Response> {
    let db = &scope.db;
    let hash = scope.hash.as_str();
    let page_size = scope.limits.max_delta_rows;
    let last_revision = cursor
        .as_ref()
        .map(|cursor| cursor.last_revision)
        .unwrap_or(base_revision);
    let last_track_id = cursor
        .as_ref()
        .map(|cursor| cursor.last_track_id.as_str())
        .unwrap_or("");
    let limit = i32::try_from(page_size.saturating_add(1))
        .map_err(|_| Error::RustError("delta page size is too large".into()))?;
    let args = [
        D1Type::Text(hash),
        D1Type::Integer(base_revision),
        D1Type::Integer(through_revision),
        D1Type::Integer(last_revision),
        D1Type::Text(last_track_id),
        D1Type::Integer(limit),
    ];
    let mut rows = db
        .prepare(
            "SELECT track_id, bpm, deleted, revision
             FROM overrides
             WHERE sync_hash = ?1
               AND revision > ?2
               AND revision <= ?3
               AND (revision > ?4 OR (revision = ?4 AND track_id > ?5))
             ORDER BY revision, track_id
             LIMIT ?6",
        )
        .bind_refs(&args)?
        .all()
        .await?
        .results::<StoredChange>()?;

    scope.settle_read_rows(rows.len() as u64);

    let has_more = rows.len() > page_size;
    if has_more {
        rows.pop();
    }

    let next_cursor = if has_more {
        let last = rows
            .last()
            .ok_or_else(|| Error::RustError("empty paginated delta".into()))?;
        Some(encode_cursor(&Cursor {
            base_revision,
            through_revision,
            last_revision: last.revision,
            last_track_id: last.track_id.clone(),
        })?)
    } else {
        None
    };

    let changes = rows
        .into_iter()
        .map(|row| ServerChange {
            track_id: row.track_id,
            bpm: if row.deleted == 1 { None } else { row.bpm },
            revision: row.revision,
        })
        .collect();

    with_cors(Response::from_json(&SyncResponse {
        revision: through_revision,
        through_revision,
        changes,
        next_cursor,
        capacity_exceeded,
    })?)
}

async fn read_space(db: &D1Database, hash: &str) -> Result<Option<SpaceRow>> {
    let arg = D1Type::Text(hash);
    db.prepare(
        "SELECT revision
         FROM sync_spaces
         WHERE sync_hash = ?1 AND active = 1",
    )
    .bind_refs(&arg)?
    .first::<SpaceRow>(None)
    .await
}

// Builds (without executing) a read-only query counting how many of this
// batch's eligible new tracks will NOT fit under the space's cap, using the
// exact same track_id-ordered ranking the upsert's own ranked_new/admitted
// CTEs apply. Callers run this in the same D1 batch/transaction as the
// upsert, so the two see an identical snapshot and can never disagree about
// which new tracks get admitted.
fn rejected_capacity_statement(
    db: &D1Database,
    hash: &str,
    changes_json: &str,
    base_revision: i32,
    force: bool,
    max_tracks_per_space: i32,
) -> Result<D1PreparedStatement> {
    let args = [
        D1Type::Text(changes_json),
        D1Type::Text(hash),
        D1Type::Boolean(force),
        D1Type::Integer(base_revision),
        D1Type::Integer(max_tracks_per_space),
    ];
    db.prepare(
        r#"
        WITH incoming AS (
          SELECT
            CAST(json_extract(value, '$.trackId') AS TEXT) AS track_id,
            CAST(json_extract(value, '$.bpm') AS INTEGER) AS bpm,
            CASE WHEN json_type(value, '$.bpm') = 'null' THEN 1 ELSE 0 END AS deleted
          FROM json_each(?1)
        ),
        eligible AS (
          SELECT
            incoming.track_id,
            CASE
              WHEN incoming.deleted = 0 AND (current.track_id IS NULL OR current.deleted = 1)
                THEN 1
              ELSE 0
            END AS is_new
          FROM incoming
          LEFT JOIN overrides AS current
            ON current.sync_hash = ?2 AND current.track_id = incoming.track_id
          WHERE (?3 = 1 OR current.revision IS NULL OR current.revision <= ?4)
            AND (
              current.track_id IS NULL
              OR current.deleted != incoming.deleted
              OR COALESCE(current.bpm, -1) != COALESCE(incoming.bpm, -1)
            )
        ),
        ranked_new AS (
          SELECT ROW_NUMBER() OVER (ORDER BY track_id) AS new_rank
          FROM eligible
          WHERE is_new = 1
        )
        SELECT COUNT(*) AS count
        FROM ranked_new
        JOIN sync_spaces AS space ON space.sync_hash = ?2
        WHERE space.track_count + ranked_new.new_rank > ?5
        "#,
    )
    .bind_refs(&args)
}

async fn apply_common_limits(req: &Request, env: &Env) -> Result<bool> {
    if !apply_limit(env, GLOBAL_LIMITER, "all").await? {
        return Ok(false);
    }
    apply_limit(env, IP_LIMITER, &client_ip(req)?).await
}

async fn apply_limit(env: &Env, binding: &str, key: &str) -> Result<bool> {
    let result = env.rate_limiter(binding)?.limit(key.to_string()).await?;
    Ok(result.success)
}

async fn admit(env: &Env, admission: Admission) -> Result<bool> {
    let namespace = env.durable_object(BUDGET_BINDING)?;
    let stub = namespace.get_by_name(BUDGET_OBJECT_NAME)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_body(Some(JsValue::from_str(&serde_json::to_string(&admission)?)));
    init.headers.set("Content-Type", "application/json")?;
    let request = Request::new_with_init("https://budget/admit", &init)?;
    let response = stub.fetch_with_request(request).await?;

    if response.status_code() == 503 {
        return Ok(false);
    }
    if response.status_code() >= 400 {
        return Err(Error::RustError("safety budget request failed".into()));
    }

    Ok(true)
}

async fn verify_turnstile(env: &Env, token: &str, client_ip: &str) -> Result<bool> {
    let secret = env.secret("TURNSTILE_SECRET_KEY")?.to_string();
    let body = format!(
        "secret={}&response={}&remoteip={}",
        urlencoding::encode(&secret),
        urlencoding::encode(token),
        urlencoding::encode(client_ip)
    );
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_body(Some(JsValue::from_str(&body)));
    init.headers
        .set("Content-Type", "application/x-www-form-urlencoded")?;
    let request = Request::new_with_init(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        &init,
    )?;
    let mut response = Fetch::Request(request).send().await?;

    if !(200..300).contains(&response.status_code()) {
        return Ok(false);
    }

    Ok(response.json::<TurnstileResponse>().await?.success)
}

async fn cleanup(env: &Env) -> Result<()> {
    let empty_days = env_i64(env, "EMPTY_SPACE_RETENTION_DAYS")?;
    let inactive_days = env_i64(env, "INACTIVE_SPACE_RETENTION_DAYS")?;
    let batch_size = env_i32(env, "CLEANUP_BATCH_SIZE")?;
    let args = [
        D1Type::Integer(i32::try_from(empty_days * SECONDS_PER_DAY).unwrap_or(i32::MAX)),
        D1Type::Integer(i32::try_from(inactive_days * SECONDS_PER_DAY).unwrap_or(i32::MAX)),
        D1Type::Integer(batch_size),
    ];
    env.d1("DB")?
        .prepare(
            // `active = 1` is redundant today but lets SQLite drive the scan and
            // the ORDER BY from sync_spaces_by_activity(active, last_active_at)
            // instead of sorting the whole table every night.
            // Override rows are removed by the ON DELETE CASCADE on
            // overrides.sync_hash.
            "DELETE FROM sync_spaces
             WHERE sync_hash IN (
               SELECT sync_hash
               FROM sync_spaces
               WHERE active = 1
                 AND (
                   (track_count = 0 AND created_at < unixepoch() - ?1)
                   OR last_active_at < unixepoch() - ?2
                 )
               ORDER BY last_active_at
               LIMIT ?3
             )",
        )
        .bind_refs(&args)?
        .run()
        .await?;
    Ok(())
}

fn validate_request(payload: &SyncRequest, limits: Limits) -> std::result::Result<(), String> {
    if payload.base_revision < 0 {
        return Err("baseRevision must be non-negative".into());
    }
    if payload.changes.len() > limits.max_changes {
        return Err(format!("too many changes (max {})", limits.max_changes));
    }
    if payload
        .cursor
        .as_ref()
        .is_some_and(|cursor| cursor.len() > MAX_CURSOR_BYTES)
    {
        return Err("cursor is too long".into());
    }
    if payload.cursor.is_some() && payload.through_revision.is_none() {
        return Err("continuation requests must repeat throughRevision".into());
    }
    if payload.cursor.is_some() && (!payload.changes.is_empty() || payload.force) {
        return Err("continuation requests cannot upload changes".into());
    }
    if payload.cursor.is_none() && payload.through_revision.is_some() {
        return Err("throughRevision requires a cursor".into());
    }

    let mut ids = HashSet::with_capacity(payload.changes.len());
    for change in &payload.changes {
        if !valid_track_id(&change.track_id, limits.max_track_id_length) {
            return Err(format!("invalid trackId: {}", change.track_id));
        }
        if let Some(bpm) = change.bpm {
            if !(1..=999).contains(&bpm) {
                return Err(format!("invalid BPM for track {}", change.track_id));
            }
        }
        if !ids.insert(&change.track_id) {
            return Err(format!("duplicate trackId: {}", change.track_id));
        }
    }
    Ok(())
}

fn valid_track_id(id: &str, max_length: usize) -> bool {
    !id.is_empty() && id.len() <= max_length && id.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_code(code: &str) -> bool {
    let len = code.len();
    (16..=128).contains(&len)
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn generate_code() -> Result<String> {
    let mut bytes = [0_u8; CODE_CHAR_COUNT];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| Error::RustError(format!("random code generation failed: {error}")))?;
    let mut code = String::with_capacity(CODE_CHAR_COUNT + 4);

    for (index, byte) in bytes.into_iter().enumerate() {
        if index > 0 && index % 5 == 0 {
            code.push('-');
        }
        code.push(CODE_ALPHABET[(byte & 31) as usize] as char);
    }

    Ok(code)
}

fn sync_hash(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn encode_cursor(cursor: &Cursor) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor)?))
}

fn decode_cursor(encoded: &str) -> std::result::Result<Cursor, ()> {
    if encoded.len() > MAX_CURSOR_BYTES {
        return Err(());
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| ())?;
    serde_json::from_slice(&bytes).map_err(|_| ())
}

fn client_ip(req: &Request) -> Result<String> {
    Ok(req
        .headers()
        .get("CF-Connecting-IP")?
        .unwrap_or_else(|| "local-development".into()))
}

fn content_length(req: &Request) -> usize {
    req.headers()
        .get("Content-Length")
        .ok()
        .flatten()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn activation_page(env: &Env) -> Result<Response> {
    let site_key = env.var("TURNSTILE_SITE_KEY")?.to_string();
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Create Deezer BPM sync code</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    body {{ max-width: 34rem; margin: 4rem auto; padding: 0 1rem; color: #eee;
      background: #0f0f1a; font: 16px system-ui, sans-serif; }}
    main {{ padding: 2rem; border: 1px solid #2a2a44; border-radius: 12px;
      background: #1a1a2e; }}
    button, input {{ width: 100%; box-sizing: border-box; padding: .8rem; margin-top: 1rem; }}
    button {{ color: white; background: #7b2cbf; border: 0; border-radius: 8px; }}
    .cf-turnstile {{ display: flex; justify-content: center; margin-top: 1rem; }}
    code {{ display: block; margin-top: 1rem; padding: 1rem; border: 1px solid #2a2a44;
      border-radius: 8px; background: #0f0f1a; color: #c9a7ff; text-align: center;
      font: 1.1rem ui-monospace, monospace; letter-spacing: .08em; word-break: break-all; }}
    /* The display rule above outranks the UA stylesheet, so hidden needs saying twice. */
    code[hidden] {{ display: none; }}
  </style>
</head>
<body>
<main>
  <h1>Create a sync code</h1>
  <p>Complete the check, then copy the code into the extension.</p>
  <div class="cf-turnstile" data-sitekey="{site_key}"></div>
  <button id="create" type="button">Create code</button>
  <p id="status"></p>
  <code id="code" hidden></code>
  <button id="copy" type="button" hidden>Copy code</button>
</main>
<script>
const status = document.getElementById("status");
const codeBox = document.getElementById("code");
const copyBtn = document.getElementById("copy");
let created = "";

document.getElementById("create").addEventListener("click", async () => {{
  const token = document.querySelector('[name="cf-turnstile-response"]')?.value;
  if (!token) {{ status.textContent = "Complete the check first."; return; }}
  status.textContent = "Creating…";
  let response, data;
  try {{
    response = await fetch("/spaces", {{
      method: "POST",
      headers: {{ "Content-Type": "application/json" }},
      body: JSON.stringify({{ turnstileToken: token }})
    }});
    data = await response.json();
  }} catch (error) {{
    status.textContent = "Network error. Try again.";
    return;
  }}
  if (!response.ok) {{ status.textContent = data.error || "Creation failed."; return; }}

  created = data.code;
  status.textContent = "Copy this code into the extension:";
  codeBox.textContent = created;
  codeBox.hidden = false;
  copyBtn.hidden = false;
}});

copyBtn.addEventListener("click", async () => {{
  try {{
    await navigator.clipboard.writeText(created);
    copyBtn.textContent = "Copied";
  }} catch (error) {{
    copyBtn.textContent = "Select the code and press Ctrl+C";
  }}
}});
</script>
</body>
</html>"#
    );
    let mut response = Response::from_html(html)?;
    let headers = response.headers_mut();
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'unsafe-inline'")?;
    headers.set("Cache-Control", "no-store")?;
    headers.set("Referrer-Policy", "no-referrer")?;
    Ok(response)
}

fn with_cors(mut response: Response) -> Result<Response> {
    let headers = response.headers_mut();
    headers.set("Cache-Control", "no-store")?;
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "X-Sync-Code, Content-Type")?;
    // Retry-After is not a CORS-safelisted response header. Extension fetches
    // bypass CORS through host_permissions, but exposing it keeps the throttling
    // hint readable from any other caller too.
    headers.set("Access-Control-Expose-Headers", "Retry-After")?;
    headers.set("Access-Control-Max-Age", "86400")?;
    Ok(response)
}

fn json_error(message: &str, code: &str, status: u16) -> Result<Response> {
    let mut response = Response::from_json(&ErrorBody {
        error: message,
        code,
    })?
    .with_status(status);
    let retry_after = match status {
        429 => Some(RATE_LIMIT_RETRY_SECONDS),
        // The daily counters only reset at UTC midnight, so retrying sooner is
        // guaranteed to fail.
        503 => Some(seconds_until_utc_midnight()),
        _ => None,
    };
    if let Some(seconds) = retry_after {
        response
            .headers_mut()
            .set("Retry-After", &seconds.to_string())?;
    }
    Ok(response)
}

fn rate_limited() -> Result<Response> {
    with_cors(json_error("rate limit exceeded", "rate_limited", 429)?)
}

fn budget_exhausted() -> Result<Response> {
    with_cors(json_error(
        "daily safety budget exhausted",
        "safety_budget_exhausted",
        503,
    )?)
}

/// Seconds until the safety budget's UTC-day counters reset.
fn seconds_until_utc_midnight() -> u32 {
    let elapsed = Date::now().as_millis() % MILLIS_PER_DAY;
    (((MILLIS_PER_DAY - elapsed) / 1000).max(1)) as u32
}

fn env_usize(env: &Env, name: &str) -> Result<usize> {
    env.var(name)?
        .to_string()
        .parse()
        .map_err(|_| Error::RustError(format!("invalid {name} binding")))
}

fn env_i32(env: &Env, name: &str) -> Result<i32> {
    env.var(name)?
        .to_string()
        .parse()
        .map_err(|_| Error::RustError(format!("invalid {name} binding")))
}

fn env_i64(env: &Env, name: &str) -> Result<i64> {
    env.var(name)?
        .to_string()
        .parse()
        .map_err(|_| Error::RustError(format!("invalid {name} binding")))
}

fn env_u64(env: &Env, name: &str) -> Result<u64> {
    env.var(name)?
        .to_string()
        .parse()
        .map_err(|_| Error::RustError(format!("invalid {name} binding")))
}

impl Limits {
    fn from_env(env: &Env) -> Result<Self> {
        Ok(Self {
            max_changes: env_usize(env, "MAX_CHANGES")?,
            max_delta_rows: env_usize(env, "MAX_DELTA_ROWS")?,
            max_tracks_per_space: env_i32(env, "MAX_TRACKS_PER_SPACE")?,
            max_track_id_length: env_usize(env, "MAX_TRACK_ID_LENGTH")?,
            daily_requests: env_u64(env, "DAILY_REQUEST_BUDGET")?,
            daily_creations: env_u64(env, "DAILY_CREATION_BUDGET")?,
            daily_read_rows: env_u64(env, "DAILY_READ_ROW_BUDGET")?,
            daily_write_rows: env_u64(env, "DAILY_WRITE_ROW_BUDGET")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> Limits {
        Limits {
            max_changes: 2,
            max_delta_rows: 2,
            max_tracks_per_space: 5,
            max_track_id_length: 4,
            daily_requests: 10,
            daily_creations: 2,
            daily_read_rows: 20,
            daily_write_rows: 10,
        }
    }

    #[test]
    fn validates_updates_and_tombstones() {
        let request = SyncRequest {
            base_revision: 4,
            force: false,
            changes: vec![
                ClientChange {
                    track_id: "123".into(),
                    bpm: Some(128),
                },
                ClientChange {
                    track_id: "456".into(),
                    bpm: None,
                },
            ],
            through_revision: None,
            cursor: None,
        };

        assert!(validate_request(&request, limits()).is_ok());
    }

    /// A request carrying `changes`, with cursor fields left empty.
    fn upload(changes: Vec<ClientChange>) -> SyncRequest {
        SyncRequest {
            base_revision: 0,
            force: false,
            changes,
            through_revision: None,
            cursor: None,
        }
    }

    fn change(track_id: &str, bpm: Option<i32>) -> ClientChange {
        ClientChange {
            track_id: track_id.into(),
            bpm,
        }
    }

    #[test]
    fn rejects_a_negative_base_revision() {
        let mut request = upload(vec![]);
        request.base_revision = -1;
        assert!(validate_request(&request, limits()).is_err());
    }

    #[test]
    fn rejects_more_changes_than_the_limit() {
        let over = upload(vec![
            change("1", Some(120)),
            change("2", Some(120)),
            change("3", Some(120)),
        ]);
        assert!(validate_request(&over, limits()).is_err());
    }

    #[test]
    fn rejects_invalid_track_ids_and_bpms() {
        for bad in [
            change("", Some(120)),
            change("abc", Some(120)),
            change("12345", Some(120)),
            change("1", Some(0)),
            change("1", Some(1000)),
            change("1", Some(-5)),
        ] {
            assert!(
                validate_request(&upload(vec![bad]), limits()).is_err(),
                "expected rejection"
            );
        }
    }

    #[test]
    fn rejects_duplicate_track_ids() {
        let request = upload(vec![change("1", Some(120)), change("1", Some(121))]);
        assert!(validate_request(&request, limits()).is_err());
    }

    #[test]
    fn rejects_limits_and_invalid_continuations() {
        // force + a cursor: a continuation must not carry a write.
        let forced = SyncRequest {
            base_revision: 0,
            force: true,
            changes: vec![],
            through_revision: Some(1),
            cursor: Some("cursor".into()),
        };
        assert!(validate_request(&forced, limits()).is_err());

        // A cursor without the pinned revision it was issued against.
        let unpinned = SyncRequest {
            cursor: Some("cursor".into()),
            ..upload(vec![])
        };
        assert!(validate_request(&unpinned, limits()).is_err());

        // throughRevision without a cursor.
        let stray = SyncRequest {
            through_revision: Some(3),
            ..upload(vec![])
        };
        assert!(validate_request(&stray, limits()).is_err());

        // Changes alongside a cursor.
        let smuggled = SyncRequest {
            changes: vec![change("1", Some(120))],
            through_revision: Some(1),
            cursor: Some("cursor".into()),
            ..upload(vec![])
        };
        assert!(validate_request(&smuggled, limits()).is_err());

        assert!(!valid_track_id("12345", 4));
        assert!(!valid_track_id("abc", 4));
    }

    #[test]
    fn accepts_a_well_formed_continuation() {
        let request = SyncRequest {
            base_revision: 2,
            force: false,
            changes: vec![],
            through_revision: Some(9),
            cursor: Some("abc".into()),
        };
        assert!(validate_request(&request, limits()).is_ok());
    }

    #[test]
    fn rejects_an_oversized_cursor() {
        let request = SyncRequest {
            through_revision: Some(1),
            cursor: Some("x".repeat(MAX_CURSOR_BYTES + 1)),
            ..upload(vec![])
        };
        assert!(validate_request(&request, limits()).is_err());
    }

    #[test]
    fn cursor_round_trip_keeps_snapshot() {
        let cursor = Cursor {
            base_revision: 3,
            through_revision: 8,
            last_revision: 6,
            last_track_id: "123".into(),
        };
        let encoded = encode_cursor(&cursor).unwrap();
        let decoded = decode_cursor(&encoded).unwrap();

        assert_eq!(decoded.base_revision, 3);
        assert_eq!(decoded.through_revision, 8);
        assert_eq!(decoded.last_revision, 6);
        assert_eq!(decoded.last_track_id, "123");
    }

    #[test]
    fn an_encoded_cursor_stays_within_the_size_cap() {
        // Worst case: saturated revisions and a maximum-length track ID.
        let cursor = Cursor {
            base_revision: i32::MAX,
            through_revision: i32::MAX,
            last_revision: i32::MAX,
            last_track_id: "9".repeat(20),
        };
        assert!(encode_cursor(&cursor).unwrap().len() <= MAX_CURSOR_BYTES);
    }

    #[test]
    fn decode_cursor_rejects_garbage() {
        assert!(decode_cursor("!!!not base64!!!").is_err());
        assert!(decode_cursor(&"x".repeat(MAX_CURSOR_BYTES + 1)).is_err());
        // Valid base64, but not a cursor.
        assert!(decode_cursor(&URL_SAFE_NO_PAD.encode("{\"nope\":1}")).is_err());
    }

    #[test]
    fn generated_codes_have_expected_shape() {
        let code = generate_code().unwrap();
        assert_eq!(code.len(), 29);
        assert!(valid_code(&code));
        assert_eq!(code.matches('-').count(), 4);
        assert!(code
            .bytes()
            .all(|byte| byte == b'-' || CODE_ALPHABET.contains(&byte)));
    }

    #[test]
    fn generated_codes_do_not_repeat() {
        let first = generate_code().unwrap();
        let second = generate_code().unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn valid_code_bounds_the_header_length() {
        assert!(!valid_code(""));
        assert!(!valid_code("SHORT"));
        assert!(!valid_code(&"A".repeat(129)));
        assert!(!valid_code("HAS SPACE AAAAAAA"));
        assert!(!valid_code("HAS_UNDERSCORE__A"));
        assert!(valid_code(&"A".repeat(16)));
        assert!(valid_code(&"A".repeat(128)));
    }

    #[test]
    fn hashing_a_code_is_stable_and_hides_the_input() {
        let hash = sync_hash("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2");
        assert_eq!(hash.len(), 64);
        assert_eq!(hash, sync_hash("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2"));
        assert_ne!(hash, sync_hash("ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ3"));
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
