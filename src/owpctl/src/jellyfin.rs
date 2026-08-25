use std::{fs, path::Path, time::Duration};

use anyhow::{bail, Context};
use reqwest::blocking::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use url::Url;

pub const PLUGIN_ID: &str = "0f2fd0fd-09ff-4f49-9f1c-4a8f421a4b7d";
pub const REPOSITORY_URL: &str =
    "https://mhbxyz.github.io/OpenWatchParty/jellyfin-plugin-repo/manifest.json";

#[derive(Debug, Clone)]
pub struct JellyfinClient {
    base_url: Url,
    client: Client,
    token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct PublicSystemInfo {
    pub version: String,
    pub id: String,
    pub server_name: String,
    pub startup_wizard_completed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AuthenticationResult {
    pub access_token: String,
    pub user: AuthenticatedUser,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AuthenticatedUser {
    pub id: String,
    pub name: String,
    pub policy: UserPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct UserPolicy {
    pub is_administrator: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OpenWatchPartyToken {
    pub token: Option<String>,
    pub auth_enabled: bool,
    pub insecure_mode: Option<bool>,
    pub session_server_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SigningKeyInfo {
    pub issuer: String,
    pub jwk: crate::trust::PublicJwk,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RepositoryInfo {
    #[serde(rename = "Name")]
    pub name: String,
    #[serde(rename = "Url")]
    pub url: String,
    #[serde(rename = "Enabled")]
    pub enabled: bool,
}

impl JellyfinClient {
    pub fn new(mut base_url: Url) -> anyhow::Result<Self> {
        if !base_url.path().ends_with('/') {
            base_url.set_path(&format!("{}/", base_url.path()));
        }
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            base_url,
            client,
            token: None,
        })
    }

    pub fn with_token(mut self, token: impl Into<String>) -> Self {
        self.token = Some(token.into());
        self
    }

    pub fn token_from_file(path: &Path) -> anyhow::Result<String> {
        let token = fs::read_to_string(path)
            .with_context(|| format!("cannot read token file {}", path.display()))?;
        let token = token.trim().to_string();
        if token.is_empty() {
            bail!("token file is empty");
        }
        Ok(token)
    }

    pub fn public_info(&self) -> anyhow::Result<PublicSystemInfo> {
        self.get("System/Info/Public")
    }

    pub fn authenticate(
        &self,
        username: &str,
        password: &str,
    ) -> anyhow::Result<AuthenticationResult> {
        let response = self
            .client
            .post(self.url("Users/AuthenticateByName")?)
            .header("Authorization", authorization_header(None))
            .json(&serde_json::json!({ "Username": username, "Pw": password }))
            .send()?;
        let result: AuthenticationResult = checked_json(response)?;
        if !result.user.policy.is_administrator {
            bail!("Jellyfin user {} is not an administrator", result.user.name);
        }
        Ok(result)
    }

    pub fn plugin_info(&self) -> anyhow::Result<PluginInfo> {
        self.get("OpenWatchParty/Info")
    }

    pub fn openwatchparty_token(&self) -> anyhow::Result<OpenWatchPartyToken> {
        self.get("OpenWatchParty/Token")
    }

    pub fn signing_key(&self) -> anyhow::Result<SigningKeyInfo> {
        self.get("OpenWatchParty/SigningKey")
    }

    pub fn activate_signing_key(&self, kid: &str) -> anyhow::Result<()> {
        self.post_empty(
            "OpenWatchParty/SigningKey/Activate",
            Some(&serde_json::json!({ "kid": kid })),
        )
    }

    pub fn repositories(&self) -> anyhow::Result<Vec<RepositoryInfo>> {
        self.get("Repositories")
    }

    pub fn set_repositories(&self, repositories: &[RepositoryInfo]) -> anyhow::Result<()> {
        self.post_empty("Repositories", Some(repositories))
    }

    pub fn ensure_repository(&self) -> anyhow::Result<bool> {
        let mut repositories = self.repositories()?;
        if repositories
            .iter()
            .any(|repository| repository.url == REPOSITORY_URL)
        {
            return Ok(false);
        }
        repositories.push(RepositoryInfo {
            name: "OpenWatchParty".to_string(),
            url: REPOSITORY_URL.to_string(),
            enabled: true,
        });
        self.set_repositories(&repositories)?;
        Ok(true)
    }

    pub fn install_plugin(&self, version: &str) -> anyhow::Result<()> {
        let endpoint = format!(
            "Packages/Installed/OpenWatchParty?assemblyGuid={PLUGIN_ID}&version={version}&repositoryUrl={}",
            url::form_urlencoded::byte_serialize(REPOSITORY_URL.as_bytes()).collect::<String>()
        );
        self.post_empty::<serde_json::Value>(&endpoint, None)
    }

    pub fn uninstall_plugin(&self) -> anyhow::Result<()> {
        let token = self
            .token
            .as_ref()
            .context("Jellyfin admin token is required")?;
        let response = self
            .client
            .delete(self.url(&format!("Plugins/{PLUGIN_ID}"))?)
            .header("Authorization", authorization_header(Some(token)))
            .send()?;
        if !response.status().is_success() {
            bail!(
                "Jellyfin returned HTTP {} while removing plugin",
                response.status()
            );
        }
        Ok(())
    }

    pub fn plugin_configuration<T: DeserializeOwned>(&self) -> anyhow::Result<T> {
        self.get(&format!("Plugins/{PLUGIN_ID}/Configuration"))
    }

    pub fn update_plugin_configuration<T: Serialize>(&self, value: &T) -> anyhow::Result<()> {
        self.post_empty(&format!("Plugins/{PLUGIN_ID}/Configuration"), Some(value))
    }

    pub fn restart(&self) -> anyhow::Result<()> {
        match self.post_empty::<serde_json::Value>("System/Restart", None) {
            Ok(()) => Ok(()),
            Err(error) if error.to_string().contains("connection") => Ok(()),
            Err(error) => Err(error),
        }
    }

    fn get<T: DeserializeOwned>(&self, path: &str) -> anyhow::Result<T> {
        let mut request = self.client.get(self.url(path)?);
        if let Some(token) = &self.token {
            request = request.header("Authorization", authorization_header(Some(token)));
        }
        checked_json(request.send()?)
    }

    fn post_empty<T: Serialize + ?Sized>(
        &self,
        path: &str,
        value: Option<&T>,
    ) -> anyhow::Result<()> {
        let token = self
            .token
            .as_ref()
            .context("Jellyfin admin token is required")?;
        let mut request = self
            .client
            .post(self.url(path)?)
            .header("Authorization", authorization_header(Some(token)));
        if let Some(value) = value {
            request = request.json(value);
        }
        let response = request.send()?;
        if !response.status().is_success() {
            bail!("Jellyfin returned HTTP {}", response.status());
        }
        Ok(())
    }

    fn url(&self, path: &str) -> anyhow::Result<Url> {
        self.base_url
            .join(path)
            .with_context(|| format!("cannot append {path} to Jellyfin URL"))
    }
}

fn authorization_header(token: Option<&str>) -> String {
    let mut value = format!("MediaBrowser Client=\"OpenWatchParty Installer\", Device=\"CLI\", DeviceId=\"owpctl\", Version=\"{}\"", crate::VERSION);
    if let Some(token) = token {
        value.push_str(&format!(", Token=\"{token}\""));
    }
    value
}

fn checked_json<T: DeserializeOwned>(response: reqwest::blocking::Response) -> anyhow::Result<T> {
    if !response.status().is_success() {
        bail!("Jellyfin returned HTTP {}", response.status());
    }
    response.json().context("invalid Jellyfin JSON response")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base_path_is_preserved_when_building_api_urls() {
        let client =
            JellyfinClient::new(Url::parse("https://media.example/jellyfin").unwrap()).unwrap();
        assert_eq!(
            client.url("System/Info/Public").unwrap().as_str(),
            "https://media.example/jellyfin/System/Info/Public"
        );
    }
}
