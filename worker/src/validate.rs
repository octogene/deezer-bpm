//! `/sync` request validation and the pagination cursor format.

use std::collections::HashSet;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use worker::Result;

use crate::config::Limits;
use crate::sync::SyncRequest;

pub(crate) const MAX_CURSOR_BYTES: usize = 256;

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Cursor {
    pub(crate) base_revision: i32,
    pub(crate) through_revision: i32,
    pub(crate) last_revision: i32,
    pub(crate) last_track_id: String,
}

pub(crate) fn validate_request(
    payload: &SyncRequest,
    limits: Limits,
) -> std::result::Result<(), String> {
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

pub(crate) fn encode_cursor(cursor: &Cursor) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(cursor)?))
}

pub(crate) fn decode_cursor(encoded: &str) -> std::result::Result<Cursor, ()> {
    if encoded.len() > MAX_CURSOR_BYTES {
        return Err(());
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| ())?;
    serde_json::from_slice(&bytes).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::ClientChange;

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
}
