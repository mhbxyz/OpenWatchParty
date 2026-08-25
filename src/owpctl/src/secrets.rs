use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

pub fn generate_jwt_secret() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    STANDARD.encode(bytes)
}

pub fn fingerprint(secret: &str) -> String {
    let digest = Sha256::digest(secret.as_bytes());
    format!("sha256:{digest:x}")
}

pub fn env_file(secret: &str) -> String {
    format!("JWT_SECRET={secret}\n")
}

pub fn parse_env_secret(contents: &str) -> anyhow::Result<String> {
    contents
        .lines()
        .find_map(|line| line.strip_prefix("JWT_SECRET="))
        .filter(|secret| !secret.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("JWT_SECRET is missing from secrets.env"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_secret_has_32_decoded_bytes() {
        let secret = generate_jwt_secret();
        assert_eq!(STANDARD.decode(secret).unwrap().len(), 32);
    }
}
