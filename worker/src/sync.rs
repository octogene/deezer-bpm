//! The `/sync` endpoint: change upload, revision advance, and paginated deltas.

use serde::{Deserialize, Serialize};
use worker::d1::{D1Database, D1PreparedStatement, D1Type};
use worker::*;

use crate::codes::{sync_hash, valid_code};
use crate::config::Limits;
use crate::guards::{
    admit, apply_common_limits, apply_limit, Admission, AdmissionKind, CODE_LIMITER,
};
use crate::http::{budget_exhausted, content_length, json_error, rate_limited, with_cors};
use crate::validate::{decode_cursor, encode_cursor, validate_request, Cursor};

const MAX_BODY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncRequest {
    pub(crate) base_revision: i32,
    #[serde(default)]
    pub(crate) force: bool,
    #[serde(default)]
    pub(crate) changes: Vec<ClientChange>,
    pub(crate) through_revision: Option<i32>,
    pub(crate) cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientChange {
    pub(crate) track_id: String,
    pub(crate) bpm: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SpaceRow {
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

pub(crate) async fn sync(req: &mut Request, env: &Env, ctx: &Context) -> Result<Response> {
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
