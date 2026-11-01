#!/usr/bin/env python3
"""Read-only proof manifest for historical Codex metrics with a missing model.

This script NEVER changes SQLite. Run on the devbox host and capture stdout locally:
  ssh devbox python3 - < tools/codex-stats-repair-audit.py > /tmp/codex-stats-repair-manifest.json
Use --max-id to repeat a bounded audit. JSONL contents are never included in output;
only context model IDs, token counters, timestamps, and source-prefix digests are used.
Canonical digests use sorted compact UTF-8 JSON, with integral numbers as integers.
"""

import argparse
import bisect
import collections
import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


KINDS = ("input", "cacheRead", "cacheWrite", "output")
METRIC_KINDS = {"input": 0, "cacheRead": 1, "cacheCreation": 2, "output": 3}
ZERO = (0, 0, 0, 0)
ALLOWED_ATTRS = {"devbox.host", "devbox.session.id", "project", "repo", "type"}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def totals(value):
    if not isinstance(value, dict):
        return None
    keys = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens")
    values = tuple(value.get(key, 0) for key in keys)
    if any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in values):
        return None
    return (max(0, values[0] - values[1]), values[1], values[2], values[3])


def named(values):
    return dict(zip(KINDS, values))


def utc(milliseconds):
    return dt.datetime.fromtimestamp(milliseconds / 1000, dt.timezone.utc).isoformat()


