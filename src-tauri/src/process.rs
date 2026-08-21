use crate::runtime::{LocalRuntime, RuntimeManager};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream, ToSocketAddrs},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use url::Url;

#[derive(Debug)]
pub struct DshProcess {
    child: Arc<Mutex<Child>>,
    _job: JobObject,
    pub url: String,
}

impl DshProcess {
    pub fn spawn<F>(
        manager: &RuntimeManager,
        version: &str,
        workspace: &Path,
        dsh_home: &Path,
        control_url: &str,
        token: &str,
        environment: &BTreeMap<String, String>,
        on_log: F,
    ) -> Result<Self, String>
    where
        F: FnMut(String) + Send + 'static,
    {
        if !workspace.is_dir() {
            return Err(format!("工作区不存在或不是目录: {}", workspace.display()));
        }
        let node = manager.node_command();
        let bin = manager.dsh_bin(version)?;
        if !bin.is_file() {
            return Err(format!("运行时 {version} 未就绪: {}", bin.display()));
        }
        let args = vec![
            bin.to_string_lossy().to_string(),
            "web".to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "0".to_string(),
        ];
        Self::spawn_with_command(
            manager,
            version,
            workspace,
            dsh_home,
            control_url,
            token,
            environment,
            node,
            args,
            on_log,
        )
    }

    pub fn spawn_local<F>(
        manager: &RuntimeManager,
        local: &LocalRuntime,
        workspace: &Path,
        dsh_home: &Path,
        control_url: &str,
        token: &str,
        environment: &BTreeMap<String, String>,
        on_log: F,
    ) -> Result<Self, String>
    where
        F: FnMut(String) + Send + 'static,
    {
        let args = vec![
            "--no-install".to_string(),
            "@deepseek-ai/dsh".to_string(),
            "web".to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "0".to_string(),
        ];
        Self::spawn_with_command(
            manager,
            &local.version,
            workspace,
            dsh_home,
            control_url,
            token,
            environment,
            local.command.clone(),
            args,
            on_log,
        )
    }

    fn spawn_with_command<F>(
        manager: &RuntimeManager,
        version: &str,
        workspace: &Path,
        dsh_home: &Path,
        control_url: &str,
        token: &str,
        environment: &BTreeMap<String, String>,
        program: std::path::PathBuf,
        args: Vec<String>,
        on_log: F,
    ) -> Result<Self, String>
    where
        F: FnMut(String) + Send + 'static,
    {
        if !workspace.is_dir() {
            return Err(format!("工作区不存在或不是目录: {}", workspace.display()));
        }
        manager.ensure_layout().map_err(|error| error.to_string())?;
        let port = reserve_local_port()?;
        let url = format!("http://127.0.0.1:{port}");
        let mut args = args;
        set_port_argument(&mut args, port);
        let log_path = manager.logs_dir().join(format!("dsh-{}.log", timestamp()));
        let log_file = Arc::new(Mutex::new(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .map_err(|error| format!("无法创建日志文件 {}: {error}", log_path.display()))?,
        ));
        let callback = Arc::new(Mutex::new(on_log));

        let mut command = Command::new(&program);
        hide_console_window(&mut command);
        command
            .args(&args)
            .current_dir(workspace)
            .env("DSH_HOME", dsh_home)
            .env("DSH_DESKTOP_CTRL", control_url)
            .env("DSH_DESKTOP_TOKEN", token)
            .env("DSH_DESKTOP_VERSION", version)
            .envs(environment)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        emit(
            &callback,
            format!(
                "启动 dsh {version}: {} {}",
                program.display(),
                args.join(" ")
            ),
        );

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 dsh 子进程（{}）: {error}", program.display()))?;
        let job = JobObject::new().map_err(|error| {
            let _ = child.kill();
            format!("创建 Windows Job Object 失败: {error}")
        })?;
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            return Err(format!("将 dsh 加入 Job Object 失败: {error}"));
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(output) = stdout {
            spawn_reader("stdout", output, log_file.clone(), callback.clone());
        }
        if let Some(output) = stderr {
            spawn_reader("stderr", output, log_file.clone(), callback.clone());
        }

        let child = Arc::new(Mutex::new(child));
        let deadline = Instant::now() + Duration::from_secs(90);
        if let Err(error) = wait_for_health(&child, &url, deadline) {
            let _ = child.lock().map(|mut process| process.kill());
            return Err(error);
        }
        emit(&callback, format!("dsh 已就绪: {url}"));
        Ok(Self {
            child,
            _job: job,
            url,
        })
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "dsh 子进程锁已损坏".to_string())?;
        if child
            .try_wait()
            .map_err(|error| format!("读取 dsh 状态失败: {error}"))?
            .is_some()
        {
            return Ok(());
        }
        child
            .kill()
            .map_err(|error| format!("停止 dsh 失败: {error}"))?;
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if child
                .try_wait()
                .map_err(|error| format!("等待 dsh 退出失败: {error}"))?
                .is_some()
            {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.child
            .lock()
            .ok()
            .and_then(|mut child| child.try_wait().ok())
            .map(|status| status.is_none())
            .unwrap_or(false)
    }
}

