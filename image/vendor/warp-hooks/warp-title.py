#!/usr/bin/env python3
"""Publish foreground Codex/Grok titles and status (also Antigravity status) through tmux, without model calls."""
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import unicodedata

TITLE_FORMAT = "#{?@devd_label,#{@devd_label},#{?@devd_session_name,#{@devd_session_name},#{?@devd_auto_title,#{@devd_auto_title},#{pane_title}}}}"


def clean(value):
    if not isinstance(value, str):
        return ""
    # A title is terminal data: remove escape sequences, controls and bidi overrides.
    value = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", value)
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = "".join(" " if c.isspace() else c for c in value
                    if c.isspace() or not unicodedata.category(c).startswith("C"))
    return " ".join(value.split())[:80]


def saved_title(data, sid, codex_home, grok_home):
    # Antigravity (agy) keeps no title store we read: never fall through to the
    # Codex/Grok lookups, whose metadata could misidentify agy as a child agent.
    if os.environ.get("DEVD_WARP_AGENT") == "agy":
        return ""
    # Grok uses camelCase; its summaries live beside the transcript. The id glob
    # also works for hook versions that omit transcriptPath.
    if "sessionId" in data:
        sessions = grok_home / "sessions"
        candidates = []
        transcript = data.get("transcriptPath") or data.get("transcript_path")
        if isinstance(transcript, str):
            parent = Path(transcript).parent
            if parent.name == sid and sessions.resolve() in parent.resolve().parents:
                candidates.append(parent / "summary.json")
        candidates.extend(sessions.glob(f"*/{sid}/summary.json"))
        for path in candidates:
            try:
                summary = json.loads(path.read_text())
                info = summary.get("info")
                if isinstance(info, dict) and info.get("id", sid) != sid:
                    continue
                kind = summary.get("session_kind")
                if isinstance(kind, str) and kind.startswith("subagent"):
                    return None
                title = clean(summary.get("generated_title")) or clean(summary.get("session_summary"))
                if title:
                    return title
            except (OSError, ValueError, AttributeError):
                continue
        return ""

    # Single indexed, read-only lookup; never read transcripts or scan their content.
    databases = sorted((p for p in codex_home.glob("state_*.sqlite")
                        if re.fullmatch(r"state_[0-9]+\.sqlite", p.name)),
                       key=lambda p: int(p.stem.split("_")[1]), reverse=True)
    for path in databases:
        try:
            with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.1)) as db:
                columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
                names = [name for name in ("name", "title", "thread_source", "source", "agent_path")
                         if name in columns]
                if not names:
                    continue
                row = db.execute(f"SELECT {','.join(names)} FROM threads WHERE id=?", (sid,)).fetchone()
                if row:
                    metadata = dict(zip(names, row))
                    source = metadata.get("source") or ""
                    try:
                        source = json.loads(source)
                    except (TypeError, ValueError):
                        pass
                    if (metadata.get("thread_source") == "subagent"
                            or (isinstance(source, dict) and "subagent" in source)
                            or metadata.get("agent_path") not in (None, "", "/root")):
                        return None
                    for value in (metadata.get("name"), metadata.get("title")):
                        title = clean(value)
                        if title:
                            return title
        except (OSError, sqlite3.Error):
            continue
    return ""


def tmux(*args):
    result = subprocess.run(["tmux", *args], stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, timeout=0.5, check=True)
    return result.stdout.strip()