def read_rollout(path, root, state):
    checkpoints = []
    models = set()
    sha = hashlib.sha256()
    size = 0
    epoch_start = 0
    for line in path.open("rb"):
        sha.update(line)
        size += len(line)
        if b'"turn_context"' not in line and b'"token_count"' not in line:
            continue
        try:
            event = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        payload = event.get("payload", {})
        if not isinstance(payload, dict):
            continue
        if event.get("type") == "turn_context" and isinstance(payload.get("model"), str):
            models.add(payload["model"])
        info = payload.get("info")
        if payload.get("type") != "token_count" or not isinstance(info, dict):
            continue
        current = totals(info.get("total_token_usage"))
        if current is None or (checkpoints and current == checkpoints[-1]["totals"]):
            continue
        try:
            timestamp = int(dt.datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00")).timestamp() * 1000)
        except (KeyError, ValueError, TypeError):
            continue
        if checkpoints and timestamp < checkpoints[-1]["ts"]:
            raise ValueError("Non-monotonic checkpoint timestamps; refusing attribution")
        reset = bool(checkpoints and any(current[i] < checkpoints[-1]["totals"][i] for i in range(4)))
        if reset:
            epoch_start = len(checkpoints)
        last = info.get("last_token_usage")
        prompt = last.get("input_tokens") if isinstance(last, dict) else None
        checkpoints.append({"ts": timestamp, "totals": current, "last": totals(last),
                            "prompt": prompt, "epochStart": epoch_start, "reset": reset})
    by_totals = collections.defaultdict(list)
    for index, checkpoint in enumerate(checkpoints):
        by_totals[checkpoint["totals"]].append(index)
    return {"path": str(path.relative_to(root)), "sourcePrefixBytes": size,
            "sourcePrefixSha256": sha.hexdigest(), "state": state,
            "models": sorted(models), "checkpoints": checkpoints,
            "times": [c["ts"] for c in checkpoints], "byTotals": by_totals}


def make_blocks(rows):
    blocks = []
    previous_kind = -1
    block = None
    for row in rows:
        attrs = json.loads(row["attrs"])
        if set(attrs) - ALLOWED_ATTRS or attrs.get("devbox.host") != "devbox":
            raise ValueError("Unexpected candidate attributes; refusing to copy or relabel them")
        kind = METRIC_KINDS.get(attrs.get("type"))
        if kind is None or not isinstance(row["value"], int) or row["value"] <= 0:
            raise ValueError("Unexpected candidate token type/value")
        if (block is None or row["ts"] != block["ts"] or row["session_id"] != block["sessionId"]
                or kind <= previous_kind or row["id"] != block["originalRows"][-1]["id"] + 1):
            block = {"ts": row["ts"], "sessionId": row["session_id"],
                     "vector": [0, 0, 0, 0], "originalRows": []}
            blocks.append(block)
        block["vector"][kind] = row["value"]
        block["originalRows"].append(row)
        previous_kind = kind
    return blocks


def candidates(block, rollouts):
    matches = []
    for rollout_id, rollout in rollouts.items():
        if len(rollout["models"]) != 1:
            continue
        if block["sessionId"] is not None and rollout["state"].get("session") != block["sessionId"]:
            continue
        end = bisect.bisect_right(rollout["times"], block["ts"])
        start = max(0, bisect.bisect_left(rollout["times"], block["ts"] - 300_000) - 1)
        for upper in range(start, end):
            current = rollout["checkpoints"][upper]
            previous = tuple(current["totals"][i] - block["vector"][i] for i in range(4))
            if min(previous) < 0:
                continue
            epoch = current["epochStart"]
            lowers = ([epoch - 1] if previous == ZERO else
                      [i for i in rollout["byTotals"].get(previous, []) if epoch <= i < upper])
            for lower in lowers:
                matches.append((rollout_id, lower, upper, previous))
    return matches


def audit(args):
    db = sqlite3.connect(Path(args.db).resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    highwater = db.execute("SELECT coalesce(max(id),0) FROM metrics").fetchone()[0]
    if args.max_id is not None:
        highwater = min(highwater, args.max_id)
    state_row = db.execute("SELECT state,updated_at FROM harvest_state WHERE source='codex'").fetchone()
    if state_row is None:
        raise ValueError("Codex harvest state is missing")
    state = json.loads(state_row["state"])
    rows = [dict(row) for row in db.execute("""SELECT id,ts,session_id,name,value,attrs FROM metrics
        WHERE id<=? AND a_model IS NULL AND a_host='devbox' AND name='claude_code.token.usage' ORDER BY id""", (highwater,))]
    db.close()
    for row in rows:
        if isinstance(row["value"], float) and row["value"].is_integer():
            row["value"] = int(row["value"])
    root = Path(args.sessions)
    rollouts = {}
    for path in root.rglob("rollout-*.jsonl"):
        rollout_id = path.name[-42:-6]
        if rollout_id in state["files"]:
            if rollout_id in rollouts:
                raise ValueError("Duplicate rollout ID on disk")
            rollouts[rollout_id] = read_rollout(path, root, state["files"][rollout_id])
    blocks = make_blocks(rows)
    manifest_blocks = []
    rejected = []
    summary = collections.Counter()
    per_model = collections.defaultdict(collections.Counter)
    chains = collections.defaultdict(list)
    for block in blocks:
        matches = candidates(block, rollouts)
        if len(matches) != 1:
            rejected.append({"rowIds": [r["id"] for r in block["originalRows"]], "candidateCount": len(matches)})
            continue
        rollout_id, lower, upper, previous = matches[0]
        rollout = rollouts[rollout_id]
        model = rollout["models"][0]
        current = rollout["checkpoints"][upper]
        checkpoint_rows = []
        last_total = previous
        reasons = set()
        if block["vector"][2] > 0:
            reasons.add("legacy_input_includes_cache_writes")
        summed = [0, 0, 0, 0]
        for index in range(lower + 1, upper + 1):
            checkpoint = rollout["checkpoints"][index]
            delta = tuple(checkpoint["totals"][i] - last_total[i] for i in range(4))
            matches_last = delta == checkpoint["last"]
            if checkpoint["reset"]:
                reasons.add("recorded_cumulative_counter_reset")
            if min(delta) < 0 or not matches_last:
                reasons.add("checkpoint_delta_does_not_equal_last_usage")
            prompt = checkpoint["prompt"]
            if isinstance(prompt, bool) or not isinstance(prompt, int) or prompt < 0:
                reasons.add("missing_or_invalid_request_prompt_tokens")
            else:
                summary["checkpointsPromptAbove272000"] += prompt > 272_000
            summary["checkpointsCacheWritePositive"] += delta[2] > 0
            summary["checkpoints"] += 1
            checkpoint_rows.append({"index": index, "ts": checkpoint["ts"], "previousTotals": named(last_total),
                                   "currentTotals": named(checkpoint["totals"]), "delta": named(delta),
                                   "promptTokens": prompt, "lastUsage": named(checkpoint["last"]) if checkpoint["last"] else None,
                                   "deltaMatchesLastUsage": matches_last, "counterReset": checkpoint["reset"]})
            summed = [summed[i] + delta[i] for i in range(4)]
            last_total = checkpoint["totals"]
        if summed != block["vector"]:
            reasons.add("checkpoint_sum_does_not_equal_original_token_rows")
        original = block["originalRows"]
        cost_eligible = not reasons
        manifest_blocks.append({"originalRows": original, "originalRowsSha256": digest(original),
                                "rolloutId": rollout_id, "model": model, "uniqueCandidateCount": 1,
                                "previousTotals": named(previous), "currentTotals": named(current["totals"]),
                                "delta": named(block["vector"]), "previousCheckpointIndex": lower,
                                "currentCheckpointIndex": upper, "harvestLagMs": block["ts"] - current["ts"],
                                "checkpoints": checkpoint_rows,
                                "usage": [{"totals": checkpoint["delta"], "promptTokens": checkpoint["promptTokens"]}
                                          for checkpoint in checkpoint_rows], "labelEligible": True,
                                "costEligible": cost_eligible, "costSkipReasons": sorted(reasons)})
        chains[rollout_id].append((block["ts"], original[0]["id"], previous, current["totals"], bool(reasons)))
        summary["matchedBlocks"] += 1
        summary["matchedRows"] += len(original)
        summary["matchedTokens"] += sum(block["vector"])
        summary["costEligibleBlocks" if cost_eligible else "costSkippedBlocks"] += 1
        summary["costEligibleRows" if cost_eligible else "costSkippedRows"] += len(original)
        per_model[model]["rows"] += len(original)
        per_model[model]["tokens"] += sum(block["vector"])
    for rollout_id, chain in chains.items():
        chain.sort()
        summary["rolloutsStartingAtZero"] += chain[0][2] == ZERO
        summary["rolloutsEndingAtSavedState"] += chain[-1][3] == tuple(state["files"][rollout_id]["totals"][k] for k in KINDS)
        for previous, current in zip(chain, chain[1:]):
            summary["continuousBoundaries" if previous[3] == current[2] else "resetOrDiscontinuousBoundaries"] += 1
    return {"version": 1, "readOnly": True, "createdAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
            "dbPath": args.db, "metricsHighwaterId": highwater, "codexStateUpdatedAt": state_row["updated_at"],
            "codexStateSha256": hashlib.sha256(state_row["state"].encode()).hexdigest(),
            "candidateRows": len(rows), "candidateBlocks": len(blocks), "originalRowsSha256": digest(rows),
            "windowUtc": [utc(rows[0]["ts"]), utc(rows[-1]["ts"])] if rows else [],
            "summary": dict(summary), "perModel": dict(per_model), "rejectedBlocks": rejected,
            "sources": {rid: {key: rollout[key] for key in ("path", "sourcePrefixBytes", "sourcePrefixSha256", "models")}
                        for rid, rollout in rollouts.items()}, "blocks": manifest_blocks,
            "mutationContract": "No token insertion/deletion/value changes. Compare every original row before relabeling. "
                                "Insert cost only for costEligible blocks, with a unique repair-ledger key per original token row. "
                                "Reject changed rows, changed source prefixes, nonunique matches, or ledger conflicts. "
                                "Never reingest cumulative rollout totals."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="/var/lib/devd/devd.sqlite")
    parser.add_argument("--sessions", default="/var/lib/docker/volumes/codex-home/_data/sessions")
    parser.add_argument("--max-id", type=int)
    parser.add_argument("--output", default="-", help="Manifest path, or - for stdout; DB is always read-only")
    args = parser.parse_args()
    manifest = audit(args)
    result = json.dumps(manifest, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    if args.output == "-":
        sys.stdout.write(result)
    else:
        Path(args.output).write_text(result)


if __name__ == "__main__":
    main()
