import { describe, expect, test } from "bun:test";
import {
  addFolder, addGiteaInstance, addProject, addRepo, addSource, addSshServer, cloneConfig, configIssues,
  mergeFolders, mergeSettings, mergeSshServers,
  criticModelSuggestions,
  findSource, getAccountPool, getCritic, giteaIssues, hasRepo, hasUpstreamRepo, removeUpstreamRepo, uniqueRepoName, removeFolder, removeGiteaInstance,
  removeProject, removeProjectPin, removeRepo, removeSource, removeSshServer, setAccountPool, setCritic,
  setProjectPin, settingsIssues, sourceKey, sourceLabel, sshServerIssues, targetLabel,
  updateGiteaInstance, updateSetting, updateSshServer, validateConfig, validSeg, visibilityLabel,
  type DevConfig, type SshServer,
} from "./configEdit";

function base(): DevConfig {
  return {
    version: 1,
    settings: { autoStopHours: 4, portRangeStart: 40100, portsPerSession: 10, diskWarnPercent: 80 },
    folders: {
      acme: { projects: { agent: {}, shop: { repos: [{ name: "cms", provider: "github", repo: "acme/cms" }] } } },
      apps: { repos: [{ name: "tool", provider: "github", repo: "me/tool" }], sources: [{ provider: "github", user: "me" }] },
      games: { repos: [] },
    },
    giteaInstances: [{ name: "main", url: "https://git.example.com" }],
  };
}

/* ---------- validateConfig ---------- */

test("validateConfig accepts a valid config and rejects broken shapes", () => {
  expect(validateConfig(base())).toBeTruthy();
  expect(() => validateConfig(null)).toThrow("object");
  expect(() => validateConfig({ version: 2 })).toThrow("version");
  expect(() => validateConfig({ version: 1, settings: { autoStopHours: "4" }, folders: {} })).toThrow("settings");
  expect(() => validateConfig({ version: 1, settings: base().settings, folders: [] })).toThrow("folders");
});

/* ---------- repos ---------- */

describe("addRepo/removeRepo", () => {
  test("adds into a project without corrupting siblings and never mutates the input", () => {
    const cfg = base();
    const frozen = JSON.stringify(cfg);
    const next = addRepo(cfg, { folder: "acme", project: "agent" }, { name: "web", provider: "github", repo: "acme/web" });
    expect(JSON.stringify(cfg)).toBe(frozen); // original untouched
    expect(next.folders.acme?.projects?.agent?.repos).toEqual([{ name: "web", provider: "github", repo: "acme/web" }]);
    expect(next.folders.acme?.projects?.shop).toEqual(cfg.folders.acme?.projects?.shop); // sibling unchanged
    expect(next.folders.apps).toEqual(cfg.folders.apps);
    expect(validateConfig(next)).toBeTruthy(); // result passes validation
  });

  test("adds at folder level and dedupes by name", () => {
    const cfg = base();
    const once = addRepo(cfg, { folder: "apps" }, { name: "tool", provider: "github", repo: "someone-else/tool" });
    expect(once.folders.apps?.repos).toHaveLength(1);
    expect(once.folders.apps?.repos?.[0]?.repo).toBe("me/tool"); // original ref kept
    const added = addRepo(cfg, { folder: "games" }, { name: "esx", provider: "github", repo: "esx/esx" });
    expect(added.folders.games?.repos?.map((r) => r.name)).toEqual(["esx"]);
  });

  test("rejects invalid repo name and unknown target", () => {
    expect(() => addRepo(base(), { folder: "apps" }, { name: "..", provider: "github" })).toThrow("Invalid");
    expect(() => addRepo(base(), { folder: "nope" }, { name: "x", provider: "github" })).toThrow("Unknown target");
  });

  test("removeRepo removes only the one repo; hasRepo reflects state", () => {
    const cfg = base();
    expect(hasRepo(cfg, { folder: "apps" }, "tool")).toBe(true);
    const next = removeRepo(cfg, { folder: "apps" }, "tool");
    expect(next.folders.apps?.repos).toEqual([]);
    expect(next.folders.apps?.sources).toHaveLength(1); // sources untouched
    expect(hasRepo(next, { folder: "apps" }, "tool")).toBe(false);
    expect(hasRepo(cfg, { folder: "apps" }, "tool")).toBe(true); // original untouched
  });
});

