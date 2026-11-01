import { expect, test } from "bun:test";
import { credentialFiles, credFreshness, decideSync, syncCreds, type CredIo } from "../src/instabox/credsSync";

const claude = (exp: number) => JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: exp } });
const codex = (iso: string) => JSON.stringify({ tokens: {}, last_refresh: iso });
const SHARED = credentialFiles({ claude: [], codex: [] });

test("credentialFiles: shared files + pool profiles from the same mount lists as the session", () => {
  expect(credentialFiles({ claude: ["a1", "bad id"], codex: ["default", "g1"] })).toEqual([
    { kind: "claude", volume: "claude-home", file: ".credentials.json" },
    { kind: "codex", volume: "codex-home", file: "auth.json" },
    { kind: "claude", volume: "claude-acct-a1", file: ".credentials.json" },
    { kind: "codex", volume: "codex-acct-g1", file: "auth.json" },
  ]);
});

test("credFreshness", () => {
  expect(credFreshness("claude", claude(123))).toBe(123);
  expect(credFreshness("codex", codex("2026-10-16T10:00:00Z"))).toBe(Date.parse("2026-10-16T10:00:00Z"));
  expect(credFreshness("claude", null)).toBeNull();
  expect(credFreshness("claude", "{broken")).toBeNull();
  expect(credFreshness("codex", JSON.stringify({}))).toBeNull();
});

test("decideSync: the newer one wins, equality and unknown do nothing", () => {
  expect(decideSync(2, 1)).toBe("push");
  expect(decideSync(1, 2)).toBe("pull");
  expect(decideSync(5, 5)).toBe("none");
  expect(decideSync(null, 5)).toBe("pull");
  expect(decideSync(5, null)).toBe("push");
  expect(decideSync(null, null)).toBe("none");
});

function memIo(init: Record<string, string | null>): CredIo & { store: Record<string, string | null> } {
  const store = { ...init };
  return {
    store,
    async read(side, volume, file) { return store[`${side}:${volume}/${file}`] ?? null; },
    async write(side, volume, file, content) { store[`${side}:${volume}/${file}`] = content; },
  };
}

test("syncCreds both: pull of the newer claude, push of the newer codex", async () => {
  const io = memIo({
    "local:claude-home/.credentials.json": claude(1), "remote:claude-home/.credentials.json": claude(2),
    "local:codex-home/auth.json": codex("2026-10-16T12:00:00Z"), "remote:codex-home/auth.json": codex("2026-10-16T11:00:00Z"),
  });
  const r = await syncCreds(io, SHARED, "both");
  expect(r.map((x) => [x.file, x.action])).toEqual([["claude-home/.credentials.json", "pull"], ["codex-home/auth.json", "push"]]);
  expect(io.store["local:claude-home/.credentials.json"]).toBe(claude(2));
  expect(io.store["remote:codex-home/auth.json"]).toBe(codex("2026-10-16T12:00:00Z"));
});

test("syncCreds push: never overwrites local and never pushes an older one", async () => {
  const io = memIo({ "local:claude-home/.credentials.json": claude(1), "remote:claude-home/.credentials.json": claude(2) });
  const r = await syncCreds(io, SHARED, "push");
  expect(r[0]!.action).toBe("none");
  expect(io.store["local:claude-home/.credentials.json"]).toBe(claude(1));
});

test("syncCreds: broken JSON does not spread, the valid side replaces it", async () => {
  const io = memIo({ "local:claude-home/.credentials.json": "{broken", "remote:claude-home/.credentials.json": claude(2) });
  await syncCreds(io, SHARED, "both");
  expect(io.store["local:claude-home/.credentials.json"]).toBe(claude(2));
  const io2 = memIo({ "local:claude-home/.credentials.json": claude(2), "remote:claude-home/.credentials.json": "{broken" });
  await syncCreds(io2, SHARED, "both");
  expect(io2.store["remote:claude-home/.credentials.json"]).toBe(claude(2));
});

test("syncCreds: a read error of one file does not stop the others and reports an error", async () => {
  const io = memIo({
    "remote:claude-home/.credentials.json": claude(2),
    "local:codex-home/auth.json": codex("2026-10-16T12:00:00Z"), "remote:codex-home/auth.json": codex("2026-10-16T11:00:00Z"),
  });
  const failing: CredIo = {
    async read(side, volume, file) {
      if (side === "local" && volume === "claude-home") throw new Error("boom-read");
      return io.read(side, volume, file);
    },
    write: io.write,
  };
  const r = await syncCreds(failing, SHARED, "both");
  expect(r[0]).toEqual({ file: "claude-home/.credentials.json", volume: "claude-home", action: "none", local: null, remote: null, error: "boom-read" });
  expect(r[1]).toEqual({ file: "codex-home/auth.json", volume: "codex-home", action: "push", local: Date.parse("2026-10-16T12:00:00Z"), remote: Date.parse("2026-10-16T11:00:00Z") });
  expect(io.store["remote:codex-home/auth.json"]).toBe(codex("2026-10-16T12:00:00Z"));
});

test("syncCreds: a write error of one file does not stop the others and reports an error", async () => {
  const io = memIo({
    "local:claude-home/.credentials.json": claude(2), "remote:claude-home/.credentials.json": claude(1),
    "local:codex-home/auth.json": codex("2026-10-16T11:00:00Z"), "remote:codex-home/auth.json": codex("2026-10-16T12:00:00Z"),
  });
  const failing: CredIo = {
    read: io.read,
    async write(side, volume, file, content) {
      if (side === "remote" && volume === "claude-home") throw new Error("boom-write");
      return io.write(side, volume, file, content);
    },
  };
  const r = await syncCreds(failing, SHARED, "both");
  expect(r[0]).toEqual({ file: "claude-home/.credentials.json", volume: "claude-home", action: "none", local: null, remote: null, error: "boom-write" });
  expect(r[1]).toEqual({ file: "codex-home/auth.json", volume: "codex-home", action: "pull", local: Date.parse("2026-10-16T11:00:00Z"), remote: Date.parse("2026-10-16T12:00:00Z") });
  expect(io.store["local:codex-home/auth.json"]).toBe(codex("2026-10-16T12:00:00Z"));
  expect(io.store["remote:claude-home/.credentials.json"]).toBe(claude(1));
});

test("syncCreds: an account added after create (remote volume empty) gets a push", async () => {
  const files = credentialFiles({ claude: ["a1"], codex: [] });
  const io = memIo({ "local:claude-acct-a1/.credentials.json": claude(7) });
  const r = await syncCreds(io, files, "both");
  expect(r.find((x) => x.volume === "claude-acct-a1")).toEqual({ file: "claude-acct-a1/.credentials.json", volume: "claude-acct-a1", action: "push", local: 7, remote: null });
  expect(io.store["remote:claude-acct-a1/.credentials.json"]).toBe(claude(7));
});
