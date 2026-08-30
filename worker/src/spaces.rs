//! Sync-space lifecycle: the `/spaces` creation endpoint and nightly cleanup.

use serde::{Deserialize, Serialize};
use worker::d1::D1Type;
use worker::wasm_bindgen::JsValue;
use worker::*;

use crate::codes::{generate_code, sync_hash};
use crate::config::{env_i32, env_i64, SECONDS_PER_DAY};
use crate::guards::{
    admit, apply_common_limits, apply_limit, Admission, AdmissionKind, CREATE_LIMITER,
};
use crate::http::{
    budget_exhausted, client_ip, content_length, json_error, rate_limited, with_cors,
};

const MAX_CREATE_BODY_BYTES: usize = 16 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateRequest {
    turnstile_token: String,
}

#[derive(Debug, Serialize)]
struct CreateResponse {
    code: String,
}

#[derive(Debug, Deserialize)]
struct TurnstileResponse {
    success: bool,
}

pub(crate) async fn create_space(req: &mut Request, env: &Env) -> Result<Response> {
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

pub(crate) async fn cleanup(env: &Env) -> Result<()> {
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
