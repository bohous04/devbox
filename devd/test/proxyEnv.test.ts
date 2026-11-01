import { expect, test } from "bun:test";
import { DEFAULT_CONFIG, type Settings } from "../src/config";
import { agentContextTokens, CLIPROXY_DEFAULT_CTX, DEFAULT_CLIPROXY_URL, DEFAULT_OPENROUTER_URL, proxyEnv, PROXY_ENV_KEYS, sessionSettings, upstreamKey } from "../src/sessions";

const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_CONFIG.settings, ...over });

test("a proxy profile gets the model, URL and key", () => {
  const e = proxyEnv("claude-gpt", settings({ proxyModels: { gpt: "gpt-5.6-sol" } }), () => "k-123");
  expect(e.DEVD_AGENT_MODEL).toBe("gpt-5.6-sol");
  expect(e.DEVD_CLIPROXY_URL).toBe(DEFAULT_CLIPROXY_URL);
  expect(e.DEVD_CLIPROXY_KEY).toBe("k-123");
});

test("native profiles get NOT A SINGLE proxy variable", () => {
  for (const agent of ["claude", "codex", "grok"] as const) {
    expect(proxyEnv(agent, settings(), () => "k-123")).toEqual({});
  }
});

// Switching agents clears the old profile's values from the pane shell according to PROXY_ENV_KEYS
// (agentSwitch.ts). A key that proxyEnv could emit but the list does not know would silently survive
// a profile switch — and show up as a wrong upstream/model without a trace.
test("PROXY_ENV_KEYS covers every key proxyEnv can emit", () => {
  const known: readonly string[] = PROXY_ENV_KEYS;
  for (const agent of ["claude-gpt", "claude-grok", "claude-openrouter"] as const) {
    const env = proxyEnv(agent, settings({ proxyModels: { gpt: "m", grok: "m", openrouter: "m" } }), () => "k", 123_456);
    for (const k of Object.keys(env)) expect(known).toContain(k);
  }
});

test("a locked vault does not block the container — the key is just missing", () => {
  const e = proxyEnv("claude-grok", settings({ proxyModels: { grok: "grok-4.5" } }),
    () => { throw new Error("vault is locked"); });
  expect(e.DEVD_CLIPROXY_KEY).toBe("");
  expect(e.DEVD_AGENT_MODEL).toBe("grok-4.5");
});

test("an unconfigured model gives empty, not undefined in env", () => {
  const e = proxyEnv("claude-gpt", settings(), () => "k");
  expect(e.DEVD_AGENT_MODEL).toBe("");
});

test("settings.cliproxyUrl overrides DEFAULT_CLIPROXY_URL", () => {
  const e = proxyEnv("claude-gpt", settings({ cliproxyUrl: "http://gw:9000" }), () => "k");
  expect(e.DEVD_CLIPROXY_URL).toBe("http://gw:9000");
});

test("key() returns an empty string (not throw, not null) — DEVD_CLIPROXY_KEY stays empty", () => {
  const e = proxyEnv("claude-gpt", settings(), () => "");
  expect(e.DEVD_CLIPROXY_KEY).toBe("");
});

// The key is taken per upstream, not globally. If CLIProxyAPI values were hardcoded,
// OpenRouter would get a key it does not know — and cc would crash only on the first request with a 401.
test("the openrouter profile goes directly to OpenRouter with its own key", () => {
  const e = proxyEnv("claude-openrouter", settings({ proxyModels: { openrouter: "stealth/ox-alpha" } }),
    (u) => (u === "openrouter" ? "or-key" : "cliproxy-key"));
  expect(e.DEVD_AGENT_MODEL).toBe("stealth/ox-alpha");
  expect(e.DEVD_UPSTREAM_URL).toBe(DEFAULT_OPENROUTER_URL);
  expect(e.DEVD_UPSTREAM_KEY).toBe("or-key");
});

