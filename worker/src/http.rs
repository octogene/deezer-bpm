//! Response helpers (CORS, JSON errors) and small request accessors.

use serde::Serialize;
use worker::{Date, Request, Response, Result};

use crate::config::MILLIS_PER_DAY;

const RATE_LIMIT_RETRY_SECONDS: u32 = 60;

#[derive(Debug, Serialize)]
struct ErrorBody<'a> {
    error: &'a str,
    code: &'a str,
}

pub(crate) fn with_cors(mut response: Response) -> Result<Response> {
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

pub(crate) fn json_error(message: &str, code: &str, status: u16) -> Result<Response> {
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

pub(crate) fn rate_limited() -> Result<Response> {
    with_cors(json_error("rate limit exceeded", "rate_limited", 429)?)
}

pub(crate) fn budget_exhausted() -> Result<Response> {
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

pub(crate) fn client_ip(req: &Request) -> Result<String> {
    Ok(req
        .headers()
        .get("CF-Connecting-IP")?
        .unwrap_or_else(|| "local-development".into()))
}

pub(crate) fn content_length(req: &Request) -> usize {
    req.headers()
        .get("Content-Length")
        .ok()
        .flatten()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}
