use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::{json, Value};

const BUCKET_BOUNDS: [u64; 10] = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const MAX_TRACKED_METHODS: usize = 500;

struct CountingAlloc;

static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(layout.size(), Ordering::Relaxed);
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        ALLOCATED.fetch_sub(layout.size(), Ordering::Relaxed);
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if new_size >= layout.size() {
            ALLOCATED.fetch_add(new_size - layout.size(), Ordering::Relaxed);
        } else {
            ALLOCATED.fetch_sub(layout.size() - new_size, Ordering::Relaxed);
        }
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;

#[derive(Default, Clone)]
pub struct RpcStat {
    pub calls: u64,
    pub errors: u64,
    pub total_ms: f64,
    pub max_ms: f64,
    pub buckets: [u64; 10],
}

pub struct Metrics {
    started: Instant,
    rpc: Mutex<HashMap<String, RpcStat>>,
    connections: AtomicU64,
    messages_sent: AtomicU64,
    http_requests: AtomicU64,
    http_errors: AtomicU64,
    http_duration_ms: AtomicU64,
    lag_ms: AtomicI64,
}

static METRICS: OnceLock<Metrics> = OnceLock::new();

pub fn metrics() -> &'static Metrics {
    METRICS.get_or_init(|| Metrics {
        started: Instant::now(),
        rpc: Mutex::new(HashMap::new()),
        connections: AtomicU64::new(0),
        messages_sent: AtomicU64::new(0),
        http_requests: AtomicU64::new(0),
        http_errors: AtomicU64::new(0),
        http_duration_ms: AtomicU64::new(0),
        lag_ms: AtomicI64::new(0),
    })
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ")
}

fn rss_bytes() -> u64 {
    let raw = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb = rest
                .split_whitespace()
                .next()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
            return kb * 1024;
        }
    }
    0
}

impl Metrics {
    pub fn observe_rpc(&self, method: &str, ms: f64, ok: bool) {
        let slow = std::env::var("PLUGIM_SLOW_RPC_MS")
            .ok()
            .and_then(|value| value.trim().parse::<f64>().ok())
            .unwrap_or(1500.0);
        if ms >= slow {
            tracing::warn!("slow rpc {method} took {}ms", ms.round() as i64);
        }
        let mut guard = match self.rpc.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        if !guard.contains_key(method) && guard.len() >= MAX_TRACKED_METHODS {
            return;
        }
        let entry = guard.entry(method.to_string()).or_default();
        entry.calls += 1;
        entry.total_ms += ms;
        if ms > entry.max_ms {
            entry.max_ms = ms;
        }
        if !ok {
            entry.errors += 1;
        }
        for (index, bound) in BUCKET_BOUNDS.iter().enumerate() {
            if ms <= *bound as f64 {
                entry.buckets[index] += 1;
                break;
            }
        }
    }