test("a cliproxy profile must NOT take the OpenRouter key", () => {
  const e = proxyEnv("claude-gpt", settings({ proxyModels: { gpt: "gpt-5.6-sol" } }),
    (u) => (u === "openrouter" ? "or-key" : "cliproxy-key"));
  expect(e.DEVD_UPSTREAM_URL).toBe(DEFAULT_CLIPROXY_URL);
  expect(e.DEVD_UPSTREAM_KEY).toBe("cliproxy-key");
});

// Containers are NOT recreated after a devd deploy and `agent-launch.sh` is baked into the image,
// so an old container can only read the old names. Until the image is rebuilt, both
// pairs must carry the same — otherwise claude-gpt/claude-grok would report a missing key after deploy.
test("legacy DEVD_CLIPROXY_* carries the same as DEVD_UPSTREAM_*", () => {
  for (const agent of ["claude-gpt", "claude-openrouter"] as const) {
    const e = proxyEnv(agent, settings(), () => "k");
    expect(e.DEVD_CLIPROXY_URL).toBe(e.DEVD_UPSTREAM_URL!);
    expect(e.DEVD_CLIPROXY_KEY).toBe(e.DEVD_UPSTREAM_KEY!);
  }
});

test("a locked key source does not block the OpenRouter profile either", () => {
  const e = proxyEnv("claude-openrouter", settings({ proxyModels: { openrouter: "stealth/ox-alpha" } }),
    () => { throw new Error("the key file cannot be read"); });
  expect(e.DEVD_UPSTREAM_KEY).toBe("");
  expect(e.DEVD_AGENT_MODEL).toBe("stealth/ox-alpha");
});

// Key-source routing is its own function precisely so it can be verified without docker:
// otherwise swapped sources only show up when cc gets a 401 on the first request.
test("upstreamKey reaches into each upstream's own source", () => {
  const key = upstreamKey({ cliproxyKey: () => "cliproxy-key", openrouterKey: () => "or-key" });
  expect(key("cliproxy")).toBe("cliproxy-key");
  expect(key("openrouter")).toBe("or-key");
});

// An unwired source (older deployments without the key file) must give null, not undefined —
// proxyEnv turns it into an empty string and agent-launch in the container prints the message.
test("upstreamKey without a wired source returns null, not undefined", () => {
  const key = upstreamKey({});
  expect(key("cliproxy")).toBeNull();
  expect(key("openrouter")).toBeNull();
});

// Context window: for an unrecognized model cc assumes 200k and the session then keeps
// compacting (measured 2026-08-22: stealth/ox-alpha has 1M, cc compacted at 168k).
// devd sends the measured window as an INERT DEVD_AGENT_CTX — it is translated to CLAUDE_CODE_MAX_CONTEXT_TOKENS
// only by agent-launch in the proxy branch, so the active name does not leak into another
// profile started alongside in the same container.
test("the openrouter profile gets DEVD_AGENT_CTX when the model's window is known", () => {
  const e = proxyEnv("claude-openrouter", settings({ proxyModels: { openrouter: "stealth/ox-alpha" } }),
    () => "k", 1048576);
  expect(e.DEVD_AGENT_CTX).toBe("1048576");
});

test("without a known window DEVD_AGENT_CTX is not in env at all", () => {
  const e = proxyEnv("claude-openrouter", settings({ proxyModels: { openrouter: "stealth/ox-alpha" } }),
    () => "k", null);
  expect("DEVD_AGENT_CTX" in e).toBe(false);
  expect("DEVD_AGENT_CTX" in proxyEnv("claude-openrouter", settings(), () => "k")).toBe(false);
});

// Where the context window comes from: the OpenRouter profile has a public catalog (lookup),
// cliproxy models have none — a 1M default applies there (user decision
// 2026-08-22: gpt-5.6-sol and grok-4.5 otherwise compacted at an assumed 200k).
// A smaller real window then means an API error instead of a compact — a conscious trade-off.
test("cliproxy profiles get a 1M default without a lookup", async () => {
  let lookups = 0;
  const lookup = async () => { lookups++; return 123; };
  expect(await agentContextTokens("claude-gpt", settings({ proxyModels: { gpt: "gpt-5.6-sol" } }), lookup)).toBe(CLIPROXY_DEFAULT_CTX);
  expect(await agentContextTokens("claude-grok", settings(), lookup)).toBe(CLIPROXY_DEFAULT_CTX);
  expect(CLIPROXY_DEFAULT_CTX).toBe(1_000_000);
  expect(lookups).toBe(0);
});

