use std::{
    collections::BTreeMap,
    io::{self, Stdout},
    net::IpAddr,
    path::PathBuf,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, TableState},
};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use service_console::{
    manager::ServiceManager,
    runtime::{RuntimeConnection, load_runtime, runtime_path},
    server::start_controller,
};

const DEFAULT_URL: &str = "http://127.0.0.1:8787";

#[derive(Parser)]
#[command(name = "service-console", version, about)]
struct Args {
    #[arg(long, env = "SERVICE_CONSOLE_URL")]
    url: Option<String>,
    #[arg(long, env = "SERVICE_CONSOLE_TOKEN")]
    token: Option<String>,
    #[arg(long, env = "SERVICE_CONSOLE_RUNTIME_FILE", default_value_os_t = runtime_path("~/.service-console"))]
    runtime_file: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, default_value = "127.0.0.1")]
        host: IpAddr,
        #[arg(long, default_value_t = 8787)]
        port: u16,
        #[arg(long, default_value = "~/.service-console")]
        data_dir: PathBuf,
        #[arg(long)]
        token: Option<String>,
    },
    Add {
        name: String,
        #[arg(long)]
        command: String,
        #[arg(long)]
        cwd: String,
        #[arg(long = "env", value_parser = parse_env)]
        env: Vec<(String, String)>,
        #[arg(long)]
        auto_start: bool,
        #[arg(long, default_value_t = 5.0)]
        stop_timeout: f64,
    },
    List,
    Ports {
        #[arg(long)]
        port: Option<u16>,
    },
    KillProcess {
        pid: u32,
        #[arg(long = "port")]
        expected_port: Option<u16>,
        #[arg(long)]
        force: bool,
        #[arg(long, default_value_t = 3.0)]
        timeout: f64,
    },
    Start {
        name: String,
    },
    Stop {
        name: String,
    },
    Restart {
        name: String,
    },
    Delete {
        name: String,
    },
    Logs {
        name: String,
        #[arg(long, default_value_t = 500)]
        tail: usize,
        #[arg(long)]
        follow: bool,
    },
    Tui,
}

fn parse_env(value: &str) -> Result<(String, String), String> {
    let Some((key, value)) = value.split_once('=') else {
        return Err(format!(
            "Invalid environment value {value:?}; expected KEY=VALUE"
        ));
    };
    if key.is_empty() {
        return Err("environment key must not be empty".into());
    }
    Ok((key.into(), value.into()))
}

#[derive(Clone)]
struct Connection {
    url: String,
    token: Option<String>,
}

fn connection(args: &Args) -> Result<Connection> {
    if let Some(url) = &args.url {
        return Ok(Connection {
            url: url.trim_end_matches('/').into(),
            token: args.token.clone(),
        });
    }
    let runtime = load_runtime(&args.runtime_file)?;
    Ok(match runtime {
        Some(RuntimeConnection {
            base_url, token, ..
        }) => Connection {
            url: base_url.trim_end_matches('/').into(),
            token: args.token.clone().or(Some(token)),
        },
        None => Connection {
            url: DEFAULT_URL.into(),
            token: args.token.clone(),
        },
    })
}

async fn request(
    connection: &Connection,
    method: Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value> {
    let client = Client::new();
    let mut request = client.request(method, format!("{}{}", connection.url, path));
    if let Some(token) = &connection.token {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("Unable to reach {}", connection.url))?;
    let status = response.status();
    let bytes = response.bytes().await?;
    let payload = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"detail": String::from_utf8_lossy(&bytes)}))
    };
    if !status.is_success() {
        bail!(
            "HTTP {}: {}",
            status.as_u16(),
            payload.get("detail").unwrap_or(&payload)
        );
    }
    Ok(payload)
}

