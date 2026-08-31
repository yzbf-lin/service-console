fn main() {
    let exit_code = service_console::process_guardian::run_from_args().unwrap_or_else(|| {
        eprintln!("service-console-guardian must be started by Service Console");
        2
    });
    std::process::exit(exit_code);
}
