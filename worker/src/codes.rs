//! Sync code generation, validation, and hashing.

use sha2::{Digest, Sha256};
use worker::{Error, Result};

const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_CHAR_COUNT: usize = 25;

pub(crate) fn valid_code(code: &str) -> bool {
    let len = code.len();
    (16..=128).contains(&len)
        && code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub(crate) fn generate_code() -> Result<String> {
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

pub(crate) fn sync_hash(code: &str) -> String {
    let digest = Sha256::digest(code.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
