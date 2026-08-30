//! The `/activate` page: a Turnstile-gated form for creating a sync code.

use worker::{Env, Response, Result};

pub(crate) fn activation_page(env: &Env) -> Result<Response> {
    let site_key = env.var("TURNSTILE_SITE_KEY")?.to_string();
    let html = include_str!("activate.html").replace("__TURNSTILE_SITE_KEY__", &site_key);
    let mut response = Response::from_html(html)?;
    let headers = response.headers_mut();
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'unsafe-inline'")?;
    headers.set("Cache-Control", "no-store")?;
    headers.set("Referrer-Policy", "no-referrer")?;
    Ok(response)
}