def sync(data, event, pane, codex_home, grok_home):
    if data.get("subagentType") or ("sessionId" not in data and data.get("agent_id")):
        return
    sid = data.get("session_id") or data.get("sessionId")
    if not isinstance(sid, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", sid):
        return
    # Match the exact pane; do not let a delayed Stop from a previous/subagent
    # conversation overwrite the foreground conversation's name.
    previous_sid = tmux("show-options", "-pqv", "-t", pane, "@devd_title_session")
    previous_title = tmux("show-options", "-pqv", "-t", pane, "@devd_auto_title")
    if previous_sid and previous_sid != sid and event != "prompt_submit":
        return
    title = saved_title(data, sid, codex_home, grok_home)
    if title is None:
        return  # A child agent inherits TMUX_PANE but does not own its title.
    if not title and event == "prompt_submit" and (previous_sid != sid or not previous_title):
        title = clean(data.get("prompt") or data.get("user_prompt") or data.get("input"))
    if not title:
        return
    tmux("set-option", "-p", "-t", pane, "@devd_title_session", sid)
    tmux("set-option", "-p", "-t", pane, "@devd_auto_title", title)
    # Session-local format survives older Mac attach clients reapplying their
    # global format. The active pane's option follows window/pane switches.
    session = tmux("display-message", "-p", "-t", pane, "#{session_id}")
    tmux("set-option", "-t", session, "set-titles", "on")
    tmux("set-option", "-t", session, "set-titles-string", TITLE_FORMAT)


def rendered_title(pane):
    # The same format tmux emits as the terminal title (see sync/attach).
    try:
        return clean(tmux("display-message", "-p", "-t", pane, TITLE_FORMAT))
    except (OSError, subprocess.SubprocessError):
        return ""


def tool_name(data):
    value = data.get("tool_name") or data.get("toolName")
    return re.split(r"__|[.:/]", value)[-1] if isinstance(value, str) else ""


def grok_native(pane):
    # Session-scoped negotiation follows the attached Warp client, including a
    # downgrade or reconnect. Existing agents need not restart to get the icon.
    try:
        negotiated = tmux("show-options", "-qv", "-t", pane, "@devd_warp_grok_native")
        if negotiated in ("0", "1"):
            return negotiated == "1"
    except (OSError, subprocess.SubprocessError):
        pass
    return os.environ.get("DEVD_WARP_GROK_NATIVE") == "1"


def recovery_checkpoint(pane, state, cwd):
    helper = "/usr/local/bin/devbox-recovery"
    if not os.access(helper, os.X_OK):
        return
    try:
        subprocess.run([helper, "checkpoint", "--pane", pane, "--state",
                        json.dumps({**state, "cwd": cwd}, separators=(",", ":"))],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=0.75, check=False)
    except (OSError, subprocess.SubprocessError):
        pass  # A recovery disk/lock failure must not alter the agent hook verdict.


AGENT_NAMES = {"claude": "Claude Code", "codex": "Codex", "grok": "Grok"}


def warp_locked_agent(pane, agent):
    # Warp locks a tab's agent type to the FIRST agent announced while one command
    # runs, and a Mac `dev` is one command across all its re-attaches (measured:
    # Codex then `cc` in the same pane kept the Codex icon and dropped every
    # Claude toast; only a fresh `dev` switched it). `dev` passes one block id per
    # process; events of a later agent go out under the locked one so they still
    # notify, plus a one-time hint how to get the right icon.
    try:
        block = tmux("show-options", "-qv", "-t", pane, "@devd_warp_block")
        if not block:
            return agent  # Older Mac CLI or not Warp: nothing known about the lock.
        bound_block, _, bound = tmux("show-options", "-qv", "-t", pane, "@devd_warp_bound").partition("|")
        if bound_block != block or bound not in AGENT_NAMES:
            tmux("set-option", "-t", pane, "@devd_warp_bound", f"{block}|{agent}")
            return agent
        if bound != agent and tmux("show-options", "-qv", "-t", pane, "@devd_warp_hinted") != f"{block}|{agent}":
            tmux("set-option", "-t", pane, "@devd_warp_hinted", f"{block}|{agent}")
            tmux("display-message", "-d", "15000", "-t", pane,
                 f"Warp keeps this tab as {AGENT_NAMES[bound]} (notifications still arrive). "
                 f"For the {AGENT_NAMES[agent]} icon: F9 → Just detach, then run dev again.")
        return bound
    except (OSError, subprocess.SubprocessError):
        return agent


def write_status(pane, payload, terminal_sequence=False):
    # Hook stdout is a verdict channel. Write to the pane's tty, wrapping OSC
    # for tmux passthrough; native codex-warp's raw /dev/tty output cannot do this.
    wire = dict(payload)
    # Native Grok shipped September 9. Older clients keep the compatibility
    # badge; logical ownership is always Grok, independent of presentation.
    if wire["agent"] == "grok" and not grok_native(pane):
        wire["agent"] = "claude"
    # Warp only knows its own plugins (claude/codex/grok). Antigravity shows the
    # Claude badge; the logical owner stays agy in state and recovery checkpoint.
    elif wire["agent"] == "agy":
        wire["agent"] = "claude"
    wire["agent"] = warp_locked_agent(pane, wire["agent"])
    seq = "\x1b]777;notify;warp://cli-agent;" + json.dumps(wire, separators=(",", ":")) + "\x07"
    if terminal_sequence:
        print(json.dumps({"terminalSequence": seq}))
        return
    tty = tmux("display-message", "-p", "-t", pane, "#{pane_tty}")
    if not tty:
        raise OSError("Pane has no tty")
    with open(tty, "w") as output:
        output.write("\x1bPtmux;" + seq.replace("\x1b", "\x1b\x1b") + "\x1b\\")


def status(data, event, pane, codex_home, grok_home, agent, terminal_sequence=False):
    if event not in ("session_start", "prompt_submit", "pre_tool_use", "tool_complete", "permission_request", "stop", "stop_failure", "idle_prompt"):
        return
    if data.get("subagentType") or ("sessionId" not in data and data.get("agent_id")):
        return
    sid = data.get("session_id") or data.get("sessionId")
    if not isinstance(sid, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", sid):
        return
    if saved_title(data, sid, codex_home, grok_home) is None:
        return  # Metadata can identify children whose hook omitted agent_id.
    try:
        previous = json.loads(tmux("show-options", "-pqv", "-t", pane, "@devd_warp_state") or "{}")
    except ValueError:
        previous = {}
    if not isinstance(previous, dict):
        previous = {}
    same = previous.get("session_id") == sid and previous.get("agent") == agent
    if previous.get("session_id") and not same and event not in ("session_start", "prompt_submit"):
        return
    prompt_id = data.get("promptId") or data.get("prompt_id")
    prompt_id = prompt_id if isinstance(prompt_id, str) else ""
    if (same and prompt_id and previous.get("prompt_id") and prompt_id != previous["prompt_id"]
            and event not in ("session_start", "prompt_submit")):
        return  # A cancelled prior Grok turn may finish after the next prompt.
    tool = tool_name(data)
    call_id = data.get("tool_use_id") or data.get("tool_call_id") or data.get("toolUseId") or data.get("toolCallId")
    call_id = call_id if isinstance(call_id, str) else ""
    # Async questions return immediately. Keep attention through background work
    # and Stop until an answer arrives as a new prompt (or the session restarts).
    if (same and previous.get("waiting_tool") == "request_user_input_async"
            and event in ("pre_tool_use", "tool_complete", "stop", "idle_prompt")):
        return
    waiting_tool = ""
    if event == "pre_tool_use":
        if tool in ("request_user_input", "request_user_input_async", "ask_user", "ask_user_question", "AskUserQuestion"):
            event = "permission_request"
            waiting_tool = tool
        elif same and previous.get("event") in ("stop", "stop_failure"):
            # A new tool begins real work after an interrupted/blocked Stop.
            # Merely completing an older background tool does not.
            event = "tool_complete"
        else:
            return
    elif event == "tool_complete" and same:
        if previous.get("event") in ("stop", "stop_failure"):
            return
        if previous.get("waiting_tool") and previous["waiting_tool"] != tool:
            return
        if previous.get("waiting_call") and call_id and previous["waiting_call"] != call_id:
            return
    elif event in ("stop", "stop_failure") and same and previous.get("event") == event:
        return
    if event == "permission_request":
        waiting_tool = tool
    cwd = data.get("cwd") if isinstance(data.get("cwd"), str) else os.getcwd()
    payload = {"v": 1, "agent": agent, "event": event, "session_id": sid, "cwd": cwd, "project": os.path.basename(cwd)}
    if agent == "grok":
        payload["plugin_version"] = "1.0.0"
    if event == "stop_failure":
        error = data.get("error") or data.get("error_type")
        if isinstance(error, str):
            payload["error_type"] = clean(error)
    if tool:
        payload["tool_name"] = tool
    # A missing or stale title must never suppress a valid lifecycle event.
    if agent == "grok":
        try:
            sync(data, "prompt_submit" if event == "session_start" else event, pane, codex_home, grok_home)
            title = tmux("show-options", "-pqv", "-t", pane, "@devd_auto_title")
            if title and not title.startswith("Grok · "):
                tmux("set-option", "-p", "-t", pane, "@devd_auto_title", clean("Grok · " + title))
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    # Warp's vertical tabs prefer a plugin agent's `summary` over the terminal
    # title, so mirror the exact tmux title (label > devbox name > auto > pane).
    # Without it the tab shows Warp's own agent text and the devbox name is lost.
    summary = rendered_title(pane)
    if summary:
        payload["summary"] = summary
    if terminal_sequence:
        write_status(pane, payload, terminal_sequence=True)
    else:
        write_status(pane, payload)
    state = {"session_id": sid, "agent": agent, "event": event, "waiting_tool": waiting_tool,
             "waiting_call": call_id if event == "permission_request" else "",
             "prompt_id": prompt_id or (previous.get("prompt_id", "") if same and event != "prompt_submit" else "")}
    tmux("set-option", "-p", "-t", pane, "@devd_warp_state", json.dumps(state, separators=(",", ":")))
    recovery_checkpoint(pane, state, cwd)


def main():
    pane = os.environ.get("TMUX_PANE", "")
    terminal_sequence = len(sys.argv) > 1 and sys.argv[1] == "--claude-status"
    with_status = terminal_sequence or (len(sys.argv) > 1 and sys.argv[1] == "--status")
    args = sys.argv[2:] if with_status else sys.argv[1:]
    event = args[0] if args else ""
    allowed = ("session_start", "prompt_submit", "pre_tool_use", "tool_complete", "permission_request", "stop", "stop_failure", "idle_prompt") if with_status else ("prompt_submit", "stop", "permission_request")
    if not re.fullmatch(r"%[0-9]+", pane) or event not in allowed:
        return
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            return
        codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
        grok_home = Path(os.environ.get("GROK_HOME", str(Path.home() / ".grok")))
        if with_status:
            # Serialize each pane's state check and terminal write. Hook subprocesses
            # can overlap; an older completion must not race a question or Stop.
            socket = tmux("display-message", "-p", "-t", pane, "#{socket_path}:#{pid}")
            identity = f"{os.getuid()}:{socket}:{pane}"
            lock_path = Path(tempfile.gettempdir()) / ("devbox-warp-" + hashlib.sha256(identity.encode()).hexdigest() + ".lock")
            descriptor = os.open(lock_path, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                agent = "claude" if terminal_sequence else os.environ.get("DEVD_WARP_AGENT")
                # Also recognize old seeded commands during a rolling update.
                if agent not in ("claude", "codex", "grok", "agy"):
                    agent = "grok" if "sessionId" in data else "codex"
                status(data, event, pane, codex_home, grok_home, agent, terminal_sequence)
        else:
            sync(data, event, pane, codex_home, grok_home)
    except (OSError, ValueError, subprocess.SubprocessError):
        # Hooks must stay silent, including on malformed input or a closing pane.
        pass


if __name__ == "__main__":
    main()
