import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = join(import.meta.dir, "../../image");
const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-account-launch-")));
  roots.push(root);
  const bin = join(root, "bin"), shared = join(root, "shared"), accounts = join(root, "accounts");
  for (const directory of [bin, shared, accounts]) mkdirSync(directory);
  // The image has Ubuntu 24.04 Python 3.12; macOS /usr/bin/python3 is only 3.9.
  const python = ["python3.14", "python3.13", "python3.12", "python3.11", "python3"].map((name) => Bun.which(name)).find(Boolean);
  if (!python) throw new Error("Python 3.11+ is required for Codex account config fixtures");
  symlinkSync(python, join(bin, "python3"));
  for (const file of ["co", "codex-account-env.sh", "codex-account-seed.py"])
    cpSync(join(IMAGE, file), join(bin, file));
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755);
  };
  script("curl", [
    "#!/usr/bin/env python3", "import os, sys",
    "with open(os.environ['TRACE'], 'a') as out: out.write('curl ' + ' '.join(sys.argv[1:]) + '\\n')",
    "if os.environ.get('CURL_OFFLINE') == '1': sys.exit(7)",
    "print(os.environ.get('SELECT_REPLY', '{\"accountId\":\"default\"}'))",
    "print(os.environ.get('SELECT_STATUS', '200'), end='')",
  ].join("\n"));
  script("tmux", [
    "#!/usr/bin/env python3", "import os, sys", "args = sys.argv[1:]",
    "with open(os.environ['TRACE'], 'a') as out: out.write('tmux ' + ' '.join(args) + '\\n')",
    "pane = args[args.index('-t') + 1]",
    "path = os.path.join(os.environ['TEST_ROOT'], 'pane-' + pane)",
    "if args[0] == 'show-options':",
    "    try: print(open(path).read(), end='')",
    "    except FileNotFoundError: sys.exit(1)",
    "else:",
    "    with open(path, 'w') as out: out.write(args[-1])",
  ].join("\n"));
  script("codex", [
    "#!/usr/bin/env python3", "import json, os, sys",
    "keys = ['CODEX_HOME', 'CODEX_SQLITE_HOME', 'DEVD_CODEX_REMOTE', 'DEVD_SESSION_ID', 'DEVD_CODEX_SHARED_HOME']",
    "print(json.dumps({'args': sys.argv[1:], 'env': {key: os.environ.get(key) for key in keys}}))",
  ].join("\n"));
  // Production adds an absolute Remote dispatch after account selection. Stub
  // that boundary too, so compatibility runs never execute a host installation.
  script("codex-remote", '#!/bin/sh\nshift\nexec codex "$@"\n');
  const launcherPath = join(bin, "co");
  writeFileSync(launcherPath, readFileSync(launcherPath, "utf8").replaceAll("/usr/local/bin/codex-remote", join(bin, "codex-remote")));
  script("seed-codex-hooks", '#!/usr/bin/env bash\nprintf \'seed %s\\n\' "$CODEX_HOME" >> "$TRACE"\nexec bash "$SEED_SCRIPT"\n');
  script("devd-hook.sh", "#!/usr/bin/env bash\nexit 0\n");
  script("warp-hook.sh", "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(shared, "config.toml"), [
    'model = "gpt-5.4"',
    'sqlite_home = "/must-not-be-shared"',
    'forced_chatgpt_workspace_id = "must-not-be-inherited"',
    'chatgpt_base_url = "https://must-not-be-inherited.invalid"',
    'cli_auth_credentials_store = "keyring"',
    '[mcp_servers."test.mcp"]', 'command = "node"', 'args = ["/opt/test-mcp.mjs"]',
    '[mcp_servers."test.mcp".env]', 'TEST_VALUE = "line\\nnext"',
    '[features]', 'code_mode = true',
  ].join("\n"));
  writeFileSync(join(shared, "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "custom-hook" }] }] } }));
  writeFileSync(join(shared, "AGENTS.md"), "Shared guidance\n");
  mkdirSync(join(shared, "skills"));
  for (const item of ["auth.json", "state_5.sqlite", "thread_history_1.sqlite", "installation-id"])
    writeFileSync(join(shared, item), "fixture-only-shared-data");
  for (const item of ["sessions", "thread-writer-locks", "app-server-control", "plugins"])
    mkdirSync(join(shared, item));
  const addAccount = (id = ACCOUNT) => {
    const path = join(accounts, id); mkdirSync(path);
    writeFileSync(join(path, "auth.json"), "fixture-only-account-data");
    return path;
  };
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PATH: bin + ":" + process.env.PATH, TEST_ROOT: root, TRACE: join(root, "trace"),
    HOME: root, CODEX_HOME: shared, CODEX_SQLITE_HOME: "", DEVD_CODEX_REMOTE: "1",
    DEVD_CODEX_ACCOUNTS_DIR: accounts, DEVD_CODEX_ACCOUNT_ID: "", DEVD_CODEX_SHARED_HOME: "",
    DEVD_URL: "http://devd.invalid:4300", DEVD_SESSION_ID: "dev-test-fixture", DEVD_AGENT_AUTO_UPDATE: "0",
    TMUX_PANE: "", TMUX: "", SEED_SCRIPT: join(IMAGE, "seed-codex-hooks.sh"),
    DEVD_HOOK: join(bin, "devd-hook.sh"), WARP_HOOK: join(bin, "warp-hook.sh"),
    CURL_OFFLINE: "", SELECT_STATUS: "200", SELECT_REPLY: '{"accountId":"default","label":"Main"}',
  };
  const run = async (extra: Record<string, string> = {}, args: string[] = []) => {
    const process = Bun.spawn(["bash", join(bin, "co"), ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    return { code, stderr, data: stdout.trim() ? JSON.parse(stdout) as { args: string[]; env: Record<string, string | null> } : null };
  };
  const trace = () => existsSync(env.TRACE) ? readFileSync(env.TRACE, "utf8") : "";
  return { root, shared, accounts, addAccount, run, trace, env };
}

test("Codex default leaves primary home, Remote and config unchanged", async () => {
  const f = fixture(), before = readFileSync(join(f.shared, "config.toml"), "utf8");
  const result = await f.run({ CODEX_SQLITE_HOME: "/existing-primary-sqlite" });
  expect(result.code).toBe(0);
  expect(result.data?.env.CODEX_HOME).toBe(f.shared);
  expect(result.data?.env.CODEX_SQLITE_HOME).toBe("/existing-primary-sqlite");
  expect(result.data?.env.DEVD_CODEX_REMOTE).toBe("1");
  expect(result.data?.args.some((arg) => arg.startsWith("sqlite_home="))).toBe(false);
  expect(readFileSync(join(f.shared, "config.toml"), "utf8")).toBe(before);
  expect(f.trace()).not.toContain("seed ");
});

test("Codex secondary has private SQLite, auth, history and hooks while preserving MCP config", async () => {
  const f = fixture(), profile = f.addAccount();
  const result = await f.run({ SELECT_REPLY: JSON.stringify({ accountId: ACCOUNT, label: "Work" }), CODEX_SQLITE_HOME: f.shared });
  expect(result.code).toBe(0);
  expect(result.data?.env.CODEX_HOME).toBe(profile);
  expect(result.data?.env.CODEX_SQLITE_HOME).toBe(profile);
  expect(result.data?.env.DEVD_CODEX_REMOTE).toBe("0");
  expect(result.data?.env.DEVD_SESSION_ID).toBe("dev-test-fixture");
  expect(result.data?.args).toContain("sqlite_home=" + JSON.stringify(profile));
  expect(f.trace()).toContain("available=default," + ACCOUNT);
  expect(readFileSync(join(profile, "auth.json"), "utf8")).toBe("fixture-only-account-data");
  const config = readFileSync(join(profile, "config.toml"), "utf8");
  expect(config).toContain('"mcp_servers"');
  expect(config).toContain('"test.mcp"');
  expect(config).toContain('"line\\nnext"');
  expect(config).not.toContain("must-not-be-inherited");
  expect(config).not.toContain("must-not-be-shared");
  const hooks = JSON.parse(readFileSync(join(profile, "hooks.json"), "utf8"));
  expect(JSON.stringify(hooks)).toContain("custom-hook");
  expect(JSON.stringify(hooks)).toContain("devd-hook.sh");
  expect(JSON.stringify(hooks)).toContain("warp-hook.sh");
  expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("Shared guidance\n");
  expect(readdirSync(profile).sort()).toEqual(["AGENTS.md", "auth.json", "config.toml", "hooks.json", "skills"]);
});

test("Codex validates explicit IDs and refuses missing mounted profiles", async () => {
  const f = fixture();
  for (const id of ["../shared", "UPPERCASE", "not-an-account", ACCOUNT]) {
    const result = await f.run({ DEVD_CODEX_ACCOUNT_ID: id });
    expect(result.code).toBe(1);
    expect(result.data).toBeNull();
    expect(result.stderr).toContain("Codex:");
  }
  expect(f.trace()).toBe("");
});

test("Codex offline and legacy endpoints preserve default behavior", async () => {
  const f = fixture();
  const failures: Record<string, string>[] = [{ CURL_OFFLINE: "1" }, { SELECT_STATUS: "404" }, { SELECT_STATUS: "503" }];
  for (const failure of failures) {
    const result = await f.run(failure);
    expect(result.code).toBe(0);
    expect(result.data?.env.CODEX_HOME).toBe(f.shared);
  }
});

test("Codex selection conflict never falls through to primary billing", async () => {
  const f = fixture();
  for (const error of ["Preferred account is not mounted", "All accounts are disabled"]) {
    const result = await f.run({ SELECT_STATUS: "409", SELECT_REPLY: JSON.stringify({ error }) });
    expect(result.code).toBe(1);
    expect(result.data).toBeNull();
    expect(result.stderr).toContain(error);
  }
});

test("Codex rejects malformed or unmounted automatic choices", async () => {
  const f = fixture();
  for (const reply of ["not json", '{"accountId":"../shared"}', JSON.stringify({ accountId: ACCOUNT })]) {
    const result = await f.run({ SELECT_REPLY: reply });
    expect(result.code).toBe(1);
    expect(result.data).toBeNull();
  }
});

test("Codex direct resume keeps the pane account; new pane uses current preference", async () => {
  const f = fixture(), profile = f.addAccount();
  expect((await f.run({ TMUX_PANE: "%1", SELECT_REPLY: JSON.stringify({ accountId: ACCOUNT }) })).code).toBe(0);
  const calls = f.trace().split("\n").filter((line) => line.startsWith("curl ")).length;
  const resumed = await f.run({ TMUX_PANE: "%1", SELECT_STATUS: "409" }, ["resume", "--last"]);
  expect(resumed.code).toBe(0);
  expect(resumed.data?.env.CODEX_HOME).toBe(profile);
  expect(resumed.data?.args.slice(-2)).toEqual(["resume", "--last"]);
  expect(f.trace().split("\n").filter((line) => line.startsWith("curl ")).length).toBe(calls);
  expect((await f.run({ TMUX_PANE: "%2" })).data?.env.CODEX_HOME).toBe(f.shared);
});

test("Codex fresh resume and fork preserve legacy history without consulting auto preference", async () => {
  const f = fixture(); f.addAccount();
  for (const args of [["resume", "existing-thread"], ["resume", "--last"], ["fork", "--last"], ["--continue"], ["-m", "gpt-5.4", "resume"]]) {
    const result = await f.run({ SELECT_REPLY: JSON.stringify({ accountId: ACCOUNT }) }, args);
    expect(result.code).toBe(0);
    expect(result.data?.env.CODEX_HOME).toBe(f.shared);
  }
  expect(f.trace()).toBe("");
});

test("Codex removed pane account fails without switching its history", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "pane-%1"), ACCOUNT);
  const result = await f.run({ TMUX_PANE: "%1" }, ["resume", "--last"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("history");
  expect(f.trace()).not.toContain("curl ");
});

test("Codex explicit account overrides a saved pane and is remembered", async () => {
  const f = fixture(), profile = f.addAccount(OTHER);
  writeFileSync(join(f.root, "pane-%1"), ACCOUNT);
  const result = await f.run({ TMUX_PANE: "%1", DEVD_CODEX_ACCOUNT_ID: OTHER });
  expect(result.code).toBe(0);
  expect(result.data?.env.CODEX_HOME).toBe(profile);
  expect(readFileSync(join(f.root, "pane-%1"), "utf8")).toBe(OTHER);
  expect(f.trace()).not.toContain("curl ");
});

test("Codex help, version, auth and direct API probes have no account side effects", async () => {
  const f = fixture();
  for (const args of [["--help"], ["--version"], ["login", "status"], ["logout"], ["exec", "test"], ["resume", "--help"], ["-c", 'model="test"', "mcp", "list"], ["--remote", "unix:///chosen.sock"]]) {
    const result = await f.run({ DEVD_CODEX_ACCOUNT_ID: "bad-id", TMUX_PANE: "%1" }, args);
    expect(result.code).toBe(0);
    expect(result.data?.env.CODEX_HOME).toBe(f.shared);
  }
  expect(f.trace()).toBe("");
}, 15_000); // Eight real process launches also run on macOS CI under load.

test("Codex independent SQLite overrides saved config and rejects CLI redirection", async () => {
  const f = fixture(), profile = f.addAccount();
  writeFileSync(join(profile, "config.toml"), "sqlite_home = " + JSON.stringify(f.shared) + "\n");
  const result = await f.run({ DEVD_CODEX_ACCOUNT_ID: ACCOUNT });
  expect(result.code).toBe(0);
  expect(result.data?.args).toContain("sqlite_home=" + JSON.stringify(profile));
  for (const args of [["-c", 'sqlite_home="/shared"'], ['--config=sqlite_home="/shared"'], ['-csqlite_home="/shared"']]) {
    const blocked = await f.run({ DEVD_CODEX_ACCOUNT_ID: ACCOUNT }, args);
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toContain("sqlite_home");
  }
});

test("Codex invalid shared config fails privately and preserves account auth", async () => {
  const f = fixture(), profile = f.addAccount();
  writeFileSync(join(f.shared, "config.toml"), 'broken = "do-not-print-this-value');
  const result = await f.run({ DEVD_CODEX_ACCOUNT_ID: ACCOUNT });
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain("do-not-print-this-value");
  expect(readFileSync(join(profile, "auth.json"), "utf8")).toBe("fixture-only-account-data");
});

test("Codex nested secondary cannot silently label its inherited home as default", async () => {
  const f = fixture(), profile = f.addAccount();
  const result = await f.run({
    DEVD_CODEX_ACCOUNT_ID: "default", CODEX_HOME: profile, CODEX_SQLITE_HOME: profile,
    DEVD_CODEX_REMOTE: "0", DEVD_CODEX_SHARED_HOME: f.shared, TMUX_PANE: "%1",
  });
  expect(result.code).toBe(1);
  expect(result.data).toBeNull();
  expect(result.stderr).toContain("new terminal pane");
  expect(f.trace()).not.toContain("set-option");
});
