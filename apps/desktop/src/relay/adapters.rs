use super::*;

pub(crate) fn adapter_endpoint_for_product(product_id: &str) -> Option<String> {
    external_adapter_endpoint_for_product(product_id)
        .or_else(|| managed_adapter_endpoint_for_product(product_id))
}

pub(crate) fn external_adapter_endpoint_for_product(product_id: &str) -> Option<String> {
    let specific = format!(
        "PANDA_BRIDGE_ADAPTER_{}_URL",
        product_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            })
            .collect::<String>()
    );
    env::var(&specific)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env::var("PANDA_BRIDGE_ADAPTER_URL").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn managed_adapter_endpoint_for_product(product_id: &str) -> Option<String> {
    let product_id = product_id.trim();
    if product_id.is_empty() {
        return None;
    }
    {
        let mut processes = managed_adapters().lock().ok()?;
        if let Some(process) = processes.get_mut(product_id) {
            match process.child.try_wait() {
                Ok(None) => return Some(process.endpoint.clone()),
                Ok(Some(_)) | Err(_) => {
                    processes.remove(product_id);
                }
            }
        }
    }
    let manifest_path = find_managed_adapter_manifest(product_id)?;
    let mut started = start_managed_adapter(&manifest_path).ok()?;
    if started.product_id != product_id {
        let _ = started.child.kill();
        return None;
    }
    let endpoint = started.endpoint.clone();
    let mut processes = managed_adapters().lock().ok()?;
    processes.insert(product_id.to_string(), started);
    Some(endpoint)
}

pub(crate) fn managed_adapters() -> &'static Mutex<HashMap<String, ManagedAdapterProcess>> {
    static MANAGED: OnceLock<Mutex<HashMap<String, ManagedAdapterProcess>>> = OnceLock::new();
    MANAGED.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn find_managed_adapter_manifest(product_id: &str) -> Option<PathBuf> {
    let mut roots = Vec::new();
    for key in [
        "PANDA_BRIDGE_MANAGED_ADAPTERS_DIR",
        "PANDA_BRIDGE_ADAPTERS_DIR",
    ] {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                roots.push(PathBuf::from(trimmed));
            }
        }
    }
    roots.extend(default_managed_adapter_roots());
    for root in roots {
        let manifest = root.join(product_id).join("adapter.manifest.json");
        if manifest.is_file() {
            return Some(manifest);
        }
    }
    None
}

pub(crate) fn default_managed_adapter_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.join("adapters"));
            if cfg!(target_os = "macos") {
                if let Some(contents) = dir.parent() {
                    roots.push(contents.join("Resources").join("adapters"));
                }
            }
        }
    }
    if let Ok(cwd) = env::current_dir() {
        roots.push(cwd.join("adapters"));
        roots.push(cwd.join("dist").join("bridge-adapters"));
    }
    roots
}

pub(crate) fn start_managed_adapter(manifest_path: &Path) -> Result<ManagedAdapterProcess, String> {
    let text = fs::read_to_string(manifest_path)
        .map_err(|error| format!("adapter_manifest_read_failed: {error}"))?;
    let manifest: ManagedAdapterManifest = serde_json::from_str(&text)
        .map_err(|error| format!("adapter_manifest_invalid: {error}"))?;
    if manifest.runtime.runtime_type != "node" {
        return Err(format!(
            "adapter_runtime_unsupported: {}",
            manifest.runtime.runtime_type
        ));
    }
    let manifest_dir = manifest_path
        .parent()
        .ok_or_else(|| "adapter_manifest_parent_missing".to_string())?;
    let cwd = manifest
        .runtime
        .cwd
        .as_ref()
        .map(|value| manifest_dir.join(value))
        .unwrap_or_else(|| manifest_dir.to_path_buf());
    let entry = manifest_dir.join(&manifest.runtime.entry);
    if !entry.is_file() {
        return Err(format!("adapter_entry_missing: {}", entry.display()));
    }
    let mut command = Command::new(node_runtime_command());
    command
        .arg(entry)
        .args(&manifest.runtime.args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| format!("adapter_spawn_failed: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "adapter_stdout_missing".to_string())?;
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader.read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
    });
    let ready_line = match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => {
            let _ = child.kill();
            return Err(format!("adapter_ready_read_failed: {error}"));
        }
        Err(_) => {
            let _ = child.kill();
            return Err("adapter_ready_timeout".to_string());
        }
    };
    let ready: Value = serde_json::from_str(ready_line.trim()).map_err(|error| {
        let _ = child.kill();
        format!("adapter_ready_invalid_json: {error}")
    })?;
    let endpoint = ready
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            let _ = child.kill();
            "adapter_ready_url_missing".to_string()
        })?
        .to_string();
    Ok(ManagedAdapterProcess {
        product_id: manifest.product_id,
        endpoint,
        manifest_path: manifest_path.to_path_buf(),
        product_name: manifest.product_name,
        child,
        started_at: Instant::now(),
    })
}

pub(crate) fn node_runtime_command() -> PathBuf {
    if let Ok(value) = env::var("PANDA_BRIDGE_NODE") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            if cfg!(target_os = "macos") {
                if let Some(contents) = dir.parent() {
                    let candidate = contents
                        .join("Resources")
                        .join("runtime")
                        .join("node")
                        .join("bin")
                        .join("node");
                    if candidate.is_file() {
                        return candidate;
                    }
                }
            }
            let candidate = if cfg!(windows) {
                dir.join("runtime").join("node").join("node.exe")
            } else {
                dir.join("runtime").join("node").join("bin").join("node")
            };
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("node")
}

pub(crate) fn adapter_url_for_product_path(product_id: &str, path: &str) -> Option<String> {
    let endpoint = adapter_endpoint_for_product(product_id)?;
    let mut parsed = url::Url::parse(&endpoint).ok()?;
    parsed.set_path(path);
    parsed.set_query(None);
    Some(parsed.to_string())
}

pub(crate) fn adapter_relay_key_exchange_for_product(product_id: &str) -> Option<Value> {
    let endpoint = adapter_url_for_product_path(product_id, "/v1/relay-key/public")?;
    let response = Client::new().get(&endpoint).send().ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: Value = response.json().ok()?;
    let exchange = payload
        .get("relay_key_exchange")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    if exchange.get("status").and_then(Value::as_str).unwrap_or("") == "available" {
        Some(exchange)
    } else {
        None
    }
}

pub(crate) fn refreshed_connection(credentials: &Credentials) -> Credentials {
    load_credentials()
        .ok()
        .and_then(|stored| {
            credentials_connections(&stored)
                .into_iter()
                .find(|item| realtime_connection_key(item) == realtime_connection_key(credentials))
        })
        .unwrap_or_else(|| credentials.clone())
}