fn encoded(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn print_service(service: &Value) {
    println!(
        "{}: {}",
        service.get("name").and_then(Value::as_str).unwrap_or("-"),
        service.get("state").and_then(Value::as_str).unwrap_or("-")
    );
}

#[tokio::main]
async fn main() -> Result<()> {
    if let Some(exit_code) = service_console::process_guardian::run_from_args() {
        std::process::exit(exit_code);
    }
    let args = Args::parse();
    if let Command::Serve {
        host,
        port,
        data_dir,
        token,
    } = &args.command
    {
        let manager = ServiceManager::new(data_dir)?;
        let static_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/static");
        let controller =
            start_controller(manager.clone(), *host, *port, token.clone(), static_dir).await?;
        println!("Service Console listening on {}", controller.base_url());
        tokio::signal::ctrl_c().await?;
        manager.shutdown().await;
        controller.shutdown().await;
        return Ok(());
    }

    let connection = connection(&args)?;
    match &args.command {
        Command::Add {
            name,
            command,
            cwd,
            env,
            auto_start,
            stop_timeout,
        } => {
            let env: BTreeMap<_, _> = env.iter().cloned().collect();
            let payload = request(&connection, Method::POST, "/api/services", Some(json!({"name":name,"command":command,"cwd":cwd,"env":env,"auto_start":auto_start,"stop_timeout":stop_timeout}))).await?;
            print_service(&payload["service"]);
        }
        Command::List => {
            let payload = request(&connection, Method::GET, "/api/services", None).await?;
            let services = payload["services"].as_array().cloned().unwrap_or_default();
            if services.is_empty() {
                println!("No services registered.");
            } else {
                println!("{:<24} {:<10} {:<8} COMMAND", "NAME", "STATE", "PID");
                for service in services {
                    println!(
                        "{:<24} {:<10} {:<8} {}",
                        service["name"].as_str().unwrap_or("-"),
                        service["state"].as_str().unwrap_or("-"),
                        service["pid"]
                            .as_u64()
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "-".into()),
                        service["command"].as_str().unwrap_or("-")
                    );
                }
            }
        }
        Command::Ports { port } => {
            let suffix = port
                .map(|value| format!("?port={value}"))
                .unwrap_or_default();
            let payload = request(
                &connection,
                Method::GET,
                &format!("/api/ports{suffix}"),
                None,
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&payload["ports"])?);
        }
        Command::KillProcess {
            pid,
            expected_port,
            force,
            timeout,
        } => {
            let payload = request(
                &connection,
                Method::POST,
                &format!("/api/processes/{pid}/terminate"),
                Some(json!({"expected_port":expected_port,"force":force,"timeout":timeout})),
            )
            .await?;
            println!("{}", serde_json::to_string_pretty(&payload["result"])?);
        }
        Command::Start { name } | Command::Stop { name } | Command::Restart { name } => {
            let action = match &args.command {
                Command::Start { .. } => "start",
                Command::Stop { .. } => "stop",
                _ => "restart",
            };
            let payload = request(
                &connection,
                Method::POST,
                &format!("/api/services/{}/{action}", encoded(name)),
                None,
            )
            .await?;
            print_service(&payload["service"]);
        }
        Command::Delete { name } => {
            request(
                &connection,
                Method::DELETE,
                &format!("/api/services/{}", encoded(name)),
                None,
            )
            .await?;
            println!("Deleted {name}");
        }
        Command::Logs { name, tail, follow } => {
            let payload = request(
                &connection,
                Method::GET,
                &format!("/api/services/{}/logs?tail={tail}", encoded(name)),
                None,
            )
            .await?;
            for entry in payload["logs"].as_array().into_iter().flatten() {
                print_log(entry);
            }
            if *follow {
                follow_logs(&connection, name).await?;
            }
        }
        Command::Tui => run_tui(&connection).await?,
        Command::Serve { .. } => unreachable!(),
    }
    Ok(())
}

fn print_log(entry: &Value) {
    println!(
        "[{} {}] {}",
        entry["timestamp"].as_str().unwrap_or(""),
        entry["stream"].as_str().unwrap_or(""),
        entry["message"].as_str().unwrap_or("")
    );
}