test("the openrouter profile asks the catalog for the configured model", async () => {
  const seen: string[] = [];
  const lookup = async (m: string) => { seen.push(m); return 1048576; };
  expect(await agentContextTokens("claude-openrouter", settings({ proxyModels: { openrouter: "stealth/ox-alpha" } }), lookup)).toBe(1048576);
  expect(seen).toEqual(["stealth/ox-alpha"]);
});

test("a native profile and openrouter without a model have no window (no lookup)", async () => {
  let lookups = 0;
  const lookup = async () => { lookups++; return 1; };
  expect(await agentContextTokens("claude", settings(), lookup)).toBeNull();
  expect(await agentContextTokens("claude-openrouter", settings(), lookup)).toBeNull();
  expect(lookups).toBe(0);
});

// A manual value from the dashboard (settings.proxyContext) overrides EVERYTHING — the catalog and
// the 1M default. Nonsense (0, negative, NaN) is ignored, as if it were not in the config.
test("a manual proxyContext overrides the default and the catalog (lookup is not called)", async () => {
  const boom = async () => { throw new Error("lookup must not be called"); };
  const s = settings({ proxyContext: { gpt: 400_000, openrouter: 262_144 }, proxyModels: { openrouter: "stealth/ox-alpha" } });
  expect(await agentContextTokens("claude-gpt", s, boom)).toBe(400_000);
  expect(await agentContextTokens("claude-openrouter", s, boom)).toBe(262_144);
  expect(await agentContextTokens("claude-grok", s, boom)).toBe(CLIPROXY_DEFAULT_CTX);
});

test("an invalid override is ignored", async () => {
  const s = settings({ proxyContext: { gpt: 0, grok: -5 } });
  const lookup = async () => null;
  expect(await agentContextTokens("claude-gpt", s, lookup)).toBe(CLIPROXY_DEFAULT_CTX);
  expect(await agentContextTokens("claude-grok", s, lookup)).toBe(CLIPROXY_DEFAULT_CTX);
});

// The model is changed from the dashboard WHILE devd RUNS. But `cfg` in SessionDeps is a snapshot from
// the moment of startup, so whoever reads the model from it gets a state that has long been
// stale on disk — the container then starts with an empty DEVD_AGENT_MODEL and agent-launch
// sends the person to "add the model to the config", which has long been in the config.
test("sessionSettings reads the fresh config, not the startup snapshot", () => {
  const startup = { ...DEFAULT_CONFIG, settings: settings({ proxyModels: { openrouter: "" } }) };
  const fresh = settings({ proxyModels: { openrouter: "stealth/ox-alpha" } });
  expect(sessionSettings({ cfg: startup, settings: () => fresh }).proxyModels?.openrouter)
    .toBe("stealth/ox-alpha");
});

// An unwired reader (tests, older callers) must fall back to the snapshot,
// not break container creation.
test("sessionSettings without a wired reader returns the snapshot from cfg", () => {
  const startup = { ...DEFAULT_CONFIG, settings: settings({ proxyModels: { gpt: "gpt-5.6-sol" } }) };
  expect(sessionSettings({ cfg: startup }).proxyModels?.gpt).toBe("gpt-5.6-sol");
});

// An unreadable config on disk must not bring the session down — a snapshot is still better than a crash.
test("sessionSettings survives a reader that throws", () => {
  const startup = { ...DEFAULT_CONFIG, settings: settings({ proxyModels: { gpt: "gpt-5.6-sol" } }) };
  expect(sessionSettings({ cfg: startup, settings: () => { throw new Error("config unreadable"); } })
    .proxyModels?.gpt).toBe("gpt-5.6-sol");
});
