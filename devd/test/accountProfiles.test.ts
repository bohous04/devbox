import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountMountList, isValidAccountId, parseAuthStatus, profileIdentity, profileMount,
  profilePath, profileVolume, provisionProfile, provisionScript, readProfileCredentials,
  removeProfile, writeProfileCredentials, type ProfileDeps,
} from "../src/accountProfiles";

const LINKER = join(import.meta.dir, "..", "..", "image", "link-shared-profile.sh");

// A shared profile with a few items; `absent` is deliberately missing.
function sharedDir(): string {
  const d = mkdtempSync(join(tmpdir(), "shared-claude-"));
  writeFileSync(join(d, "settings.json"), "{}");
  writeFileSync(join(d, "history.jsonl"), "");
  mkdirSync(join(d, "projects"));
  mkdirSync(join(d, "plugins"));
  return d;
}

// The presence of .credentials.json means "the profile is past login" — the linker requires it since fix round 1
// (M1), so tests that want to verify actual linking must
// set it up themselves. Tests that verify ARGUMENT validation or the guard itself
// deliberately DO NOT HAVE it.
function withCreds(profile: string): void {
  writeFileSync(join(profile, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"t"}}');
}

async function link(profile: string, shared: string, target: string, seed?: string) {
  const p = Bun.spawn(["bash", LINKER, profile, shared, target, ...(seed ? [seed] : [])], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ]);
  return { out, err, code };
}

test("linker: links the present shared items, skips the missing ones", async () => {
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  withCreds(profile);
  const r = await link(profile, shared, shared);
  expect(r.code).toBe(0);
  // shared history is the requirement this whole thing exists for
  expect(readlinkSync(join(profile, "projects"))).toBe(join(shared, "projects"));
  expect(readlinkSync(join(profile, "history.jsonl"))).toBe(join(shared, "history.jsonl"));
  expect(readlinkSync(join(profile, "settings.json"))).toBe(join(shared, "settings.json"));
  expect(readlinkSync(join(profile, "plugins"))).toBe(join(shared, "plugins"));
  // what is not in the shared profile is not linked (no dead links)
  expect(() => statSync(join(profile, "CLAUDE.md"))).toThrow();
});

test("linker: the symlink target is the THIRD argument, not the path it is read through", async () => {
  // devbox: read via /shared, but in the session container the volume will be at /home/dev/.claude
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  withCreds(profile);
  await link(profile, shared, "/home/dev/.claude");
  expect(readlinkSync(join(profile, "projects"))).toBe("/home/dev/.claude/projects");
});

test("linker: WITHOUT a seed it does not touch an existing .claude.json (mac after login)", async () => {
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  withCreds(profile);
  writeFileSync(join(profile, ".claude.json"), '{"oauthAccount":{"emailAddress":"b@x.cz"},"userID":"u2"}');
  await link(profile, shared, shared);
  const after = JSON.parse(readFileSync(join(profile, ".claude.json"), "utf8"));
  expect(after.oauthAccount.emailAddress).toBe("b@x.cz");   // the identity from login survived
  expect(after.userID).toBe("u2");
});

// The linker strips the identity from the seed via `node` (without it exit 3) — it is in the image and on CI.
test.skipIf(!Bun.which("node"))("linker: WITH a seed copies projects and deletes the identity", async () => {
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  withCreds(profile);
  const seed = join(shared, "seed.json");
  writeFileSync(seed, JSON.stringify({
    oauthAccount: { emailAddress: "a@x.cz" }, userID: "u1",
    projects: { "/workspace": { hasTrustDialogAccepted: true } },
  }));
  await link(profile, shared, shared, seed);
  const j = JSON.parse(readFileSync(join(profile, ".claude.json"), "utf8"));
  expect(j.oauthAccount).toBe(undefined);   // otherwise the profile would report someone else's account
  expect(j.userID).toBe(undefined);
  expect(j.projects["/workspace"].hasTrustDialogAccepted).toBe(true);
});

test("linker: seed points to a non-existent file → empty {}, no crash", async () => {
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  withCreds(profile);
  const r = await link(profile, shared, shared, join(shared, "missing.json"));
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(join(profile, ".claude.json"), "utf8"))).toEqual({});
});

test("linker: a second run breaks nothing (idempotence)", async () => {
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  withCreds(profile);
  await link(profile, shared, shared);
  const r = await link(profile, shared, shared);
  expect(r.code).toBe(0);
  expect(readlinkSync(join(profile, "projects"))).toBe(join(shared, "projects"));
  // The most valuable check in the whole file: without `-n`, `ln` on the SECOND run would dereference
  // the existing symlink (profile/projects -> shared/projects) as the target directory and put
  // a new link DIRECTLY INSIDE THE SHARED directory — that would be exactly the write through a symlink
  // into the live shared profile that this whole script is meant to avoid.
  expect(existsSync(join(shared, "projects", "projects"))).toBe(false);
});

