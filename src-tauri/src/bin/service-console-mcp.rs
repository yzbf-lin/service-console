use std::path::PathBuf;

use clap::Parser;
use service_console::{mcp_bridge, runtime::runtime_path};

#[derive(Parser)]
#[command(name = "service-console-mcp", version)]
struct Args {
    #[arg(long, default_value = "~/.service-console")]
    data_dir: PathBuf,
    #[arg(long, default_value_os_t = runtime_path("~/.service-console"))]
    runtime_file: PathBuf,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    mcp_bridge::run(args.runtime_file, args.data_dir).await
}