describe("upstream repo identity (same name, different owners)", () => {
  const games = { folder: "games" };

  test("same-named repo from another owner is not reported as added", () => {
    const cfg = addRepo(base(), games, { name: "game_web", provider: "gitea", repo: "alice/game_web" });
    expect(hasUpstreamRepo(cfg, games, "gitea", "alice/game_web")).toBe(true);
    expect(hasUpstreamRepo(cfg, games, "gitea", "bob/game_web")).toBe(false);
    expect(hasUpstreamRepo(cfg, games, "github", "alice/game_web")).toBe(false);
  });

  test("uniqueRepoName suffixes the owner on collision", () => {
    let cfg = addRepo(base(), games, { name: "game_web", provider: "gitea", repo: "alice/game_web" });
    expect(uniqueRepoName(cfg, games, "other", "bob")).toBe("other");
    const name = uniqueRepoName(cfg, games, "game_web", "bob");
    expect(name).toBe("game_web-bob");
    cfg = addRepo(cfg, games, { name, provider: "gitea", repo: "bob/game_web" });
    expect(uniqueRepoName(cfg, games, "game_web", "bob")).toBe("game_web-bob-2");
    expect(cfg.folders.games?.repos).toHaveLength(2);
  });

  test("removeUpstreamRepo removes only the matching owner's repo", () => {
    let cfg = addRepo(base(), games, { name: "game_web", provider: "gitea", repo: "alice/game_web" });
    cfg = addRepo(cfg, games, { name: "game_web-bob", provider: "gitea", repo: "bob/game_web" });
    const next = removeUpstreamRepo(cfg, games, "gitea", "Bob/game_web");
    expect(next.folders.games?.repos?.map((r) => r.repo)).toEqual(["alice/game_web"]);
  });

  test("same owner/repo on two Gitea instances is told apart by cloneUrl", () => {
    const a = "http://198.51.100.7:3000/Alice/game_web.git";
    const b = "http://203.0.113.62:6010/alice/game_web.git";
    let cfg = addRepo(base(), games, { name: "game_web", provider: "gitea", repo: "Alice/game_web", cloneUrl: a });
    expect(hasUpstreamRepo(cfg, games, "gitea", "alice/game_web", a)).toBe(true);
    expect(hasUpstreamRepo(cfg, games, "gitea", "alice/game_web", b)).toBe(false);
    cfg = addRepo(cfg, games, { name: uniqueRepoName(cfg, games, "game_web", "alice"), provider: "gitea", repo: "alice/game_web", cloneUrl: b });
    const next = removeUpstreamRepo(cfg, games, "gitea", "alice/game_web", b);
    expect(next.folders.games?.repos?.map((r) => r.cloneUrl)).toEqual([a]);
  });

  test("entries without upstream repo fall back to name match", () => {
    const cfg = addRepo(base(), games, { name: "esx", provider: "github" });
    expect(hasUpstreamRepo(cfg, games, "github", "esx/esx")).toBe(true);
  });
});

/* ---------- sources ---------- */

describe("addSource/removeSource", () => {
  test("adds an org source into a project; produced config validates", () => {
    const next = addSource(base(), { folder: "acme", project: "agent" }, { provider: "github", org: "acme", visibility: "private" });
    expect(next.folders.acme?.projects?.agent?.sources).toEqual([{ provider: "github", org: "acme", visibility: "private" }]);
    expect(validateConfig(next)).toBeTruthy();
  });

  test("same owner again replaces (visibility update), not duplicates", () => {
    const a = addSource(base(), { folder: "apps" }, { provider: "github", user: "me", visibility: "private" });
    expect(a.folders.apps?.sources).toHaveLength(1);
    expect(a.folders.apps?.sources?.[0]?.visibility).toBe("private");
  });

  test("removeSource by key keeps repos intact", () => {
    const cfg = base();
    const key = sourceKey({ provider: "github", user: "me" });
    expect(findSource(cfg, { folder: "apps" }, key)).toBeTruthy();
    const next = removeSource(cfg, { folder: "apps" }, key);
    expect(next.folders.apps?.sources).toEqual([]);
    expect(next.folders.apps?.repos).toHaveLength(1);
    expect(findSource(next, { folder: "apps" }, key)).toBeUndefined();
  });

  test("sourceKey identity: org vs user same login, case-insensitive, instance-aware", () => {
    expect(sourceKey({ provider: "github", org: "Me" })).toBe(sourceKey({ provider: "github", user: "me" }));
    expect(sourceKey({ provider: "gitea", user: "me", instance: "a" })).not.toBe(sourceKey({ provider: "gitea", user: "me", instance: "b" }));
  });
});