async fn follow_logs(connection: &Connection, service: &str) -> Result<()> {
    use futures_util::StreamExt;

    let mut url = url::Url::parse(&connection.url)
        .with_context(|| format!("Invalid controller URL: {}", connection.url))?;
    let websocket_scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(websocket_scheme)
        .map_err(|_| anyhow::anyhow!("Unsupported controller URL scheme"))?;
    url.set_path("/ws/events");
    url.set_query(None);
    if let Some(token) = connection.token.as_deref() {
        url.query_pairs_mut().append_pair("token", token);
    }
    let (mut socket, _) = tokio_tungstenite::connect_async(url.as_str())
        .await
        .with_context(|| format!("Log stream connection failed: {url}"))?;
    loop {
        tokio::select! {
            message = socket.next() => {
                let Some(message) = message else { bail!("Log stream disconnected") };
                let message = message.context("Log stream disconnected")?;
                if message.is_close() {
                    bail!("Log stream disconnected");
                }
                let Ok(text) = message.to_text() else { continue };
                let Ok(event) = serde_json::from_str::<Value>(text) else { continue };
                if event["type"] == "log" && event["service"] == service {
                    print_log(&event["data"]);
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal?;
                break;
            }
        }
    }
    Ok(())
}

struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalSession {
    fn enter() -> Result<Self> {
        use crossterm::{execute, terminal::EnterAlternateScreen};
        crossterm::terminal::enable_raw_mode()?;
        let mut output = io::stdout();
        execute!(output, EnterAlternateScreen)?;
        let mut terminal = Terminal::new(CrosstermBackend::new(output))?;
        terminal.clear()?;
        Ok(Self { terminal })
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        use crossterm::{execute, terminal::LeaveAlternateScreen};
        let _ = crossterm::terminal::disable_raw_mode();
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
    }
}

async fn run_tui(connection: &Connection) -> Result<()> {
    use crossterm::event::{self, Event, KeyCode, KeyEventKind};
    let mut session = TerminalSession::enter()?;
    let mut services = Vec::new();
    let mut selected = 0_usize;
    let mut message = String::new();
    let mut last_refresh = Instant::now() - Duration::from_secs(2);

    loop {
        if last_refresh.elapsed() >= Duration::from_secs(1) {
            match request(connection, Method::GET, "/api/services", None).await {
                Ok(payload) => {
                    services = payload["services"].as_array().cloned().unwrap_or_default();
                    selected = selected.min(services.len().saturating_sub(1));
                    message.clear();
                }
                Err(error) => message = error.to_string(),
            }
            last_refresh = Instant::now();
        }

        session.terminal.draw(|frame| {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints([
                    Constraint::Length(3),
                    Constraint::Min(6),
                    Constraint::Length(5),
                    Constraint::Length(2),
                ])
                .split(frame.area());
            frame.render_widget(
                Paragraph::new("Service Console · Rust TUI")
                    .style(
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::BOLD),
                    )
                    .block(Block::default().borders(Borders::ALL)),
                chunks[0],
            );
            let rows = services.iter().map(|service| {
                Row::new([
                    Cell::from(service["name"].as_str().unwrap_or("-")),
                    Cell::from(service["state"].as_str().unwrap_or("-")),
                    Cell::from(
                        service["pid"]
                            .as_u64()
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| "-".into()),
                    ),
                    Cell::from(service["command"].as_str().unwrap_or("-")),
                ])
            });
            let table = Table::new(
                rows,
                [
                    Constraint::Length(24),
                    Constraint::Length(12),
                    Constraint::Length(9),
                    Constraint::Min(20),
                ],
            )
            .header(
                Row::new(["NAME", "STATE", "PID", "COMMAND"])
                    .style(Style::default().add_modifier(Modifier::BOLD)),
            )
            .row_highlight_style(Style::default().bg(Color::DarkGray).fg(Color::White))
            .highlight_symbol("▶ ")
            .block(Block::default().borders(Borders::ALL).title("Services"));
            let mut state =
                TableState::default().with_selected((!services.is_empty()).then_some(selected));
            frame.render_stateful_widget(table, chunks[1], &mut state);

            let detail = services.get(selected).map_or_else(
                || "No services registered".to_owned(),
                |service| {
                    format!(
                        "cwd: {}\nuptime: {:.1}s  memory: {} bytes\nlast error: {}",
                        service["cwd"].as_str().unwrap_or("-"),
                        service["uptime_seconds"].as_f64().unwrap_or(0.0),
                        service["memory_rss"].as_u64().unwrap_or(0),
                        service["last_error"].as_str().unwrap_or("-")
                    )
                },
            );
            frame.render_widget(
                Paragraph::new(detail)
                    .block(Block::default().borders(Borders::ALL).title("Detail")),
                chunks[2],
            );
            let footer = if message.is_empty() {
                "↑/↓ select · Enter start/stop · R restart · r refresh · q quit".to_owned()
            } else {
                format!("{message} · q quit")
            };
            frame.render_widget(
                Paragraph::new(footer).style(Style::default().fg(if message.is_empty() {
                    Color::Gray
                } else {
                    Color::Red
                })),
                chunks[3],
            );
        })?;

        if event::poll(Duration::from_millis(100))?
            && let Event::Key(key) = event::read()?
            && key.kind == KeyEventKind::Press
        {
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => break,
                KeyCode::Down | KeyCode::Char('j') => {
                    selected = (selected + 1).min(services.len().saturating_sub(1));
                }
                KeyCode::Up | KeyCode::Char('k') => selected = selected.saturating_sub(1),
                KeyCode::Char('r') => last_refresh = Instant::now() - Duration::from_secs(2),
                KeyCode::Enter | KeyCode::Char('R') => {
                    if let Some(service) = services.get(selected) {
                        let name = service["name"].as_str().unwrap_or_default();
                        let action = if key.code == KeyCode::Char('R') {
                            "restart"
                        } else if matches!(service["state"].as_str(), Some("RUNNING" | "STARTING"))
                        {
                            "stop"
                        } else {
                            "start"
                        };
                        match request(
                            connection,
                            Method::POST,
                            &format!("/api/services/{}/{action}", encoded(name)),
                            None,
                        )
                        .await
                        {
                            Ok(_) => {
                                message = format!("{action}: {name}");
                                last_refresh = Instant::now() - Duration::from_secs(2);
                            }
                            Err(error) => message = error.to_string(),
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}
