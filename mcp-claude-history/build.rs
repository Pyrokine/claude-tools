use std::env;
use std::process::Command;

fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn emit_git_rerun_paths() {
    if let Some(head) = command_output("git", &["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head}");
    }
    if let Some(reference) = command_output("git", &["symbolic-ref", "-q", "HEAD"])
        && let Some(path) = command_output("git", &["rev-parse", "--git-path", &reference])
    {
        println!("cargo:rerun-if-changed={path}");
    }
    if let Some(packed_refs) = command_output("git", &["rev-parse", "--git-path", "packed-refs"]) {
        println!("cargo:rerun-if-changed={packed_refs}");
    }
}

fn git_dirty() -> bool {
    command_output("git", &["status", "--porcelain", "--", "."]).is_some()
}

fn main() {
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-env-changed=MCP_HISTORY_BUILD_COMMIT");
    println!("cargo:rerun-if-env-changed=MCP_HISTORY_BUILD_TIMESTAMP");
    println!("cargo:rerun-if-env-changed=MCP_HISTORY_BUILD_DIRTY");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    emit_git_rerun_paths();

    let commit = env::var("MCP_HISTORY_BUILD_COMMIT")
        .ok()
        .or_else(|| command_output("git", &["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());
    let timestamp = env::var("MCP_HISTORY_BUILD_TIMESTAMP")
        .ok()
        .or_else(|| env::var("SOURCE_DATE_EPOCH").ok().map(|value| format!("unix:{value}")))
        .unwrap_or_else(|| "unknown".to_string());
    let dirty = env::var("MCP_HISTORY_BUILD_DIRTY")
        .ok()
        .and_then(|value| value.parse::<bool>().ok())
        .unwrap_or_else(git_dirty);
    let target = env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    let profile = env::var("PROFILE").unwrap_or_else(|_| "unknown".to_string());

    println!("cargo:rustc-env=MCP_HISTORY_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=MCP_HISTORY_BUILD_TIMESTAMP={timestamp}");
    println!("cargo:rustc-env=MCP_HISTORY_BUILD_DIRTY={dirty}");
    println!("cargo:rustc-env=MCP_HISTORY_BUILD_TARGET={target}");
    println!("cargo:rustc-env=MCP_HISTORY_BUILD_PROFILE={profile}");
}
