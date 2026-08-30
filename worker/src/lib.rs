//! Cloudflare Worker that synchronizes manual BPM overrides through D1.
//!
//! - [`sync`] — the `/sync` endpoint: change upload and paginated deltas.
//! - [`spaces`] — `/spaces` creation and the nightly retention cleanup.
//! - [`activate`] — the `/activate` page serving the code-creation form.
//! - [`guards`] — edge rate limiters and the daily safety budget.
//! - [`codes`], [`validate`], [`config`], [`http`] — supporting pieces.

mod activate;
mod codes;
mod config;
mod guards;
mod http;
mod spaces;
mod sync;
mod validate;

use worker::*;

use crate::http::{json_error, rate_limited, with_cors};

pub use crate::guards::SafetyBudget;

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, ctx: Context) -> Result<Response> {
    if req.method() == Method::Options {
        return with_cors(Response::empty()?.with_status(204));
    }

    match (req.method(), req.path().as_str()) {
        (Method::Get, "/activate") => {
            // Cheap to serve, but it is still a public route: keep it behind the
            // same edge limiters as the POST endpoints.
            if !guards::apply_common_limits(&req, &env).await? {
                return rate_limited();
            }
            activate::activation_page(&env)
        }
        (Method::Post, "/spaces") => spaces::create_space(&mut req, &env).await,
        (Method::Post, "/sync") => sync::sync(&mut req, &env, &ctx).await,
        _ => with_cors(json_error("not found", "not_found", 404)?),
    }
}

#[event(scheduled)]
async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    if let Err(error) = spaces::cleanup(&env).await {
        console_error!("sync-space cleanup failed: {error}");
    }
}
