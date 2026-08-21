//! Join-ticket verification. The api mints a short-lived HS256 JWT (see server/api's
//! tokens.ts) authorizing exactly one connection to one instance. We verify the signature,
//! the audience, and the expiry — and the caller additionally burns the `jti` in Redis so a
//! ticket can't be replayed.

use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct TicketClaims {
    /// User.id
    pub sub: String,
    #[serde(rename = "instanceId")]
    pub instance_id: String,
    pub username: String,
    #[serde(rename = "avatarId")]
    pub avatar_id: Option<String>,
    pub jti: String,
    pub exp: usize,
}

pub struct TicketVerifier {
    key: DecodingKey,
    validation: Validation,
}

impl TicketVerifier {
    pub fn new(secret: &str) -> Self {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&["serika-social"]);
        validation.set_audience(&["instanced"]);
        validation.set_required_spec_claims(&["exp", "aud", "iss"]);
        Self { key: DecodingKey::from_secret(secret.as_bytes()), validation }
    }

    pub fn verify(&self, token: &str) -> Result<TicketClaims, jsonwebtoken::errors::Error> {
        decode::<TicketClaims>(token, &self.key, &self.validation).map(|d| d.claims)
    }
}
