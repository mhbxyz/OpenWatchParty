use super::constants::{MAX_NAME_LENGTH, MAX_POSITION_SECONDS};

pub(super) fn is_valid_position(pos: f64) -> bool {
    pos.is_finite() && (0.0..=MAX_POSITION_SECONDS).contains(&pos)
}

pub(super) fn is_valid_media_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

#[allow(dead_code)] // Used in tests, kept as validation companion to sanitize_name
pub(super) fn is_valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_NAME_LENGTH && !name.chars().any(|c| c.is_control())
}

pub(super) fn sanitize_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    let sanitized: String = trimmed.chars().take(MAX_NAME_LENGTH).collect();
    let clean: String = sanitized.chars().filter(|c| !c.is_control()).collect();
    if clean.is_empty() {
        None
    } else {
        Some(clean)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_position_normal() {
        assert!(is_valid_position(0.0));
        assert!(is_valid_position(100.5));
        assert!(is_valid_position(3600.0));
        assert!(is_valid_position(86400.0));
    }

    #[test]
    fn test_is_valid_position_invalid() {
        assert!(!is_valid_position(-1.0));
        assert!(!is_valid_position(-0.001));
        assert!(!is_valid_position(86400.1));
        assert!(!is_valid_position(f64::NAN));
        assert!(!is_valid_position(f64::INFINITY));
        assert!(!is_valid_position(f64::NEG_INFINITY));
    }

    #[test]
    fn test_is_valid_media_id() {
        assert!(is_valid_media_id("550e8400e29b41d4a716446655440000"));
        assert!(is_valid_media_id("abcdef0123456789abcdef0123456789"));
        assert!(is_valid_media_id("ABCDEF0123456789ABCDEF0123456789"));
    }

    #[test]
    fn test_is_valid_media_id_invalid() {
        assert!(!is_valid_media_id(""));
        assert!(!is_valid_media_id("550e8400e29b41d4a71644665544000"));
        assert!(!is_valid_media_id("550e8400e29b41d4a7164466554400000"));
        assert!(!is_valid_media_id("550e8400e29b41d4a716446655440xyz"));
        assert!(!is_valid_media_id("not-a-valid-jellyfin-media-id!!"));
    }

    #[test]
    fn test_is_valid_name() {
        assert!(is_valid_name("Alice"));
        assert!(is_valid_name("Bob123"));
        assert!(is_valid_name("\u{7528}\u{6237}\u{540D}"));
        assert!(is_valid_name("a"));
    }

    #[test]
    fn test_is_valid_name_invalid() {
        assert!(!is_valid_name(""));
        assert!(!is_valid_name("a\x00b"));
        assert!(!is_valid_name("test\n"));
        let long_name: String = "a".repeat(MAX_NAME_LENGTH + 1);
        assert!(!is_valid_name(&long_name));
    }

    #[test]
    fn test_sanitize_name() {
        assert_eq!(sanitize_name("Alice"), Some("Alice".to_string()));
        assert_eq!(sanitize_name("  Bob  "), Some("Bob".to_string()));
        assert_eq!(sanitize_name(""), None);
        assert_eq!(sanitize_name("   "), None);
    }

    #[test]
    fn test_sanitize_name_control_chars() {
        assert_eq!(sanitize_name("test\x00name"), Some("testname".to_string()));
        assert_eq!(
            sanitize_name("hello\nworld"),
            Some("helloworld".to_string())
        );
    }

    #[test]
    fn test_sanitize_name_truncation() {
        let long_name: String = "a".repeat(MAX_NAME_LENGTH + 50);
        let result = sanitize_name(&long_name);
        assert!(result.is_some());
        assert_eq!(result.unwrap().len(), MAX_NAME_LENGTH);
    }
}