#[cfg(windows)]
fn hide_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_command: &mut Command) {}

fn emit<F>(callback: &Arc<Mutex<F>>, message: String)
where
    F: FnMut(String),
{
    if let Ok(mut callback) = callback.lock() {
        callback(message);
    }
}

fn spawn_reader<R>(
    label: &'static str,
    output: R,
    log_file: Arc<Mutex<File>>,
    callback: Arc<Mutex<impl FnMut(String) + Send + 'static>>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let line = match line {
                Ok(line) => line,
                Err(error) => format!("[{label}] <读取失败: {error}>"),
            };
            append_log(&log_file, &format!("[{label}] {line}"));
            emit(&callback, line.clone());
        }
    });
}

fn append_log(file: &Arc<Mutex<File>>, line: &str) {
    if let Ok(mut file) = file.lock() {
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
    }
}

fn reserve_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("无法申请本地端口: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("读取本地端口失败: {error}"))
}

fn set_port_argument(args: &mut Vec<String>, port: u16) {
    if let Some(index) = args.iter().position(|argument| argument == "--port") {
        if let Some(value) = args.get_mut(index + 1) {
            *value = port.to_string();
            return;
        }
    }
    args.extend(["--port".to_string(), port.to_string()]);
}

fn wait_for_health(child: &Arc<Mutex<Child>>, url: &str, deadline: Instant) -> Result<(), String> {
    while Instant::now() < deadline {
        if let Ok(Ok(Some(status))) = child.lock().map(|mut process| process.try_wait()) {
            return Err(format!(
                "dsh 在 Web UI 就绪前退出，退出码 {:?}: {url}",
                status.code()
            ));
        }
        match http_status(url) {
            Ok(status) if (200..500).contains(&status) => return Ok(()),
            Ok(_) | Err(_) => thread::sleep(Duration::from_millis(250)),
        }
    }
    Err(format!("等待 dsh Web UI 就绪超时（90 秒）: {url}"))
}

fn http_status(base_url: &str) -> Result<u16, String> {
    let parsed = Url::parse(base_url).map_err(|error| error.to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "本地地址没有 host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "本地地址没有 port".to_string())?;
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|error| error.to_string())?
        .next()
        .ok_or_else(|| "无法解析本地地址".to_string())?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))
        .map_err(|error| error.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    write!(
        stream,
        "GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .take(1024)
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    response
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .ok_or_else(|| "本地健康检查返回无效 HTTP 响应".to_string())
}

fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{reserve_local_port, set_port_argument};

    #[test]
    fn replaces_requested_port_with_a_reserved_local_port() {
        let port = reserve_local_port().expect("a local port should be available");
        let mut args = vec!["web".to_string(), "--port".to_string(), "0".to_string()];
        set_port_argument(&mut args, port);
        assert_eq!(
            args,
            vec!["web".to_string(), "--port".to_string(), port.to_string()]
        );
    }

    #[test]
    fn adds_port_when_the_command_does_not_have_one() {
        let mut args = vec!["web".to_string()];
        set_port_argument(&mut args, 12345);
        assert_eq!(
            args,
            vec!["web".to_string(), "--port".to_string(), "12345".to_string()]
        );
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct JobObject {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for JobObject {}

#[cfg(windows)]
unsafe impl Sync for JobObject {}

#[cfg(windows)]
impl JobObject {
    fn new() -> io::Result<Self> {
        use std::{mem, ptr};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle == std::ptr::null_mut() {
            return Err(io::Error::last_os_error());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if result == 0 {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    fn assign(&self, child: &Child) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        let process = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        let result = unsafe {
            windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.handle, process)
        };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(not(windows))]
#[derive(Debug)]
struct JobObject;

#[cfg(not(windows))]
impl JobObject {
    fn new() -> io::Result<Self> {
        Ok(Self)
    }

    fn assign(&self, _child: &Child) -> io::Result<()> {
        Ok(())
    }
}