test("linker: without the required arguments it exits non-zero with a message", async () => {
  const p = Bun.spawn(["bash", LINKER], { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  expect(await p.exited).not.toBe(0);
  expect(err).toContain("usage");
});

test("linker: an empty (but PRESENT) argument fails loudly, not silently", async () => {
  // `[ $# -lt 3 ]` checks the NUMBER of arguments, not their content — "" passes as a valid
  // third argument. Without an explicit check for an empty string, an empty `shared` would
  // mean "nothing got linked, but exit 0" and an empty `target` would mean dead
  // links into the filesystem root (/projects, /settings.json).
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  withCreds(profile);

  const emptyProfile = await link("", shared, shared);
  expect(emptyProfile.code).not.toBe(0);

  const emptyShared = await link(profile, "", shared);
  expect(emptyShared.code).not.toBe(0);
  expect(() => statSync(join(profile, "settings.json"))).toThrow();   // nothing got linked

  const emptyTarget = await link(profile, shared, "");
  expect(emptyTarget.code).not.toBe(0);
  expect(() => statSync(join(profile, "projects"))).toThrow();   // no dead link to the fs root
});

test("linker: WITHOUT .credentials.json (before login) refuses to link", async () => {
  // The order on the mac is critical (see the script header): login must happen BEFORE
  // linking. The script must not leave that to the user's discipline — hence the guard on the existence of
  // .credentials.json, not just a comment.
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  const r = await link(profile, shared, shared);
  expect(r.code).not.toBe(0);
  expect(r.err.toLowerCase()).toContain("credentials");
  expect(() => statSync(join(profile, "projects"))).toThrow();   // nothing got linked
});

test("linker: real (non-symlink) content in a path to be linked is not silently overwritten", async () => {
  // A reproduced scenario from the review: the profile has a real `projects/` directory (typically
  // `claude` creates it itself when launched BEFORE linking) and a real `history.jsonl` file.
  // `ln -sfn` on an existing REAL directory does not replace the directory with a symlink, but puts a new
  // symlink INSIDE it (`profile/projects/projects`) — silently, with exit 0. That is worse than
  // a missing file: it looks like success, but the shared history never gets linked.
  const shared = sharedDir();
  const profile = mkdtempSync(join(tmpdir(), "profile-"));
  withCreds(profile);
  mkdirSync(join(profile, "projects"));                              // real directory
  writeFileSync(join(profile, "history.jsonl"), "old history");      // real file
  const r = await link(profile, shared, shared);
  expect(r.code).not.toBe(0);
  expect(r.err).toContain(join(profile, "projects"));
  // nothing was overwritten or created inside — no stray projects/projects
  expect(() => readlinkSync(join(profile, "projects"))).toThrow();
  expect(existsSync(join(profile, "projects", "projects"))).toBe(false);
  expect(readFileSync(join(profile, "history.jsonl"), "utf8")).toBe("old history");
});

function fake(replies: { code?: number; stdout?: string; stderr?: string }[] = []) {
  const calls: { cmd: string[]; input?: string }[] = [];
  let i = 0;
  const d: ProfileDeps = {
    image: "devbox:test",
    run: async (cmd, input) => {
      calls.push({ cmd, input });
      const r = replies[i++] ?? {};
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
  return { d, calls };
}

test("account id: lower and upper case letters, digits and hyphen — goes into the volume name and the path", () => {
  expect(isValidAccountId("primary")).toBe(true);
  expect(isValidAccountId("account-2")).toBe(true);
  expect(isValidAccountId("A")).toBe(true);
  expect(isValidAccountId("Personal")).toBe(true);
  expect(accountMountList(["Personal"])).toEqual(["claude-acct-Personal:/home/dev/.claude-accounts/Personal"]);
  expect(isValidAccountId("../etc")).toBe(false);
  expect(isValidAccountId("-x")).toBe(false);
  expect(isValidAccountId("")).toBe(false);
  expect(isValidAccountId("a".repeat(40))).toBe(false);
});

test("volume, path and mount names", () => {
  expect(profileVolume("primary")).toBe("claude-acct-primary");
  expect(profilePath("primary")).toBe("/home/dev/.claude-accounts/primary");
  expect(profileMount("primary")).toBe("claude-acct-primary:/home/dev/.claude-accounts/primary");
  expect(accountMountList(["primary", "backup"])).toEqual([
    "claude-acct-primary:/home/dev/.claude-accounts/primary",
    "claude-acct-backup:/home/dev/.claude-accounts/backup",
  ]);
  expect(accountMountList(["../evil"])).toEqual([]);   // an invalid id is never mounted
});

test("provisionScript: delegates to the shared linker, does NOT DUPLICATE the item list", () => {
  const s = provisionScript();
  // the linker must get the symlink target as it will apply in the SESSION container
  expect(s).toContain("/usr/local/bin/link-shared-profile /profile /shared /home/dev/.claude /shared/.claude.json");
  expect(s).toContain("cat > /profile/.credentials.json");
  // chown belongs here, not in the linker — on the mac uid 1000 would be nonsense
  expect(s).toContain("chown -R 1000:1000 /profile");
  // the profile split is known by a SINGLE file; if the list appeared here too, they would drift apart
  expect(s).not.toContain("history.jsonl");
  expect(s).not.toContain("delete j.oauthAccount");
});

test("provisionProfile: root container, both volumes, credentials go to STDIN", async () => {
  const { d, calls } = fake();
  await provisionProfile(d, "primary", '{"claudeAiOauth":{}}');
  const cmd = calls[0].cmd;
  expect(cmd.slice(0, 4)).toEqual(["run", "--rm", "-i", "-u"]);
  expect(cmd).toContain("0");
  expect(cmd).toContain("claude-acct-primary:/profile");
  expect(cmd).toContain("claude-home:/shared");
  expect(cmd).toContain("devbox:test");
  expect(calls[0].input).toBe('{"claudeAiOauth":{}}');
  // the token MUST NOT be in argv (it would be visible in ps and in docker inspect)
  expect(cmd.join(" ")).not.toContain("claudeAiOauth");
});

test("provisionProfile: a non-zero exit is an error, an invalid id too", async () => {
  const { d } = fake([{ code: 1, stderr: "boom" }]);
  await expect(provisionProfile(d, "primary", "{}")).rejects.toThrow("boom");
  const { d: d2, calls } = fake();
  await expect(provisionProfile(d2, "../evil", "{}")).rejects.toThrow("invalid account id");
  expect(calls.length).toBe(0);
});

test("readProfileCredentials: the content, or null when the file is missing", async () => {
  const { d, calls } = fake([{ stdout: '{"claudeAiOauth":{"accessToken":"t"}}' }]);
  expect(await readProfileCredentials(d, "primary")).toBe('{"claudeAiOauth":{"accessToken":"t"}}');
  expect(calls[0].cmd).toContain("claude-acct-primary:/profile");
  expect(calls[0].cmd).toContain("/profile/.credentials.json");
  const { d: missing } = fake([{ code: 1 }]);
  expect(await readProfileCredentials(missing, "primary")).toBe(null);
});

test("writeProfileCredentials: the blob goes to STDIN, not to argv", async () => {
  const { d, calls } = fake();
  await writeProfileCredentials(d, "primary", '{"claudeAiOauth":{"accessToken":"NEWTOKEN"}}');
  expect(calls[0].input).toBe('{"claudeAiOauth":{"accessToken":"NEWTOKEN"}}');
  expect(calls[0].cmd.join(" ")).not.toContain("NEWTOKEN");
});

test("parseAuthStatus: JSON even with surrounding noise; unreadable = not logged in", () => {
  const ok = parseAuthStatus('some warning\n{"loggedIn":true,"email":"a@b.cz","orgName":"INFRA","subscriptionType":"max"}\n');
  expect(ok).toEqual({ loggedIn: true, email: "a@b.cz", orgName: "INFRA", subscriptionType: "max", orgId: null });
  expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}'))
    .toEqual({ loggedIn: false, email: null, orgName: null, subscriptionType: null, orgId: null });
  expect(parseAuthStatus("complete nonsense").loggedIn).toBe(false);
  expect(parseAuthStatus("").loggedIn).toBe(false);
});

test("parseAuthStatus: noise with braces ON ANOTHER line does not override the real JSON (I3)", () => {
  // The greedy regex /\{[\s\S]*\}/ reached from the FIRST `{` to the LAST `}` in the whole output —
  // so noise with its own curly braces (npm update notice, etc.) stretched the match
  // across the real JSON and JSON.parse failed on all that nonsense. A profile that is
  // actually logged in would thus end up as "not logged in" and the pool would needlessly
  // quarantine it.
  const noiseAfter = parseAuthStatus(
    '{"loggedIn":true,"email":"a@b.cz"}\nNew version available {try npm i -g @anthropic-ai/claude-code}',
  );
  expect(noiseAfter).toEqual({ loggedIn: true, email: "a@b.cz", orgName: null, subscriptionType: null, orgId: null });

  const noiseBefore = parseAuthStatus('warning {foo}\n{"loggedIn":true,"email":"z@z.cz"}');
  expect(noiseBefore).toEqual({ loggedIn: true, email: "z@z.cz", orgName: null, subscriptionType: null, orgId: null });
});

// Real output of `claude auth status` — verified live against the account team@example.com (fix round 2).
// PRETTY-PRINTED, i.e. MULTI-LINE JSON — no single line on its own is valid
// JSON, so a "line by line" parser (fix round 1) necessarily fails on it. That is exactly
// the regression: fix round 1 solved noise with its own braces, but broke the COMMON case.
const REAL_CLAUDE_AUTH_STATUS = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "team@example.com",
  "orgId": "00000000-0000-4000-8000-000000000002",
  "orgName": "team@example.com's Organization",
  "subscriptionType": "max"
}`;

test("parseAuthStatus: real MULTI-LINE (pretty-printed) claude auth status output (fix round 2)", () => {
  expect(parseAuthStatus(REAL_CLAUDE_AUTH_STATUS)).toEqual({
    loggedIn: true, email: "team@example.com", orgName: "team@example.com's Organization", subscriptionType: "max",
    orgId: "00000000-0000-4000-8000-000000000002",
  });
});

test("parseAuthStatus: multi-line JSON + noise with braces AFTER it (fix round 2)", () => {
  // A combination fix round 1 did not cover at all: the pretty-printed block is NOT on one
  // line, so a direct parse of the whole (trimmed) input fails because of the text after it —
  // the parser must be able to find a BALANCED {…} block inside the noise, not just try lines separately.
  const withNoiseAfter = `${REAL_CLAUDE_AUTH_STATUS}\nNew version available {try npm i -g @anthropic-ai/claude-code}`;
  expect(parseAuthStatus(withNoiseAfter)).toEqual({
    loggedIn: true, email: "team@example.com", orgName: "team@example.com's Organization", subscriptionType: "max",
    orgId: "00000000-0000-4000-8000-000000000002",
  });
});

test("profileIdentity: runs claude in a container with CLAUDE_CONFIG_DIR on the profile", async () => {
  const { d, calls } = fake([{ stdout: '{"loggedIn":true,"email":"a@b.cz"}' }]);
  const id = await profileIdentity(d, "primary");
  expect(id.email).toBe("a@b.cz");
  const cmd = calls[0].cmd.join(" ");
  expect(cmd).toContain("CLAUDE_CONFIG_DIR=/home/dev/.claude-accounts/primary");
  expect(cmd).toContain("claude-home:/home/dev/.claude");
  expect(cmd).toContain("claude-acct-primary:/home/dev/.claude-accounts/primary");
  expect(calls[0].cmd.slice(-3)).toEqual(["claude", "auth", "status"]);
});

test("removeProfile deletes the volume", async () => {
  const { d, calls } = fake();
  expect(await removeProfile(d, "primary")).toBe("removed");
  expect(calls[0].cmd).toEqual(["volume", "rm", "-f", "claude-acct-primary"]);
  expect(calls).toHaveLength(1);   // the clean case MUST NOT touch the volume's content
});

// I4 (review round 4): `docker volume rm -f` refuses to delete a volume held by
// a live mount — and that is a NORMAL state (EVERY session container mounts ALL
// profiles). The invariant that matters is "no live refresh token stays on disk
// without a row in the DB" — not "the volume disappears". So the profile is emptied and removal succeeds;
// otherwise on a full devbox the account could never be removed, only by taking down all sessions.
test("removeProfile: volume held by containers → empties the profile and returns 'purged'", async () => {
  const { d, calls } = fake([
    { code: 1, stderr: "Error response from daemon: remove claude-acct-primary: volume is in use - [abc123]" },
  ]);
  expect(await removeProfile(d, "primary")).toBe("purged");
  expect(calls[1].cmd).toEqual([
    "run", "--rm", "-u", "0",
    "-v", "claude-acct-primary:/profile",
    "devbox:test", "find", "/profile", "-mindepth", "1", "-delete",
  ]);
});

// If emptying failed, the invariant BREAKS — the token would survive on disk, but the
// handler would delete the row in the DB. Here the hard failure must hold.
test("removeProfile throws when even emptying the profile fails", async () => {
  const { d } = fake([
    { code: 1, stderr: "volume is in use" },
    { code: 1, stderr: "permission denied" },
  ]);
  await expect(removeProfile(d, "primary")).rejects.toThrow(/could not be emptied/);
});

// "Volume holds a mount" is the only reason it may continue. Any other docker
// failure means we know nothing about the profile's state — deleting the DB row would be guesswork.
test("removeProfile throws on an error other than 'in use' and does not touch the profile", async () => {
  const { d, calls } = fake([{ code: 1, stderr: "Cannot connect to the Docker daemon" }]);
  await expect(removeProfile(d, "primary")).rejects.toThrow(/primary/);
  expect(calls).toHaveLength(1);
});
