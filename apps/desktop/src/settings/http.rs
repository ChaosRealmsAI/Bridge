use super::*;

pub(crate) fn get_json<T: for<'de> Deserialize<'de>>(
    url: &str,
    bearer: Option<&str>,
) -> Result<T, String> {
    get_json_with_install(url, bearer, None)
}

pub(crate) fn get_json_with_install<T: for<'de> Deserialize<'de>>(
    url: &str,
    bearer: Option<&str>,
    install_id: Option<&str>,
) -> Result<T, String> {
    get_json_with_client(http_client(), url, bearer, install_id)
}

pub(crate) fn get_json_with_client<T: for<'de> Deserialize<'de>>(
    client: &Client,
    url: &str,
    bearer: Option<&str>,
    install_id: Option<&str>,
) -> Result<T, String> {
    let mut request = client.get(url);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(id) = install_id.filter(|value| !value.trim().is_empty()) {
        request = request.header("x-panda-bridge-install-id", id);
    }
    parse_response(request.send().map_err(|error| error.to_string())?)
}

pub(crate) fn post_json_with_install<T: for<'de> Deserialize<'de>>(
    url: &str,
    body: &Value,
    bearer: Option<&str>,
    install_id: Option<&str>,
) -> Result<T, String> {
    let mut request = http_client()
        .post(url)
        .header("x-panda-bridge-local-client", "desktop")
        .json(body);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(id) = install_id.filter(|value| !value.trim().is_empty()) {
        request = request.header("x-panda-bridge-install-id", id);
    }
    parse_response(request.send().map_err(|error| error.to_string())?)
}

pub(crate) fn delete_json_with_install<T: for<'de> Deserialize<'de>>(
    url: &str,
    bearer: Option<&str>,
    install_id: Option<&str>,
) -> Result<T, String> {
    let mut request = http_client().delete(url);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(id) = install_id.filter(|value| !value.trim().is_empty()) {
        request = request.header("x-panda-bridge-install-id", id);
    }
    parse_response(request.send().map_err(|error| error.to_string())?)
}

pub(crate) fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .pool_idle_timeout(Duration::from_secs(120))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

pub(crate) fn profile_probe_http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(4)
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| Client::new())
    })
}

pub(crate) fn parse_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::blocking::Response,
) -> Result<T, String> {
    let status = response.status();
    let text = response.text().map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    serde_json::from_str(&text)
        .map_err(|error| format!("invalid JSON response: {error}; body={text}"))
}
