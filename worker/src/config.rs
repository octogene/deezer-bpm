//! Environment-derived configuration and shared time constants.

use worker::{Env, Error, Result};

pub(crate) const MILLIS_PER_DAY: u64 = 86_400_000;
pub(crate) const SECONDS_PER_DAY: i64 = 86_400;

#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) max_changes: usize,
    pub(crate) max_delta_rows: usize,
    pub(crate) max_tracks_per_space: i32,
    pub(crate) max_track_id_length: usize,
    pub(crate) daily_requests: u64,
    pub(crate) daily_creations: u64,
    pub(crate) daily_read_rows: u64,
    pub(crate) daily_write_rows: u64,
}

impl Limits {
    pub(crate) fn from_env(env: &Env) -> Result<Self> {
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

pub(crate) fn env_usize(env: &Env, name: &str) -> Result<usize> {
    env.var(name)?
        .to_string()
        .parse()
        .map_err(|_| Error::RustError(format!("invalid {name} binding")))
}

pub(crate) fn env_i32(env: &Env, name: &str) -> Result<i32> {
    env.var(name)?
        .to_string()
        .parse()
        .map_err(|_| Error::RustError(format!("invalid {name} binding")))
}

pub(crate) fn env_i64(env: &Env, name: &str) -> Result<i64> {
    env.var(name)?
        .to_string()
        .parse()
        .map_err(|_| Error::RustError(format!("invalid {name} binding")))
}

pub(crate) fn env_u64(env: &Env, name: &str) -> Result<u64> {
    env.var(name)?
        .to_string()
        .parse()
        .map_err(|_| Error::RustError(format!("invalid {name} binding")))
}
