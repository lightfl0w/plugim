use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::plugins::files::FileStoreConfig;

type HmacSha256 = Hmac<Sha256>;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn uri_encode(raw: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for byte in raw.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b'/' if keep_slash => out.push('/'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub struct S3Client {
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    path_style: bool,
    http: reqwest::Client,
}

impl S3Client {
    pub fn new(cfg: &FileStoreConfig) -> Result<Self, String> {
        if cfg.bucket.trim().is_empty() {
            return Err("S3 未配置 Bucket".to_string());
        }
        if cfg.access_key.trim().is_empty() || cfg.secret_key.trim().is_empty() {
            return Err("S3 未配置访问密钥".to_string());
        }
        let endpoint = cfg.endpoint.trim().trim_end_matches('/').to_string();
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|err| err.to_string())?;
        Ok(Self {
            endpoint,
            region: if cfg.region.trim().is_empty() {
                "us-east-1".to_string()
            } else {
                cfg.region.trim().to_string()
            },
            bucket: cfg.bucket.trim().to_string(),
            access_key: cfg.access_key.trim().to_string(),
            secret_key: cfg.secret_key.trim().to_string(),
            path_style: cfg.path_style,
            http,
        })
    }

    fn host_and_path(&self, key: Option<&str>) -> Result<(String, String), String> {
        if self.endpoint.is_empty() {
            let host = if self.path_style {
                format!("s3.{}.amazonaws.com", self.region)
            } else {
                format!("{}.s3.{}.amazonaws.com", self.bucket, self.region)
            };
            let path = match key {
                Some(key) => format!("/{key}"),
                None => "/".to_string(),
            };
            return Ok((host, path));
        }
        let url = reqwest::Url::parse(&self.endpoint)
            .map_err(|_| "S3 Endpoint 无效".to_string())?;
        let host = match url.host_str() {
            Some(host) => match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            },
            None => return Err("S3 Endpoint 无效".to_string()),
        };
        let prefix = url.path().trim_end_matches('/');
        let path = if self.path_style {
            match key {
                Some(key) => format!("{prefix}/{}/{}", self.bucket, key),
                None => format!("{prefix}/{}", self.bucket),
            }
        } else {
            match key {
                Some(key) => format!("{prefix}/{key}"),
                None => format!("{prefix}/"),
            }
        };
        Ok((host, if path.is_empty() { "/".to_string() } else { path }))
    }

    fn signature(
        &self,
        method: &str,
        host: &str,
        canonical_uri: &str,
        payload_hash: &str,
        content_type: Option<&str>,
    ) -> (String, String) {
        let now = chrono::Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();
        let mut headers: Vec<String> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        if let Some(value) = content_type {
            headers.push(format!("content-type:{value}"));
            names.push("content-type".to_string());
        }
        headers.push(format!("host:{host}"));
        names.push("host".to_string());
        headers.push(format!("x-amz-content-sha256:{payload_hash}"));
        names.push("x-amz-content-sha256".to_string());
        headers.push(format!("x-amz-date:{amz_date}"));
        names.push("x-amz-date".to_string());
        let canonical_headers = format!("{}\n", headers.join("\n"));
        let signed_headers = names.join(";");
        let canonical_request = format!(
            "{method}\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let scope = format!("{date_stamp}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
            sha256_hex(canonical_request.as_bytes())
        );
        let key = hmac(
            format!("AWS4{}", self.secret_key).as_bytes(),
            &date_stamp,
        );
        let key = hmac(&key, &self.region);
        let key = hmac(&key, "s3");
        let key = hmac(&key, "aws4_request");
        let signature = hex(&hmac(&key, &string_to_sign));
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        );
        (authorization, amz_date)
    }

    async fn send(
        &self,
        method: &str,
        key: Option<&str>,
        body: Option<Vec<u8>>,
        content_type: Option<&str>,
        cache_control: Option<&str>,
    ) -> Result<reqwest::Response, String> {
        let (host, path) = self.host_and_path(key)?;
        let canonical_uri = uri_encode(&path, true);
        let payload = body.clone().unwrap_or_default();
        let payload_hash = sha256_hex(&payload);
        let (authorization, amz_date) =
            self.signature(method, &host, &canonical_uri, &payload_hash, content_type);
        let scheme = if self.endpoint.is_empty() {
            "https".to_string()
        } else {
            reqwest::Url::parse(&self.endpoint)
                .map(|url| url.scheme().to_string())
                .unwrap_or_else(|_| "https".to_string())
        };
        let url = format!("{scheme}://{host}{canonical_uri}");
        let mut request = self
            .http
            .request(
                method.parse().map_err(|_| "非法请求方法".to_string())?,
                &url,
            )
            .header("host", &host)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .header("authorization", &authorization);
        if let Some(value) = content_type {
            request = request.header("content-type", value);
        }
        if let Some(value) = cache_control {
            request = request.header("cache-control", value);
        }
        if body.is_some() {
            request = request.body(payload);
        }
        request.send().await.map_err(|err| err.to_string())
    }

    pub async fn put(
        &self,
        key: &str,
        data: &[u8],
        content_type: &str,
    ) -> Result<(), String> {
        let response = self
            .send(
                "PUT",
                Some(key),
                Some(data.to_vec()),
                Some(content_type),
                Some("public, max-age=31536000, immutable"),
            )
            .await?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        let detail = response.text().await.unwrap_or_default();
        Err(format!("S3 上传失败（{status}）：{detail}"))
    }

    pub async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
        let response = self.send("GET", Some(key), None, None, None).await?;
        let status = response.status().as_u16();
        if status == 404 {
            return Err("文件不存在".to_string());
        }
        if !(200..300).contains(&status) {
            let detail = response.text().await.unwrap_or_default();
            return Err(format!("S3 读取失败（{status}）：{detail}"));
        }
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(|err| err.to_string())
    }

    pub async fn delete(&self, key: &str) -> Result<(), String> {
        let response = self.send("DELETE", Some(key), None, None, None).await?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) || status == 404 {
            return Ok(());
        }
        Err(format!("S3 删除失败（{status}）"))
    }

    pub async fn head_bucket(&self) -> Result<(), String> {
        let response = self.send("HEAD", None, None, None, None).await?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return Ok(());
        }
        if status == 403 {
            return Err("Bucket 存在但无权访问，请检查访问密钥".to_string());
        }
        if status == 404 {
            return Err("Bucket 不存在".to_string());
        }
        Err(format!("S3 连接失败（{status}）"))
    }
}