/* ---------- folders & projects ---------- */

describe("folders & projects", () => {
  test("addFolder/addProject create empty nodes; duplicates and bad names rejected", () => {
    const withFolder = addFolder(base(), "tools");
    expect(withFolder.folders.tools).toEqual({});
    expect(() => addFolder(base(), "apps")).toThrow("already exists");
    expect(() => addFolder(base(), "café folder")).toThrow("Invalid");

    const withProject = addProject(withFolder, "tools", "cli");
    expect(withProject.folders.tools?.projects?.cli).toEqual({});
    expect(() => addProject(withProject, "tools", "cli")).toThrow("already exists");
    expect(() => addProject(base(), "nope", "x")).toThrow("Unknown folder");
    expect(validateConfig(withProject)).toBeTruthy();
  });

  test("removeProject removes just the one project; empty projects map is dropped", () => {
    const cfg = base();
    const next = removeProject(cfg, "acme", "agent");
    expect(next.folders.acme?.projects).toEqual({ shop: cfg.folders.acme!.projects!.shop! });
    const emptied = removeProject(removeProject(cfg, "acme", "agent"), "acme", "shop");
    expect(emptied.folders.acme?.projects).toBeUndefined();
    expect(emptied.folders.apps).toEqual(cfg.folders.apps);
  });

  test("removeFolder drops only that folder", () => {
    const next = removeFolder(base(), "games");
    expect(Object.keys(next.folders).sort()).toEqual(["acme", "apps"]);
  });
});

/* ---------- settings & gitea ---------- */

describe("settings", () => {
  test("updateSetting is immutable; settingsIssues flags NaN, floats and out-of-range", () => {
    const cfg = base();
    const next = updateSetting(cfg, "autoStopHours", 8);
    expect(next.settings.autoStopHours).toBe(8);
    expect(cfg.settings.autoStopHours).toBe(4);
    expect(settingsIssues(base().settings)).toEqual([]);
    expect(settingsIssues({ ...base().settings, autoStopHours: NaN })[0]).toContain("must be a number");
    expect(settingsIssues({ ...base().settings, portsPerSession: 2.5 })[0]).toContain("integer");
    expect(settingsIssues({ ...base().settings, portRangeStart: 80 })[0]).toContain("range");
    expect(settingsIssues({ ...base().settings, diskWarnPercent: 100 })[0]).toContain("range");
  });
});

describe("gitea instances", () => {
  test("add/update/remove rows; removing the last row drops the key", () => {
    const cfg = base();
    const added = addGiteaInstance(cfg);
    expect(added.giteaInstances).toHaveLength(2);
    const updated = updateGiteaInstance(added, 1, { name: "second", url: "https://g2.example.com" });
    expect(updated.giteaInstances?.[1]).toEqual({ name: "second", url: "https://g2.example.com" });
    const removedOne = removeGiteaInstance(updated, 0);
    expect(removedOne.giteaInstances).toEqual([{ name: "second", url: "https://g2.example.com" }]);
    const removedAll = removeGiteaInstance(removedOne, 0);
    expect(removedAll.giteaInstances).toBeUndefined();
    expect(validateConfig(removedAll)).toBeTruthy();
  });

  test("giteaIssues flags empty name, bad url, duplicates", () => {
    expect(giteaIssues([{ name: "main", url: "https://x.cz" }])).toEqual([]);
    expect(giteaIssues([{ name: "", url: "https://x.cz" }])[0]).toContain("invalid instance name");
    expect(giteaIssues([{ name: "a", url: "ftp://x" }])[0]).toContain("http(s)");
    expect(giteaIssues([{ name: "a", url: "https://x.cz" }, { name: "a", url: "https://y.cz" }])[0]).toContain("duplicate");
  });
});

