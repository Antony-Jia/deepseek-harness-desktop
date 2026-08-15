use crate::state::StateStore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    io::{self, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

#[derive(Clone)]
struct ControlData {
    app: AppHandle,
    token: String,
    store: StateStore,
    foreground: Arc<AtomicBool>,
    tray_state: Arc<Mutex<String>>,
}

pub struct ControlServer {
    pub base_url: String,
    pub token: String,
    shutdown: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

#[derive(Debug, Deserialize)]
struct NotificationPayload {
    title: Option<String>,
    body: Option<String>,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TrayPayload {
    state: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickFolderResponse {
    ok: bool,
    path: Option<String>,
}

impl ControlServer {
    pub fn start(app: AppHandle, store: StateStore) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("无法绑定本地控制端口: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("设置控制端口非阻塞失败: {error}"))?;
        let addr = listener
            .local_addr()
            .map_err(|error| format!("读取控制端口失败: {error}"))?;
        let token = Uuid::new_v4().simple().to_string();
        let shutdown = Arc::new(AtomicBool::new(false));
        let foreground = Arc::new(AtomicBool::new(true));
        let data = ControlData {
            app,
            token: token.clone(),
            store,
            foreground: foreground.clone(),
            tray_state: Arc::new(Mutex::new("idle".to_string())),
        };
        let thread_shutdown = shutdown.clone();
        let join = thread::Builder::new()
            .name("dsh-desktop-control".to_string())
            .spawn(move || {
                while !thread_shutdown.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let data = data.clone();
                            thread::spawn(move || handle_connection(stream, data));
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(40));
                        }
                        Err(error) => {
                            eprintln!("[dsh-desktop] control listener error: {error}");
                            thread::sleep(Duration::from_millis(200));
                        }
                    }
                }
            })
            .map_err(|error| format!("启动控制端口线程失败: {error}"))?;
        Ok(Self {
            base_url: format!("http://{addr}"),
            token,
            shutdown,
            join: Some(join),
        })
    }
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn handle_connection(mut stream: TcpStream, data: ControlData) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            write_response(
                &mut stream,
                400,
                &json!({ "ok": false, "error": error.to_string() }),
            );
            return;
        }
    };
    if request
        .headers
        .get("authorization")
        .map(|value| value == &format!("Bearer {}", data.token))
        .unwrap_or(false)
        == false
    {
        write_response(
            &mut stream,
            401,
            &json!({ "ok": false, "error": "missing or invalid bearer token" }),
        );
        return;
    }

    let focused = data
        .app
        .get_webview_window("main")
        .and_then(|window| window.is_focused().ok())
        .unwrap_or(false);
    data.foreground.store(focused, Ordering::Relaxed);
    let path = request.path.split('?').next().unwrap_or(&request.path);
    match (request.method.as_str(), path) {
        ("GET", "/health") => {
            let tray = data
                .tray_state
                .lock()
                .map(|value| value.clone())
                .unwrap_or_else(|_| "unknown".to_string());
            write_response(
                &mut stream,
                200,
                &json!({
                    "ok": true,
                    "service": "dsh-desktop",
                    "foreground": focused,
                    "tray": tray
                }),
            );
        }
        ("POST", "/notify") => {
            let payload: NotificationPayload = match parse_json(&request.body) {
                Ok(payload) => payload,
                Err(error) => {
                    write_response(&mut stream, 400, &json!({ "ok": false, "error": error }));
                    return;
                }
            };
            let title = clamp_text(payload.title.as_deref().unwrap_or("DSH Desktop"), 120);
            let mut body = clamp_text(payload.body.as_deref().unwrap_or("任务已完成"), 500);
            if let Some(session_id) = payload.session_id {
                if !session_id.is_empty() {
                    body.push_str(&format!("  [{session_id}]"));
                }
            }
            let result = data
                .app
                .notification()
                .builder()
                .title(title)
                .body(body)
                .show();
            match result {
                Ok(()) => write_response(&mut stream, 200, &json!({ "ok": true })),
                Err(error) => write_response(
                    &mut stream,
                    200,
                    &json!({ "ok": false, "warning": error.to_string() }),
                ),
            }
        }
        ("POST", "/tray") => {
            let payload: TrayPayload = match parse_json(&request.body) {
                Ok(payload) => payload,
                Err(error) => {
                    write_response(&mut stream, 400, &json!({ "ok": false, "error": error }));
                    return;
                }
            };
            let state = match payload.state.as_deref() {
                Some("busy") => "busy",
                _ => "idle",
            };
            if let Ok(mut current) = data.tray_state.lock() {
                *current = state.to_string();
            }
            if let Some(tray) = data.app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(format!("DSH Desktop · {state}")));
            }
            write_response(&mut stream, 200, &json!({ "ok": true, "state": state }));
        }
        ("POST", "/pick-folder") => {
            let path = rfd::FileDialog::new()
                .set_title("选择 DSH 工作区")
                .pick_folder();
            let response = PickFolderResponse {
                ok: path.is_some(),
                path: path.map(|path| path.to_string_lossy().to_string()),
            };
            if let Some(path) = response.path.as_deref() {
                remember_workspace(&data.store, path);
            }
            write_response(&mut stream, 200, &response);
        }
        ("POST", "/focus") => {
            show_main_window(&data.app);
            write_response(&mut stream, 200, &json!({ "ok": true }));
        }
        _ => write_response(
            &mut stream,
            404,
            &json!({ "ok": false, "error": "not found" }),
        ),
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn remember_workspace(store: &StateStore, path: &str) {
    let path = std::path::Path::new(path);
    if !path.is_dir() {
        return;
    }
    if let Ok(mut state) = store.load() {
        state.remember_workspace(path);
        let _ = store.save(&state);
    }
}

fn clamp_text(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn parse_json<T: for<'de> serde::Deserialize<'de>>(body: &[u8]) -> Result<T, String> {
    serde_json::from_slice(body).map_err(|error| error.to_string())
}

struct Request {
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> io::Result<Request> {
    const MAX_REQUEST: usize = 256 * 1024;
    let mut buffer = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 4096];
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "request closed",
            ));
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > MAX_REQUEST {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
        if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break position;
        }
    };
    let head = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = head.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing request line"))?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing method"))?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing path"))?
        .to_string();
    let mut headers = std::collections::HashMap::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_REQUEST {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "body too large"));
    }
    let body_start = header_end + 4;
    while buffer.len() < body_start + content_length {
        let mut chunk = [0_u8; 4096];
        let count = stream.read(&mut chunk)?;
        if count == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "body closed"));
        }
        buffer.extend_from_slice(&chunk[..count]);
        if buffer.len() > MAX_REQUEST {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "request too large",
            ));
        }
    }
    Ok(Request {
        method,
        path,
        headers,
        body: buffer[body_start..body_start + content_length].to_vec(),
    })
}

fn write_response<T: Serialize>(stream: &mut TcpStream, status: u16, body: &T) {
    let payload = serde_json::to_vec(body).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(&payload);
    let _ = stream.flush();
}
