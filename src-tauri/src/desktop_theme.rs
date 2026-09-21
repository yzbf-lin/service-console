use tauri::{Theme, WebviewWindow, window::Color};

// Keep the native titlebar, web theme-color and --chrome-background in sync.
fn chrome_color(theme: Theme) -> Color {
    match theme {
        Theme::Dark => Color(28, 43, 64, 255),
        _ => Color(231, 238, 247, 255),
    }
}

pub(crate) fn preferred_theme(preference: &str) -> Option<Theme> {
    match preference {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

pub(crate) fn apply_chrome(window: &WebviewWindow, theme: Theme) -> tauri::Result<()> {
    window.set_background_color(Some(chrome_color(theme)))
}

pub(crate) fn apply_preference(window: &WebviewWindow, preference: &str) -> tauri::Result<()> {
    let theme = preferred_theme(preference);
    // None releases the native appearance override so system changes keep working.
    window.set_theme(theme)?;
    let resolved = match theme {
        Some(theme) => theme,
        None => window.theme()?,
    };
    apply_chrome(window, resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_preference_does_not_force_a_native_appearance() {
        assert_eq!(preferred_theme("system"), None);
        assert_eq!(preferred_theme("light"), Some(Theme::Light));
        assert_eq!(preferred_theme("dark"), Some(Theme::Dark));
    }

    #[test]
    fn native_chrome_matches_both_web_palettes() {
        let css = include_str!("../../web/app/globals.css");
        let web_colors = include_str!("../../web/lib/theme-colors.ts");
        for theme in [Theme::Light, Theme::Dark] {
            let Color(r, g, b, a) = chrome_color(theme);
            let hex = format!("#{r:02x}{g:02x}{b:02x}");
            assert_eq!(a, 255);
            assert!(css.contains(&format!("--chrome-background: {hex};")));
            assert!(web_colors.contains(&format!("\"{hex}\"")));
        }
    }
}
