# Codex Stats model and pricing repair — 2026-09-10

The deployed parser expected a nested `response_item.payload.type=turn_context`.
Actual Codex rollouts use `type=turn_context` and `payload.model`. All 87 tracked
devbox rollouts contained a model: 63 Astra and 24 Sol. The faulty parser stored
null for every one of them. Its test fixture repeated the same incorrect shape.

The collector now reads structured context/usage records in order, preserving
request model and input length. Only metadata leaves the rollout volume. Counters
are still cumulative checkpoints: a repair must never replay whole histories as
new usage. New records include agent and rollout provenance independently of the
model, because a GPT model can also be used through Claude Code's proxy.

## Verified standard API prices

USD per million tokens; verified against provider sources on 2026-09-10.

| Model | Input | Cache read | Cache write | Output | Long context |
| --- | ---: | ---: | ---: | ---: | --- |
| gpt-6-astra | 10 | 1 | 12.5 | 50 | >272,000 input: 20 / 2 / 25 / 75 |
| gpt-6.1-sol | 2 | 0.1 | 2.5 | 10 | >272,000 input: 4 / 0.2 / 5 / 15 (added 2026-10-14) |
| gpt-6-sol | 2 | 0.2 | 2.5 | 10 | >272,000 input: 4 / 0.4 / 5 / 15 (added 2026-10-14) |
| gpt-6-luna | 0.1 | 0.01 | 0.125 | 0.5 | >272,000 input: 0.2 / 0.02 / 0.25 / 0.75 (added 2026-10-14) |
| gpt-5.6-sol | 4 | 0.4 | 5 | 20 | >272,000 input: 8 / 0.8 / 10 / 30 |
| gpt-5.6-terra | 2 | 0.2 | 2.5 | 12 | >272,000 input: 4 / 0.4 / 5 / 18 |
| gpt-5.6-luna | 0.2 | 0.02 | 0.25 | 1.2 | >272,000 input: 0.4 / 0.04 / 0.5 / 1.8 |
| gpt-5.5 | 5 | 0.5 | 5 | 30 | >272,000 input: 10 / 1 / 10 / 45 |
| gpt-5.4-mini | 0.75 | 0.075 | 0.75 | 4.5 | No published uplift |
| gpt-5.3-codex | 1.75 | 0.175 | 1.75 | 14 | No published uplift |
| grok-4.6 | 2 | 0.5 | 2 | 6 | >=200,000 prompt: 4 / 1 / 4 / 12 |

Primary sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing),
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5),
[Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini),
[Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex),
[xAI pricing](https://docs.x.ai/developers/pricing).

Sol's promotional rate is published through at least 2026-11-21; recheck then.
The only additional aliases accepted are the documented `gpt-5.6` (Sol),
`gpt-5.5-2026-04-23`, and `gpt-5.4-mini-2026-03-17`. No prefix matching.
The legacy `stealth/ox-alpha` slug has no current published price: remove the old
unsubstantiated free rate, keep its tokens, and do not price historical usage as
the subsequently revealed model. [OpenRouter disclosure](https://openrouter.ai/stealth/ox-alpha).

## What the numbers mean

Costs are **standard API-equivalent estimates at the verified current rates**,
not subscription invoices. Serving tier and region are absent from the inspected
rollout contexts, so Fast/priority and regional surcharges cannot be inferred.
OpenAI publishes Fast at 2x standard for Astra/Sol, but 2.5x for GPT-5.5; do not
apply a universal multiplier. Historical costs are not repriced automatically.

Long context uses the input count of each request, including cached tokens, not
the accumulated session counter. Astra/Sol rates apply to the entire qualifying
request. GPT-5.5's page says "full session"; its per-request calculation remains
an estimate. OTLP proxy metrics lack request boundaries and retain a standard
rate estimate.

GPT-5.6+ cache writes replace ordinary input billing at 1.25x. The ordinary input
bucket excludes both reads and writes. Missing write metadata does not prove no
write surcharge occurred. [Official formula](https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance).

Native Mac Codex currently has no collector feeding the dashboard. Updating this
shared price table also fixes future Mac OTLP proxy pricing, but does not turn on
native Mac collection or import its local history.

## Historical repair

`tools/codex-stats-repair-audit.py` opens the production database read-only and
compares each old token block with exact rollout cumulative checkpoints. It only
accepts a unique rollout/model/interval match; ambiguous blocks are listed for
review. The manifest contains original row values/attributes, source-prefix
hashes, request deltas and the database high-water mark. It contains no prompts.

The 2026-09-10 audit up to metric ID 874790 matched 9,614 token rows / 860,356,980
tokens to 87 rollouts, with zero rejected blocks. 9,602 rows were eligible for
standard API pricing ($1,074.6873924 at the current verified rates). Twelve rows
in four recorded counter resets receive only model attribution. These estimates
do not resolve whether historical reset counters intrinsically overcounted usage.

`tools/codex-stats-repair.ts DATABASE MANIFEST` defaults to a read-only preview.
The CLI verifies the recorded prefix of every supporting rollout; subsequent
appends are allowed, rewritten or truncated evidence is refused. Nonzero legacy
cache-write blocks are label-only because their old input bucket included writes.
With explicitly authorized `--apply`, it verifies every original row in an
IMMEDIATE transaction, changes only attributes and the indexed model column,
and inserts cost records. A repair ledger keyed by the original token row makes
repeating the same manifest a no-op. It never inserts, deletes or changes token
values, harvest timestamps, or cumulative collector state. A stale original row
or a cost-write failure aborts the entire transaction.

Validation: 64 affected Bun tests passed. A disposable SQLite database populated
with all 9,614 original audited rows retained exactly the same token row count
and sum after repair; a second apply inserted zero rows. A read-only live scan of
8,102 checkpoints repaired all 87 persisted model names in an in-memory database,
without adding any token rows; replay also added none.
The read-only production preview independently verified all 87 source prefixes
and the unchanged 9,614 original database rows. No production writes occurred.

Deployment remains separate from code preparation: back up the database and
scoped source files, deploy the collector/prices, restart devd, then regenerate
and review the bounded manifest before applying it. Restarting devd locks its
vault; follow the existing unlock procedure in docs/install.md. Preserve unrelated
dirty files on the server, particularly `index.ts`, and avoid deploying the older
worktree's full service entry point.
