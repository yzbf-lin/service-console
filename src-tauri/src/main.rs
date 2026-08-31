fn main() {
    if let Some(exit_code) = service_console::update_helper::run_from_args() {
        std::process::exit(exit_code);
    }
    if let Some(exit_code) = service_console::process_guardian::run_from_args() {
        std::process::exit(exit_code);
    }
    service_console::run_desktop();
}
