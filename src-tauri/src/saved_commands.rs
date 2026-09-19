//! Saved-command policy at the existing PTY spawn boundary.
//! Interactive upstream terminals keep their existing shell and cwd behavior.

pub(crate) fn validate(exec: Option<&str>) -> Result<(), String> {
    if let Some(exec) = exec {
        if exec.trim().is_empty() || exec.chars().count() > 4_000 || exec.contains('\0') {
            return Err("Enter a command of at most 4,000 characters without NUL bytes".into());
        }
    }
    Ok(())
}

pub(crate) fn working_dir(cwd: &str) -> Result<std::path::PathBuf, String> {
    let path = crate::fs::expand_home(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err("The saved command's chosen directory is unavailable; choose it again".into());
    }
    Ok(path)
}

#[cfg(any(windows, test))]
pub(crate) fn windows_args(shell: &str, exec: &str) -> Vec<String> {
    let name = shell
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(shell)
        .to_ascii_lowercase();
    match name.strip_suffix(".exe").unwrap_or(&name) {
        "powershell" | "pwsh" => vec![
            "-NoLogo".into(), "-Command".into(),
            format!("$ErrorActionPreference='Stop'; $global:LASTEXITCODE=0; & {{ {exec} }}; if ($LASTEXITCODE) {{ exit $LASTEXITCODE }}"),
        ],
        "cmd" => vec!["/d".into(), "/s".into(), "/c".into(), exec.into()],
        _ => vec!["-l".into(), "-c".into(), exec.into()],
    }
}

/// The command stays one positional argument through the WSL bootstrap.
#[cfg(any(windows, test))]
pub(crate) fn wsl_shell_args(exec: &str) -> Vec<String> {
    [
        "TERM=xterm-256color",
        "COLORTERM=truecolor",
        "TERM_PROGRAM=MonoCode",
        "/bin/sh",
        "-c",
        "exec \"${SHELL:-/bin/sh}\" -l -c \"$1\"",
        "monocode-exec",
        exec,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_limits_and_missing_directories_do_not_fall_back_home() {
        assert!(validate(None).is_ok());
        assert!(validate(Some("printf 'hello'\nexit 7")).is_ok());
        for invalid in ["", " ", "x\0y"] {
            assert!(validate(Some(invalid)).is_err());
        }
        assert!(validate(Some(&"x".repeat(4_001))).is_err());
        assert!(working_dir("relative-repo").is_err());
        let missing =
            std::env::temp_dir().join(format!("monocode-command-missing-{}", std::process::id()));
        assert!(working_dir(&missing.to_string_lossy()).is_err());
        assert!(working_dir(&std::env::temp_dir().to_string_lossy()).is_ok());
    }

    #[test]
    fn shell_arguments_keep_user_text_as_one_argument() {
        let command = "echo 'quoted'; echo \"$HOME\"\nexit 9";
        assert_eq!(
            wsl_shell_args(command).last().map(String::as_str),
            Some(command)
        );
        assert_eq!(
            windows_args("C:\\Windows\\System32\\cmd.exe", command),
            ["/d", "/s", "/c", command]
        );
        assert_eq!(windows_args("bash.exe", command), ["-l", "-c", command]);
        let powershell = windows_args("pwsh.exe", "Write-Error failure");
        assert_eq!(&powershell[..2], ["-NoLogo", "-Command"]);
        assert!(powershell[2].contains("$ErrorActionPreference='Stop'"));
        assert!(powershell[2].contains("$global:LASTEXITCODE=0"));
    }
}
