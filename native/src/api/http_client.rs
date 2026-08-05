//! 统一的代理 HTTP 客户端工厂。
//!
//! 所有 API 请求（Anthropic / Gemini / OpenAI Chat / Responses /
//! Embedding / Reranking / Vision / Summary / Codebase Review）都应
//! 通过此模块创建 `reqwest::Client`，确保代理设置一致：
//!
//! - 当用户启用了代理（`proxy_browser_settings.enabled == true`）时，
//!   所有请求通过 `http://127.0.0.1:{port}` 发出。
//! - 当代理未启用时，返回默认 builder（reqwest 默认会跟随系统代理
//!   环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 等）。
//!
//! 代理配置存储在数据库 `system_settings` 表中，setting_code 为
//! `proxy_browser_settings`，JSON 结构与前端
//! `ProxyBrowserSettings` 类型一致。

use std::time::Duration;

use napi::bindgen_prelude::*;

const PROXY_BROWSER_SETTING_CODE: &str = "proxy_browser_settings";
const DEFAULT_PROXY_HOST: &str = "127.0.0.1";
const DEFAULT_PROXY_PORT: u16 = 7890;

/// 从数据库加载的代理配置快照。
#[derive(Debug, Clone)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: DEFAULT_PROXY_HOST.to_string(),
            port: DEFAULT_PROXY_PORT,
        }
    }
}

/// 清理代理主机字符串：去除协议前缀和首尾空白，
/// 为空时回退到默认值。
fn sanitize_proxy_host(host: &str) -> String {
    let trimmed = host.trim();
    let stripped = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);
    let result = stripped.trim();
    if result.is_empty() {
        DEFAULT_PROXY_HOST.to_string()
    } else {
        result.to_string()
    }
}

impl ProxyConfig {
    /// 将代理设置应用到一个 `reqwest::ClientBuilder` 上。
    ///
    /// 当 `enabled` 为 false 时直接返回原 builder，由 reqwest 默认
    /// 跟随系统代理环境变量。当 `enabled` 为 true 时注入
    /// `http://{host}:{port}` 代理。
    pub fn apply(self, mut builder: reqwest::ClientBuilder) -> Result<reqwest::ClientBuilder> {
        if self.enabled {
            let proxy = reqwest::Proxy::all(format!("http://{}:{}", self.host, self.port))
                .map_err(|error| Error::from_reason(format!("Invalid proxy settings: {error}")))?;
            builder = builder.proxy(proxy);
        }
        Ok(builder)
    }
}

/// 从数据库异步加载代理配置。
///
/// 内部使用 `spawn_blocking` 读取数据库，不会阻塞 Node.js 主线程。
pub async fn load_proxy_config() -> Result<ProxyConfig> {
    tokio::task::spawn_blocking(|| {
        let storage_info = crate::storage::initialize_app_storage()?;
        let database_path = std::path::PathBuf::from(storage_info.database_path);

        let raw = crate::storage::services::system_settings::get_system_setting_value(
            &database_path,
            PROXY_BROWSER_SETTING_CODE,
        )?
        .unwrap_or_default();

        Ok(parse_proxy_config(&raw))
    })
    .await
    .map_err(|join_error| {
        Error::from_reason(format!("Failed to load proxy config: {join_error}"))
    })?
}

/// 解析代理配置 JSON。
fn parse_proxy_config(raw: &str) -> ProxyConfig {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return ProxyConfig::default();
    };

    let enabled = value
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    let host = value
        .get("host")
        .and_then(serde_json::Value::as_str)
        .map(sanitize_proxy_host)
        .unwrap_or_else(|| DEFAULT_PROXY_HOST.to_string());

    let port = value
        .get("port")
        .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i as u64)))
        .filter(|&p| (1..=65535).contains(&(p as u16)))
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_PROXY_PORT);

    ProxyConfig {
        enabled,
        host,
        port,
    }
}

/// 创建带代理设置的默认 HTTP 客户端。
///
/// 适用于不需要额外自定义（timeout / default_headers 等）的场景。
pub async fn build_proxied_client() -> Result<reqwest::Client> {
    let config = load_proxy_config().await?;
    let builder = config.apply(reqwest::Client::builder())?;
    builder
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))
}

/// 创建带代理设置和自定义超时的 HTTP 客户端。
pub async fn build_proxied_client_with_timeout(timeout: Duration) -> Result<reqwest::Client> {
    let config = load_proxy_config().await?;
    let builder = config.apply(reqwest::Client::builder().timeout(timeout))?;
    builder
        .build()
        .map_err(|error| Error::from_reason(format!("Failed to create HTTP client: {error}")))
}