describe("ssh servers", () => {
  const shop: SshServer = { name: "shop-root", key: "K", user: "root", host: "192.0.2.11", port: 22 };

  test("add/update/remove rows; removing the last row drops the key", () => {
    const cfg = base();
    const added = addSshServer(cfg);
    expect(added.sshServers).toHaveLength(1);
    const updated = updateSshServer(added, 0, shop);
    expect(updated.sshServers?.[0]).toEqual(shop);
    const removed = removeSshServer(updated, 0);
    expect(removed.sshServers).toBeUndefined();
    expect(validateConfig(removed)).toBeTruthy();
  });

  test("sshServerIssues: empty/missing list is valid, valid server has no issues", () => {
    expect(sshServerIssues(undefined)).toEqual([]);
    expect(sshServerIssues([])).toEqual([]);
    expect(sshServerIssues([shop])).toEqual([]);
  });

  test("sshServerIssues: duplicate name is flagged", () => {
    const issues = sshServerIssues([shop, { ...shop, host: "1.2.3.4" }]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/duplicate/i);
  });

  test("sshServerIssues: port 70000 is out of range", () => {
    const issues = sshServerIssues([{ ...shop, port: 70000 }]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/port/i);
  });

  test("sshServerIssues: port 0 and non-integer port are also rejected", () => {
    expect(sshServerIssues([{ ...shop, port: 0 }]).length).toBeGreaterThan(0);
    expect(sshServerIssues([{ ...shop, port: 2.5 }]).length).toBeGreaterThan(0);
  });

  test("sshServerIssues: invalid name shape (uppercase, empty)", () => {
    expect(sshServerIssues([{ ...shop, name: "Shop-Root" }]).length).toBeGreaterThan(0);
    expect(sshServerIssues([{ ...shop, name: "" }]).length).toBeGreaterThan(0);
  });

  test("sshServerIssues: empty or whitespace key/user/host", () => {
    expect(sshServerIssues([{ ...shop, key: "" }]).length).toBeGreaterThan(0);
    expect(sshServerIssues([{ ...shop, user: "a b" }]).length).toBeGreaterThan(0);
    expect(sshServerIssues([{ ...shop, host: "" }]).length).toBeGreaterThan(0);
  });

  test("configIssues includes sshServerIssues", () => {
    const cfg = updateSshServer(addSshServer(base()), 0, { ...shop, port: 0 });
    expect(configIssues(cfg).some((m) => /port/i.test(m))).toBe(true);
  });

  test("mergeSshServers: only sshServers is owned, rest comes from the server copy", () => {
    const server = { ...base(), sshServers: [shop] };
    const draft = { ...base(), sshServers: [{ ...shop, name: "other" }], settings: { ...base().settings, autoStopHours: 1 } };
    const merged = mergeSshServers(server, draft);
    expect(merged.sshServers).toEqual([{ ...shop, name: "other" }]);
    expect(merged.settings.autoStopHours).toBe(server.settings.autoStopHours); // other settings not overwritten
    merged.sshServers![0]!.name = "mutated";
    expect(draft.sshServers![0]!.name).toBe("other"); // deep clone, not a shared reference
  });

  test("mergeSshServers: draft without servers clears the key on the server copy", () => {
    const server = { ...base(), sshServers: [shop] };
    const draft = base();
    expect(mergeSshServers(server, draft).sshServers).toBeUndefined();
  });
});

/* ---------- misc ---------- */

test("labels and validSeg", () => {
  expect(targetLabel({ folder: "apps" })).toBe("apps/");
  expect(targetLabel({ folder: "acme", project: "shop" })).toBe("acme/shop");
  expect(visibilityLabel(undefined)).toBe("all");
  expect(visibilityLabel("private")).toBe("private only");
  expect(sourceLabel({ provider: "github", org: "acme", visibility: "public" })).toBe("acme · github · public only");
  expect(sourceLabel({ provider: "gitea", user: "me", instance: "main" })).toBe("me · gitea · main · all");
  expect(validSeg("ok-name_1.x")).toBe(true);
  expect(validSeg("..")).toBe(false);
  expect(validSeg("a b")).toBe(false);
});

test("configIssues aggregates and cloneConfig deep-copies", () => {
  const cfg = base();
  expect(configIssues(cfg)).toEqual([]);
  const clone = cloneConfig(cfg);
  clone.folders.apps!.repos!.push({ name: "x", provider: "github" });
  expect(cfg.folders.apps?.repos).toHaveLength(1);
});

/* ---------- critic ---------- */

test("getCritic returns the default (claude) when settings.critic is missing", () => {
  const c = getCritic({ version: 1, settings: {}, folders: {} } as unknown as DevConfig);
  expect(c.provider).toBe("claude");
});

