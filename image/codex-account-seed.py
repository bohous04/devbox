#!/usr/bin/env python3
"""Seed reviewed shared settings into a new account; never copy auth or history.

Subsequent changes are account-local. MCP server definitions (including the
existing configured MCP headers) are reused, but MCP OAuth credentials are not.
Plugin declarations/cache are intentionally not copied: plugin installation and
account-scoped connectors must be set up for the selected home separately.
"""
import datetime
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import tomllib


CONFIG_KEYS = {
    "model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity",
    "model_context_window", "model_auto_compact_token_limit", "review_model",
    "approval_policy", "sandbox_mode", "sandbox_workspace_write", "permissions",
    "shell_environment_policy", "mcp_servers", "features", "tui", "notice",
    "history", "instructions", "developer_instructions", "personality",
    "web_search", "file_opener", "hide_agent_reasoning", "show_raw_agent_reasoning",
    "suppress_unstable_features_warning", "check_for_update_on_startup",
}


def toml_value(value):
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and math.isfinite(value):
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(json.dumps(key) + " = " + toml_value(item) for key, item in value.items()) + " }"
    raise ValueError("unsupported configuration value")


def create_file(path, contents):
    descriptor, temporary = tempfile.mkstemp(prefix=".codex-account-seed-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        os.unlink(temporary)


def main():
    source, target = (Path(arg) for arg in sys.argv[1:])
    if source.resolve() == target.resolve():
        raise ValueError("account home must differ from the shared home")
    if not target.is_dir():
        raise ValueError("account profile is not mounted")
    config_path = target / "config.toml"
    if config_path.is_symlink():
        raise ValueError("account config must be its own regular file")
    if not config_path.exists():
        source_config = source / "config.toml"
        config = tomllib.loads(source_config.read_text()) if source_config.is_file() else {}
        selected = {key: value for key, value in config.items() if key in CONFIG_KEYS}
        selected["cli_auth_credentials_store"] = "file"
        selected["sqlite_home"] = str(target)
        # Serialize whole top-level values as inline tables: TOML remains valid
        # even for dotted MCP names, literal newlines and nested tool settings.
        create_file(config_path, "".join(json.dumps(key) + " = " + toml_value(value) + "\n" for key, value in selected.items()))
    hooks = target / "hooks.json"
    if hooks.is_symlink():
        raise ValueError("account hooks must be their own regular file")
    if not hooks.exists() and (source / "hooks.json").is_file():
        create_file(hooks, (source / "hooks.json").read_text())
    for name in ("AGENTS.md", "skills", "prompts"):
        dest = target / name
        if not dest.exists() and not dest.is_symlink() and (source / name).exists():
            try:
                dest.symlink_to((source / name).resolve(), target_is_directory=(source / name).is_dir())
            except FileExistsError:
                pass


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tomllib.TOMLDecodeError):
        # Configuration may contain MCP credentials; never expose its contents.
        print("Codex: cannot prepare the standalone account configuration; check config.toml and the profile permissions.", file=sys.stderr)
        sys.exit(1)
