use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const DAY_MS: i64 = 86_400_000;
const DEFAULT_MAX_BYTES: u64 = 8 * 1024 * 1024;
const DEFAULT_KEEP_DAYS: i64 = 14;
const DEFAULT_KEEP_FILES: usize = 200;

pub fn log_day(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

fn log_name(day: &str, index: usize) -> String {
    if index == 0 {
        format!("server-{day}.log")
    } else {
        format!("server-{day}.{index}.log")
    }
}

fn parse_log_name(name: &str) -> Option<(String, usize)> {
    let rest = name.strip_prefix("server-")?;
    let rest = rest.strip_suffix(".log")?;
    let parts: Vec<&str> = rest.split('.').collect();
    let day = parts.first()?;
    if day.len() != 10 {
        return None;
    }
    let day_ok = day.as_bytes().iter().enumerate().all(|(index, byte)| {
        if index == 4 || index == 7 {
            *byte == b'-'
        } else {
            byte.is_ascii_digit()
        }
    });
    if !day_ok {
        return None;
    }
    let index = match parts.get(1) {
        Some(value) => value.parse::<usize>().ok()?,
        None => 0,
    };
    Some((day.to_string(), index))
}

struct Inner {
    day: String,
    index: usize,
    file: File,
    size: u64,
}

pub struct RotatingFile {
    dir: PathBuf,
    max_bytes: u64,
    keep_days: i64,
    keep_files: usize,
    inner: Mutex<Option<Inner>>,
}

impl RotatingFile {
    pub fn open(dir: &Path) -> io::Result<Arc<Self>> {
        std::fs::create_dir_all(dir)?;
        let max_bytes = std::env::var("PLUGIM_LOG_MAX_BYTES")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_MAX_BYTES)
            .max(64 * 1024);
        let keep_days = std::env::var("PLUGIM_LOG_KEEP_DAYS")
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(DEFAULT_KEEP_DAYS)
            .max(1);
        let keep_files = std::env::var("PLUGIM_LOG_KEEP_FILES")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .unwrap_or(DEFAULT_KEEP_FILES)
            .max(1);
        let logger = Arc::new(Self {
            dir: dir.to_path_buf(),
            max_bytes,
            keep_days,
            keep_files,
            inner: Mutex::new(None),
        });
        prune_logs(dir, keep_days, keep_files, crate::util::now_ms());
        Ok(logger)
    }

    fn next_index(&self, day: &str) -> usize {
        for index in 0..1000 {
            let path = self.dir.join(log_name(day, index));
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            if size < self.max_bytes {
                return index;
            }
        }
        999
    }

    fn open_file(&self, day: &str, index: usize) -> io::Result<Inner> {
        let path = self.dir.join(log_name(day, index));
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        Ok(Inner {
            day: day.to_string(),
            index,
            file,
            size,
        })
    }

    pub fn write_line(&self, line: &str) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        let today = log_day(crate::util::now_ms());
        let stale = match guard.as_ref() {
            None => true,
            Some(inner) => inner.day != today || inner.size >= self.max_bytes,
        };
        if stale {
            let index = match guard.as_ref() {
                Some(inner) if inner.day == today => inner.index + 1,
                _ => self.next_index(&today),
            };
            if let Ok(next) = self.open_file(&today, index) {
                *guard = Some(next);
            }
        }
        if let Some(inner) = guard.as_mut() {
            if inner.file.write_all(line.as_bytes()).is_ok() {
                inner.size += line.len() as u64;
            }
        }
        let full = guard
            .as_ref()
            .map(|inner| inner.size >= self.max_bytes)
            .unwrap_or(false);
        if full {
            prune_logs(&self.dir, self.keep_days, self.keep_files, crate::util::now_ms());
        }
    }

}

pub fn prune_logs(dir: &Path, keep_days: i64, keep_files: usize, now_ms: i64) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let cutoff = now_ms - keep_days * DAY_MS;
    let mut removed = 0;
    let mut kept: Vec<(i64, PathBuf)> = Vec::new();
    for entry in entries.filter_map(|entry| entry.ok()) {
        let name = match entry.file_name().to_str() {
            Some(name) => name.to_string(),
            None => continue,
        };
        let Some((day, index)) = parse_log_name(&name) else {
            continue;
        };
        let day_ms = chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d")
            .ok()
            .and_then(|date| date.and_hms_opt(0, 0, 0))
            .map(|dt| dt.and_utc().timestamp_millis())
            .unwrap_or(0);
        if day_ms < cutoff {
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
            continue;
        }
        kept.push((day_ms + index as i64, entry.path()));
    }
    if kept.len() > keep_files {
        kept.sort_by(|left, right| left.0.cmp(&right.0));
        let drop_count = kept.len() - keep_files;
        for (_, path) in kept.into_iter().take(drop_count) {
            if std::fs::remove_file(path).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[derive(Clone)]
pub struct SharedLogger(pub Arc<RotatingFile>);

impl Write for SharedLogger {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf).to_string();
        self.0.write_line(&text);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedLogger {
    type Writer = SharedLogger;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}