test("setCritic immutably sets provider and model", () => {
  const base = { version: 1, settings: { autoStopHours: 4 }, folders: {} } as unknown as DevConfig;
  const next = setCritic(base, { provider: "codex", model: "" });
  expect((next.settings as { critic: { provider: string } }).critic.provider).toBe("codex");
  expect((base.settings as { critic?: unknown }).critic).toBeUndefined(); // original untouched
});

test("setCritic: switching provider drops the old provider's model", () => {
  const base = setCritic({ version: 1, settings: {}, folders: {} } as unknown as DevConfig, { provider: "claude", model: "sonnet" });
  const switched = setCritic(base, { provider: "codex" });
  expect((switched.settings as { critic: { model: string } }).critic.model).toBe("");
});

test("setCritic: an explicit model in the same patch as provider wins", () => {
  const base = setCritic({ version: 1, settings: {}, folders: {} } as unknown as DevConfig, { provider: "claude", model: "sonnet" });
  const switched = setCritic(base, { provider: "codex", model: "o3" });
  expect((switched.settings as { critic: { model: string } }).critic.model).toBe("o3");
});

test("getCritic/setCritic know antigravity", () => {
  const base = { version: 1, settings: {}, folders: {} } as unknown as DevConfig;
  const next = setCritic(base, { provider: "antigravity" });
  expect(getCritic(next).provider).toBe("antigravity");
  expect(getCritic(next).model).toBe("");
});

test("criticModelSuggestions: model options depend on the provider", () => {
  expect(criticModelSuggestions("claude")).toEqual(["opus", "sonnet", "haiku"]);
  expect(criticModelSuggestions("codex")).toEqual(["default"]);
  expect(criticModelSuggestions("antigravity")).toEqual([
    "default", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "claude-opus-5-5-high",
  ]);
});

/* ---------- account pool ---------- */

test("getAccountPool: missing block → defaults, not a crash", () => {
  const cfg = base();
  expect(getAccountPool(cfg)).toEqual({
    preferredAccountId: null, spilloverPct: 60, thresholdPct: 90,
    projectAccounts: {}, soloAccountId: null,
  });
});

test("setAccountPool: patch overwrites only its own fields", () => {
  const next = setAccountPool(base(), { spilloverPct: 40 });
  expect(getAccountPool(next).spilloverPct).toBe(40);
  expect(getAccountPool(next).thresholdPct).toBe(90);
});

test("setProjectPin and removeProjectPin do not mutate the original config", () => {
  const cfg = base();
  const pinned = setProjectPin(cfg, "games", "max5");
  expect(getAccountPool(pinned).projectAccounts).toEqual({ games: "max5" });
  // The original object stayed untouched — Save + push sends the draft, not a mutated original.
  expect(getAccountPool(cfg).projectAccounts).toEqual({});
  expect(getAccountPool(removeProjectPin(pinned, "games")).projectAccounts).toEqual({});
});

test("removeProjectPin of a nonexistent project is a no-op, not a crash", () => {
  expect(getAccountPool(removeProjectPin(base(), "neexistuje")).projectAccounts).toEqual({});
});

// Complement to the test above: that one starts from a config WITHOUT an accountPool block, so
// getAccountPool returns a fresh {} there anyway — it won't catch setProjectPin no longer
// copying the map and mutating it in place. Chained pinning on a draft that already
// has the map reveals aliasing of a shared reference.
test("setProjectPin does not mutate the map from the previous draft (chained pinning)", () => {
  const withGames = setProjectPin(base(), "games", "max5");
  const withBoth = setProjectPin(withGames, "acme", "max20");
  expect(getAccountPool(withGames).projectAccounts).toEqual({ games: "max5" });
  expect(getAccountPool(withBoth).projectAccounts).toEqual({ games: "max5", acme: "max20" });
});

// Mirror case for removeProjectPin — for the same reasons it must start from a
// draft where `projectAccounts` is already a REAL map (two pins), not from
// `base()`. Over `base()` getAccountPool would again return a fresh {} and the test
// would not catch in-place mutation (exactly this hole slipped through review for setProjectPin
// and it is easy to "simplify" it back here — don't).
test("removeProjectPin does not mutate the map from the previous draft (removing one of two pins)", () => {
  const withBoth = setProjectPin(setProjectPin(base(), "games", "max5"), "acme", "max20");
  const withOne = removeProjectPin(withBoth, "acme");
  expect(getAccountPool(withOne).projectAccounts).toEqual({ games: "max5" });
  // The original draft with two pins stayed untouched.
  expect(getAccountPool(withBoth).projectAccounts).toEqual({ games: "max5", acme: "max20" });
});

