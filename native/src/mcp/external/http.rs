use std::collections::HashMap;

use http::header::{HeaderName, HeaderValue};
use napi::{Error, Result};
use rmcp::model::ClientInfo;
use rmcp::service::{ClientLifecycleMode, ClientServiceExt, RunningService};
use rmcp::transport::{
    streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
};

use crate::storage::McpServerConfigRecord;

use super::super::protocol::RemoteMcpTool;

pub(super) type HttpRunningClient = RunningService<rmcp::RoleClient, ClientInfo>;

pub(super) struct HttpMcpClient {
    client: HttpRunningClient,
}

impl HttpMcpClient {
    pub(super) async fn connect(config: &McpServerConfigRecord) -> Result<Self> {
        let url = config.url.trim();
        if url.is_empty() {
            return Err(Error::from_reason(format!(
                "External MCP server {} has no URL",
                config.name
            )));
        }

        let custom_headers = parse_headers(&config.headers_json)?;

        // 优先尝试 2026-07-28 无状态协议。SDK 的 Auto 模式只对规范协商错误
        // （-32601 Method Not Found / -32022 Unsupported Protocol Version）
        // 自动降级或换版本重试；旧服务器若返回其他 JSON-RPC 错误（如 deepwiki
        // 的 -32600 "Unsupported protocol version"），需在下面用 legacy
        // initialize 握手手动重试一次。
        let auto_lifecycle = ClientLifecycleMode::Auto {
            preferred_versions: vec![rmcp::model::ProtocolVersion::V_2026_07_28],
            legacy_version: Some(rmcp::model::ProtocolVersion::V_2025_11_25),
        };

        let client_info = ClientInfo::default();

        let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url);
        if !custom_headers.is_empty() {
            transport_config = transport_config.custom_headers(custom_headers.clone());
        }
        let transport: StreamableHttpClientTransport<_> =
            StreamableHttpClientTransport::from_config(transport_config);

        let running = match client_info
            .clone()
            .serve_with_lifecycle(transport, auto_lifecycle)
            .await
        {
            Ok(running) => running,
            Err(error) if super::should_retry_with_legacy_handshake(&error) => {
                // 重建 transport 避免复用失败连接的状态，改用 legacy 握手重连。
                let mut transport_config = StreamableHttpClientTransportConfig::with_uri(url);
                if !custom_headers.is_empty() {
                    transport_config = transport_config.custom_headers(custom_headers);
                }
                let transport: StreamableHttpClientTransport<_> =
                    StreamableHttpClientTransport::from_config(transport_config);

                match client_info
                    .serve_with_lifecycle(transport, ClientLifecycleMode::Initialize)
                    .await
                {
                    Ok(running) => running,
                    // 重试失败时保留原始 Auto 错误（含版本协商诊断信息）
                    Err(_) => {
                        return Err(Error::from_reason(format!(
                            "Failed to connect external MCP HTTP server {}: {error}",
                            config.name
                        )))
                    }
                }
            }
            Err(error) => {
                return Err(Error::from_reason(format!(
                    "Failed to connect external MCP HTTP server {}: {error}",
                    config.name
                )))
            }
        };

        Ok(Self { client: running })
    }

    pub(super) async fn list_all_tools(&self) -> Result<Vec<RemoteMcpTool>> {
        let tools = self.client.list_all_tools().await.map_err(|error| {
            Error::from_reason(format!("External MCP tools/list failed: {error}"))
        })?;
        Ok(tools.into_iter().map(rmcp_tool_to_remote).collect())
    }

    pub(super) async fn call_tool(
        &self,
        name: &str,
        arguments: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let params = rmcp::model::CallToolRequestParams::new(name.to_string());
        let params = if let Some(obj) = arguments.as_object() {
            params.with_arguments(obj.clone())
        } else {
            params
        };

        let result = self.client.call_tool(params).await.map_err(|error| {
            Error::from_reason(format!("External MCP tools/call failed: {error}"))
        })?;

        Ok(call_tool_result_to_value(result))
    }

    pub(super) async fn close(mut self) {
        let _ = self.client.close().await;
    }
}

fn rmcp_tool_to_remote(tool: rmcp::model::Tool) -> RemoteMcpTool {
    let name = tool.name.to_string();
    let description = tool.description.as_deref().unwrap_or_default().to_string();
    let input_schema = serde_json::to_value(tool.input_schema.as_ref())
        .unwrap_or_else(|_| serde_json::json!({ "type": "object", "properties": {} }));
    RemoteMcpTool {
        name,
        description,
        input_schema,
    }
}

fn call_tool_result_to_value(result: rmcp::model::CallToolResult) -> serde_json::Value {
    // Serialize the entire CallToolResult as JSON. This preserves content blocks,
    // is_error flag, and structured_content so callers can interpret it fully.
    serde_json::to_value(&result)
        .unwrap_or_else(|_| serde_json::json!({ "content": [], "isError": false }))
}

fn parse_headers(value: &str) -> Result<HashMap<HeaderName, HeaderValue>> {
    let headers: HashMap<String, String> = serde_json::from_str(value).map_err(|error| {
        Error::from_reason(format!("Invalid external MCP headers JSON: {error}"))
    })?;
    let mut result = HashMap::new();
    for (name, value) in headers {
        let name = name.parse::<HeaderName>().map_err(|error| {
            Error::from_reason(format!("Invalid external MCP header name: {error}"))
        })?;
        let value = HeaderValue::from_str(&value).map_err(|error| {
            Error::from_reason(format!("Invalid external MCP header value: {error}"))
        })?;
        result.insert(name, value);
    }
    Ok(result)
}
