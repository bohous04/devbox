// Antigravity quota poller (modeled on grokPoller.ts). State (for backoff and showing the
// error) lives in harvest_state "agy-quota" — no new table, measured values
// go to weekly_usage. Unlike Codex/Grok, agy has no single singleton row:
// the quota is split into groups (today "Gemini Models" and "Claude and GPT Models") with
// dynamic ids, so harvest_state holds only the list of most recently seen groups —
// for writing `weeklyUsageFailed` on error (so they stay in the history rather than vanish).
//
// devd DELIBERATELY DOES NOT REFRESH the token: agy rotates the refresh token in the session (same
// decision as for Grok/Codex — two parties on one refresh token mean
// silent loss of login). An expired token therefore ends up as state `stale-login`,
// BUT without the usual 1h backoff — it is a normal operating state, not a failure.

import { AGY_VOLUME, readVolumeFile } from "./agentAuth";
import { usagePollDue, type CodexPollerDeps } from "./codexPoller";
import { agyTokenStale, agyUserAgent, fetchAgyQuota, parseAgyToken } from "./antigravityUsageFetch";
import { getHarvestState, setHarvestState } from "./db";
import { recordWeeklyUsage, weeklyUsageFailed } from "./weeklyUsage";

const TOKEN = "/home/dev/.gemini/antigravity-cli/antigravity-oauth-token";
// Verified live (Questions 7–11, section "Quota"): the project for retrieveUserQuotaSummary
// is NOT in loadCodeAssist (it does not return it for this subscription type) — it lives in
// this file, written by agy itself after (at least one) session.
const PROJECT = "/home/dev/.gemini/antigravity-cli/cache/default_project_id.txt";

export interface AgyHarvestState {
  state: "ok" | "signed-out" | "stale-login" | "error";
  fetched_at: number;
  error: string | null;
  /** Ids of the groups most recently seen from Google — only those can writeFail mark as `error`. */
  groups: string[];
}

function writeFail(d: CodexPollerDeps, prev: AgyHarvestState | null, state: AgyHarvestState["state"], error: string | null): void {
  for (const g of prev?.groups ?? []) weeklyUsageFailed(d.db, "agy", g);
  setHarvestState(d.db, "agy-quota", { state, fetched_at: d.now(), error, groups: prev?.groups ?? [] } satisfies AgyHarvestState);
}

export async function pollAgy(d: CodexPollerDeps): Promise<void> {
  const prev = getHarvestState<AgyHarvestState>(d.db, "agy-quota");
  // `usagePollDue` takes only `{state, fetched_at}` and `AgyHarvestState.state` is
  // literally the same union as `CodexView["state"]`, so `prev` can be passed directly —
  // no `as never` and no remapping. Moreover `usagePollDue` itself already treats
  // `stale-login` (besides `ok`) as "always due" — backoff applies only to `signed-out`/
  // `error` — so stale-login does not skip the normal cadence without further intervention.
  if (!usagePollDue(prev, d.now())) return;

  // `antigravity-home` is everywhere else mounted as the whole /home/dev/.gemini (see
  // agentAuth.ts authStatus and extraMounts in index.ts) — the token lives in a subdirectory,
  // hence the explicit mountPath (otherwise readVolumeFile would mount the token's parent
  // directory, which is a DIFFERENT place than where the real agy writes; see the fix
  // in agentAuth.readVolumeFile).
  const { raw, dockerError } = d.readAuth ? await d.readAuth() : await readVolumeFile(d, AGY_VOLUME, TOKEN, "/home/dev/.gemini");
  if (dockerError !== null) { writeFail(d, prev, "error", dockerError); return; }
  const token = raw === null ? null : parseAgyToken(raw);
  // A missing volume and a missing token end the same way: "signed out" (invariant I3,
  // shared with grokPoller/codexPoller).
  if (!token) { writeFail(d, prev, "signed-out", null); return; }
  if (agyTokenStale(token, d.now())) { writeFail(d, prev, "stale-login", null); return; }

  // Second read from the SAME volume (see PROJECT above) — `readProject` is the counterpart
  // of `readAuth` for this second file, so it can be tested deterministically without
  // mocking `run` by argv path.
  const projectRes = d.readProject ? await d.readProject() : await readVolumeFile(d, AGY_VOLUME, PROJECT, "/home/dev/.gemini");
  if (projectRes.dockerError !== null) { writeFail(d, prev, "error", projectRes.dockerError); return; }
  const project = projectRes.raw?.trim() || null;
  // A project without a session (agy writes it only after the first run) must not be mistaken
  // for "signed out" — the token is valid, the project just does not exist yet.
  if (!project) { writeFail(d, prev, "error", "Antigravity project missing (run a session once)"); return; }

  const r = await fetchAgyQuota(token, project, d.fetch, agyUserAgent());
  if (!r.ok) { writeFail(d, prev, "error", r.error); return; }
  // Empty `groups` (Google might rename the window strings and parseQuotaSummary
  // recognizes no group) is NOT a success without data — it is an error. Otherwise state "ok"
  // would be written silently and the existing history would vanish from the dashboard without
  // anyone noticing. `writeFail` also preserves `prev.groups`, so the
  // existing groups stay in harvest_state and keep being retried.
  if (r.groups.length === 0) { writeFail(d, prev, "error", "empty quota"); return; }
  // A group that the last successful poll knew but the new response no longer returns
  // (Google removed/merged it) must get weeklyUsageFailed — otherwise it would silently
  // stay hanging in the history as "ok" with a stale last reading forever.
  const seen = new Set(r.groups.map((g) => g.id));
  for (const g of prev?.groups ?? []) if (!seen.has(g)) weeklyUsageFailed(d.db, "agy", g);
  for (const g of r.groups) {
    recordWeeklyUsage(d.db, "agy", g.id, g.label, `agy:${g.id}`, d.now(), g.windows.map((w) => ({ window: w.window, percentUsed: w.percentUsed, resetsAt: w.resetsAt })));
  }
  setHarvestState(d.db, "agy-quota", { state: "ok", fetched_at: d.now(), error: null, groups: r.groups.map((g) => g.id) } satisfies AgyHarvestState);
}