// I1 (final review): setAccountPool used to build the WHOLE accountPool block from just the
// five-field view (getAccountPool) — fields the dashboard does not control
// (hysteresisPct, cooldownMinutes, activePollSec, idlePollSec) have always been known to the
// server, but AccountPoolCfgView does not know them. Touching anything in the "Account
// pool" card and saving would drop them and the server would replace them with defaults. A config
// with non-default values for all four — they must stay unchanged after setProjectPin.
// `as unknown as DevConfig`, because those fields are not in AccountPoolCfgView
// (the dashboard does not know them, it just must not lose them).
test("setAccountPool keeps fields the dashboard does not control (I1)", () => {
  const cfg = {
    ...base(),
    settings: {
      ...base().settings,
      accountPool: {
        preferredAccountId: null, spilloverPct: 60, thresholdPct: 90,
        projectAccounts: {}, soloAccountId: null,
        hysteresisPct: 17, cooldownMinutes: 11, activePollSec: 45, idlePollSec: 222,
      },
    },
  } as unknown as DevConfig;

  const pinned = setProjectPin(cfg, "games", "max5");
  const raw = pinned.settings.accountPool as unknown as Record<string, unknown>;
  expect(raw.hysteresisPct).toBe(17);
  expect(raw.cooldownMinutes).toBe(11);
  expect(raw.activePollSec).toBe(45);
  expect(raw.idlePollSec).toBe(222);
  // And the mutation itself still happened.
  expect(getAccountPool(pinned).projectAccounts).toEqual({ games: "max5" });
});

// M5 (final review): getAccountPool returned `p.projectAccounts ?? {}` — a live
// reference to the map inside the config, not a copy. Mutating the call's result would
// thus leak all the way into the draft itself.
test("getAccountPool returns a copy of projectAccounts, not a live reference (M5)", () => {
  const cfg = setProjectPin(base(), "games", "max5");
  const view = getAccountPool(cfg);
  view.projectAccounts.games = "mutated";
  view.projectAccounts.extra = "should-not-leak";
  expect(getAccountPool(cfg).projectAccounts).toEqual({ games: "max5" });
});

test("mergeFolders overwrites only folders, keeps the rest from the server", () => {
  const server = { version: 1, settings: { autoStopHours: 9, portRangeStart: 1, portsPerSession: 2, diskWarnPercent: 3 }, folders: { a: {} }, giteaInstances: [{ name: "g", url: "u" }] } as DevConfig;
  const draft = { version: 1, settings: { autoStopHours: 1, portRangeStart: 1, portsPerSession: 1, diskWarnPercent: 1 }, folders: { b: {} } } as DevConfig;
  const out = mergeFolders(server, draft);
  expect(Object.keys(out.folders)).toEqual(["b"]);          // my folders won
  expect(out.settings.autoStopHours).toBe(9);               // other settings not overwritten
  expect(out.giteaInstances).toEqual([{ name: "g", url: "u" }]);
  out.folders.b = { repos: [] };
  expect(draft.folders.b).toEqual({});                      // deep clone, not a shared reference
});

test("mergeSettings overwrites everything except folders", () => {
  const server = { version: 1, settings: { autoStopHours: 9, portRangeStart: 1, portsPerSession: 2, diskWarnPercent: 3 }, folders: { a: {} } } as DevConfig;
  const draft = { version: 1, settings: { autoStopHours: 1, portRangeStart: 1, portsPerSession: 1, diskWarnPercent: 1 }, folders: { b: {} } } as DevConfig;
  const out = mergeSettings(server, draft);
  expect(out.settings.autoStopHours).toBe(1);               // my settings won
  expect(Object.keys(out.folders)).toEqual(["a"]);          // other folders not overwritten
});

test("sshServerIssues: key is a 1Password title and may contain spaces", () => {
  const base = { name: "shop", user: "main", host: "192.0.2.11", port: 2222 };
  expect(sshServerIssues([{ ...base, key: "SSH Key - Client shop" }])).toEqual([]);
  expect(sshServerIssues([{ ...base, key: "  " }])).toHaveLength(1);
});
