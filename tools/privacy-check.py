#!/usr/bin/env python3
"""Fail when private names, hosts or addresses reach the public repository.

The patterns are not in the repository — that list is itself private. CI passes it in the
DENYLIST environment variable (repository secret OSS_DENYLIST): one case-insensitive regular
expression per line, `#` comments, and `!pattern` lines for allowed occurrences (for example
the repository's own URL). Allowed occurrences are removed from a line before the deny
patterns are tried, so an allow rule never hides anything else on the same line.

Checked: every tracked file's text, printable strings inside binary files (images), every
tracked path, and — for the commits in the given revision range — message, author and
committer.

Output names only the place and the pattern's number, never the matched text or the pattern:
CI logs of a public repository are public.

Usage: DENYLIST="$(cat denylist)" tools/privacy-check.py [<base>..<head>]
"""
from __future__ import annotations

import os
import json
import re
import subprocess
import sys
import urllib.request

BINARY_STRINGS = re.compile(rb"[\x20-\x7e]{4,}")


def git(*args: str) -> bytes:
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout


def load_patterns(text: str) -> tuple[list[re.Pattern[str]], list[re.Pattern[str]]]:
    deny, allow = [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        target = allow if line.startswith("!") else deny
        target.append(re.compile(line.removeprefix("!"), re.IGNORECASE))
    return deny, allow


def offending(text: str, deny: list[re.Pattern[str]], allow: list[re.Pattern[str]]) -> int | None:
    """Number (1-based) of the first deny pattern left after removing allowed occurrences."""
    for rule in allow:
        text = rule.sub(" ", text)
    for number, rule in enumerate(deny, 1):
        if rule.search(text):
            return number
    return None


def scan_tree(deny, allow) -> list[str]:
    problems = []
    for path in git("ls-files", "-z").decode().split("\0"):
        if not path:
            continue
        if (n := offending(path, deny, allow)) is not None:
            problems.append(f"{path}: path matches pattern #{n}")
        try:
            data = open(path, "rb").read()
        except (FileNotFoundError, IsADirectoryError):
            continue  # submodule or a file deleted in the working tree
        if b"\0" in data[:8000]:
            for chunk in BINARY_STRINGS.findall(data):
                if (n := offending(chunk.decode("ascii"), deny, allow)) is not None:
                    problems.append(f"{path}: binary content matches pattern #{n}")
                    break
            continue
        for lineno, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if (n := offending(line, deny, allow)) is not None:
                problems.append(f"{path}:{lineno}: matches pattern #{n}")
    return problems


def github_commit(repository: str, sha: str) -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "devbox-privacy-check"}
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(f"https://api.github.com/repos/{repository}/commits/{sha}", headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def public_merge_author(sha: str, author: str, committer: str, parents: str) -> str:
    """Only normalize the owner's public identity on a verified GitHub merge.

    The deny-list may also contain the owner's numeric GitHub account ID. Only
    the API-verified public noreply identity is exempt; local/spoofed merges and
    private emails retain the full check. API failure also fails closed.
    """
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        return author
    owner = repository.split("/")[0]
    email = re.fullmatch(r".+ <([0-9]+\+" + re.escape(owner) + r"@users\.noreply\.github\.com)>", author)
    if not email or committer != "GitHub <noreply@github.com>" or len(parents.split()) != 2:
        return author
    try:
        data = github_commit(repository, sha)
        identity = data["commit"]["author"]
        verified = data["commit"]["verification"]
        if (data["sha"] == sha and verified["verified"] is True and verified["reason"] == "valid"
                and data["author"]["login"] == owner and data["committer"]["login"] == "web-flow"
                and identity["email"] == email[1]
                and f'{identity["name"]} <{identity["email"]}>' == author
                and [p["sha"] for p in data["parents"]] == parents.split()):
            return "GitHub <noreply@github.com>"
        print("::notice::GitHub merge metadata did not meet the verified-public-identity requirements")
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"::notice::GitHub merge verification unavailable ({type(error).__name__}, status {getattr(error, 'code', 'unknown')})")
    return author


def scan_commits(rev_range: str, deny, allow) -> list[str]:
    problems = []
    # A force-push can remove the previous tip from every advertised ref. Even a
    # full Actions checkout then lacks github.event.before. Fetch that exact object
    # before comparing; a fetch failure must still fail the check, never skip it.
    base = rev_range.split("..", 1)[0]
    if re.fullmatch(r"[0-9a-fA-F]{40}", base):
        present = subprocess.run(["git", "cat-file", "-e", f"{base}^{{commit}}"], capture_output=True)
        if present.returncode != 0:
            git("fetch", "--no-tags", "origin", base)
    fmt = "%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%P%x1f%B%x1e"
    for record in git("log", f"--format={fmt}", rev_range).decode("utf-8", "replace").split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        sha, author, committer, parents, message = record.split("\x1f", 4)
        if offending(author, deny, allow) is not None:
            original = author
            author = public_merge_author(sha, author, committer, parents)
            print(f"::notice::Merge identity check: normalized={author != original}, email_denied={offending(author.rsplit('<', 1)[-1], deny, allow) is not None}")
        for what, value in (("author", author), ("committer", committer), ("message", message)):
            if (n := offending(value, deny, allow)) is not None:
                problems.append(f"commit {sha[:12]}: {what} matches pattern #{n}")
    return problems


def main() -> int:
    text = os.environ.get("DENYLIST", "")
    if not text.strip():
        # Pull requests from forks get no secrets; the push to main is checked instead.
        print("::notice::DENYLIST is not set — privacy check skipped")
        return 0
    deny, allow = load_patterns(text)
    problems = scan_tree(deny, allow)
    if len(sys.argv) > 1 and not sys.argv[1].startswith("0000000"):
        problems += scan_commits(sys.argv[1], deny, allow)
    for problem in problems:
        print(f"::error::{problem}")
    print(f"privacy check: {len(deny)} patterns, {len(allow)} allow rules, {len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