    pub fn observe_http(&self, ms: f64, ok: bool) {
        self.http_requests.fetch_add(1, Ordering::Relaxed);
        self.http_duration_ms
            .fetch_add(ms.max(0.0) as u64, Ordering::Relaxed);
        if !ok {
            self.http_errors.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn add_message(&self, count: u64) {
        self.messages_sent.fetch_add(count, Ordering::Relaxed);
    }

    pub fn set_connections(&self, count: u64) {
        self.connections.store(count, Ordering::Relaxed);
    }

    pub fn set_lag(&self, ms: i64) {
        self.lag_ms.store(ms, Ordering::Relaxed);
    }

    pub fn uptime_sec(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    pub fn snapshot(&self) -> Value {
        let mut rpc: Vec<Value> = Vec::new();
        if let Ok(guard) = self.rpc.lock() {
            let mut entries: Vec<(&String, &RpcStat)> = guard.iter().collect();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            for (method, stat) in entries {
                rpc.push(json!({
                    "method": method,
                    "calls": stat.calls,
                    "errors": stat.errors,
                    "totalMs": stat.total_ms,
                    "maxMs": stat.max_ms,
                    "buckets": stat.buckets.to_vec(),
                }));
            }
        }
        json!({
            "uptimeSec": self.uptime_sec(),
            "connections": self.connections.load(Ordering::Relaxed),
            "rpc": rpc,
            "messagesSent": self.messages_sent.load(Ordering::Relaxed),
            "httpRequests": self.http_requests.load(Ordering::Relaxed),
            "httpErrors": self.http_errors.load(Ordering::Relaxed),
            "httpDurationMs": self.http_duration_ms.load(Ordering::Relaxed),
            "eventLoopLagMs": self.lag_ms.load(Ordering::Relaxed),
            "memoryRssBytes": rss_bytes(),
            "memoryHeapUsedBytes": ALLOCATED.load(Ordering::Relaxed),
        })
    }

    pub fn prometheus(&self) -> String {
        let mut out: Vec<String> = Vec::new();
        let metric = |out: &mut Vec<String>, name: &str, help: &str, kind: &str, body: Vec<String>| {
            out.push(format!("# HELP {name} {help}"));
            out.push(format!("# TYPE {name} {kind}"));
            out.extend(body);
        };

        metric(
            &mut out,
            "plugim_uptime_seconds",
            "进程运行时长（秒）",
            "gauge",
            vec![format!(
                "plugim_uptime_seconds {:.1}",
                self.started.elapsed().as_secs_f64()
            )],
        );
        metric(
            &mut out,
            "plugim_websocket_connections",
            "当前 WebSocket 连接数",
            "gauge",
            vec![format!(
                "plugim_websocket_connections {}",
                self.connections.load(Ordering::Relaxed)
            )],
        );
        metric(
            &mut out,
            "plugim_messages_sent_total",
            "服务端发出的消息总数",
            "counter",
            vec![format!(
                "plugim_messages_sent_total {}",
                self.messages_sent.load(Ordering::Relaxed)
            )],
        );
        metric(
            &mut out,
            "plugim_http_requests_total",
            "HTTP 请求总数",
            "counter",
            vec![format!(
                "plugim_http_requests_total {}",
                self.http_requests.load(Ordering::Relaxed)
            )],
        );
        metric(
            &mut out,
            "plugim_http_errors_total",
            "HTTP 请求错误数",
            "counter",
            vec![format!(
                "plugim_http_errors_total {}",
                self.http_errors.load(Ordering::Relaxed)
            )],
        );
        metric(
            &mut out,
            "plugim_event_loop_lag_ms",
            "事件循环延迟（毫秒）",
            "gauge",
            vec![format!(
                "plugim_event_loop_lag_ms {:.1}",
                self.lag_ms.load(Ordering::Relaxed) as f64
            )],
        );
        metric(
            &mut out,
            "plugim_memory_rss_bytes",
            "进程常驻内存",
            "gauge",
            vec![format!("plugim_memory_rss_bytes {}", rss_bytes())],
        );
        metric(
            &mut out,
            "plugim_memory_heap_used_bytes",
            "堆已分配内存",
            "gauge",
            vec![format!(
                "plugim_memory_heap_used_bytes {}",
                ALLOCATED.load(Ordering::Relaxed)
            )],
        );

        let guard = match self.rpc.lock() {
            Ok(guard) => guard,
            Err(err) => err.into_inner(),
        };
        let mut entries: Vec<(&String, &RpcStat)> = guard.iter().collect();
        entries.sort_by(|left, right| left.0.cmp(right.0));

        let mut calls = Vec::new();
        let mut errors = Vec::new();
        let mut sums = Vec::new();
        let mut maxes = Vec::new();
        let mut buckets = Vec::new();
        for (method, stat) in entries {
            let label = escape_label(method);
            calls.push(format!(
                "plugim_rpc_calls_total{{method=\"{label}\"}} {}",
                stat.calls
            ));
            errors.push(format!(
                "plugim_rpc_errors_total{{method=\"{label}\"}} {}",
                stat.errors
            ));
            sums.push(format!(
                "plugim_rpc_duration_ms_sum{{method=\"{label}\"}} {:.1}",
                stat.total_ms
            ));
            maxes.push(format!(
                "plugim_rpc_duration_ms_max{{method=\"{label}\"}} {:.1}",
                stat.max_ms
            ));
            let mut cumulative = 0u64;
            for (index, bound) in BUCKET_BOUNDS.iter().enumerate() {
                cumulative += stat.buckets[index];
                buckets.push(format!(
                    "plugim_rpc_duration_ms_bucket{{method=\"{label}\",le=\"{bound}\"}} {cumulative}"
                ));
            }
            buckets.push(format!(
                "plugim_rpc_duration_ms_bucket{{method=\"{label}\",le=\"+Inf\"}} {}",
                stat.calls
            ));
        }
        drop(guard);

        metric(
            &mut out,
            "plugim_rpc_calls_total",
            "RPC 调用次数",
            "counter",
            calls,
        );
        metric(
            &mut out,
            "plugim_rpc_errors_total",
            "RPC 失败次数",
            "counter",
            errors,
        );
        metric(
            &mut out,
            "plugim_rpc_duration_ms_sum",
            "RPC 累计耗时",
            "counter",
            sums,
        );
        metric(
            &mut out,
            "plugim_rpc_duration_ms_max",
            "RPC 单次最大耗时",
            "gauge",
            maxes,
        );
        metric(
            &mut out,
            "plugim_rpc_duration_ms_bucket",
            "RPC 耗时分布",
            "histogram",
            buckets,
        );

        let mut text = out.join("\n");
        text.push('\n');
        text
    }
}

pub fn spawn_lag_probe() {
    tokio::spawn(async {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut last = Instant::now();
        loop {
            ticker.tick().await;
            let now = Instant::now();
            let drift = now.duration_since(last).as_millis() as i64 - 5000;
            last = now;
            metrics().set_lag(drift.max(0));
        }
    });
}
