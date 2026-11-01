import { expect, test } from "bun:test";
import { cleanTitle, createTmuxProbe, parseProbe, probeCmd, tmuxLabel, isValidTmuxName, killSessionCmd, labelSetCmd, singleQuote } from "../src/tmux";

const T = "\t";

test("probeCmd: name + label + agent + title + client count, tab as separator", () => {
  expect(probeCmd()).toBe(
    `tmux list-sessions -F '#{session_name}${T}#{@devd_label}${T}#{@devd_agent}${T}#{pane_title}${T}#{session_attached}' 2>/dev/null`);
});

test("parseProbe: main first, skips empty lines, missing label and agent → null", () => {
  const rows = parseProbe(`main-2${T}${T}codex${T}✳ Fix login${T}0\nmain${T}SHOP-58${T}${T}✳ Something${T}1\n\n`);
  expect(rows.map((r) => r.name)).toEqual(["main", "main-2"]);
  expect(rows[0]).toEqual({ name: "main", label: "SHOP-58", agent: null, title: "✳ Something", attached: 1 });
  expect(rows[1].label).toBeNull();
  expect(rows[1].agent).toBe("codex");
  expect(rows[1].attached).toBe(0);
  expect(parseProbe("")).toEqual([]);
});

test("parseProbe: a tab inside the title does not break the last column", () => {
  const rows = parseProbe(`main${T}${T}claude${T}a${T}b${T}2`);
  expect(rows[0].title).toBe(`a${T}b`);
  expect(rows[0].agent).toBe("claude");
  expect(rows[0].attached).toBe(2);
});

test("parseProbe: nonsense agent value → null, a short line is skipped", () => {
  expect(parseProbe(`main${T}${T}gpt${T}t${T}1`)[0].agent).toBeNull();
  expect(parseProbe(`main${T}${T}t${T}1`)).toEqual([]);   // old four-column format
});

test("cleanTitle: strips state glyphs, drops uninformative titles", () => {
  expect(cleanTitle("✳ Run live verification first")).toBe("Run live verification first");
  expect(cleanTitle("⠐ Add a statistics tab")).toBe("Add a statistics tab");
  expect(cleanTitle("✳ Claude Code")).toBeNull();  // Claude's idle title — says nothing
  expect(cleanTitle("782190e3a4b6")).toBeNull();   // tmux default = hostname (container id)
  expect(cleanTitle("zsh")).toBeNull();
  expect(cleanTitle("   ")).toBeNull();
  expect(cleanTitle(null)).toBeNull();
});

test("tmuxLabel: a manual label beats the Claude title, truncated to 45 chars", () => {
  const s = { name: "main", label: "SHOP-58", agent: null, title: "✳ Fix login", attached: 0 };
  expect(tmuxLabel(s)).toBe("SHOP-58");
  expect(tmuxLabel({ ...s, label: null })).toBe("Fix login");
  expect(tmuxLabel({ ...s, label: null, title: "✳ Claude Code" })).toBeNull();
  expect(tmuxLabel({ ...s, label: null, title: null })).toBeNull();
  const long = tmuxLabel({ ...s, label: "x".repeat(80) })!;
  expect(long).toHaveLength(45);
  expect(long.endsWith("…")).toBe(true);
});

test("createTmuxProbe: parallel across containers, cached within TTL, error → empty list", async () => {
  const calls: string[] = [];
  const probe = createTmuxProbe({
    ttlMs: 1000,
    exec: async (container) => {
      calls.push(container);
      if (container === "dead") throw new Error("docker: no such container");
      return `main\t\t\t✳ Fix login\t0\n`;
    },
  });
  const first = await probe(["a", "dead"], 1_000);
  expect(first.a[0].name).toBe("main");
  expect(first.dead).toEqual([]);          // one dead container must not break the response
  expect(calls).toEqual(["a", "dead"]);

  await probe(["a"], 1_500);                 // within TTL → from cache, no new call
  expect(calls).toEqual(["a", "dead"]);

  await probe(["a", "dead"], 1_800);         // the dead one also within TTL → empty list from cache, no new call
  expect(calls).toEqual(["a", "dead"]);

  await probe(["a"], 2_500);                 // after TTL → again
  expect(calls).toEqual(["a", "dead", "a"]);
});

test("createTmuxProbe: fan-out is parallel — a slow container does not block the others from starting", async () => {
  const started: string[] = [];
  let releaseSlow!: () => void;
  const slow = new Promise<string>((res) => { releaseSlow = () => res("main\t\t\t✳ x\t0\n"); });
  const probe = createTmuxProbe({
    ttlMs: 1000,
    exec: async (container) => {
      started.push(container);
      return container === "pomaly" ? slow : "main\t\t\t✳ y\t0\n";
    },
  });
  const p = probe(["pomaly", "rychly"], 1_000);
  // both execs must start before the slow one resolves → parallel dispatch
  await Promise.resolve(); // let microtasks run
  expect(started).toContain("pomaly");
  expect(started).toContain("rychly");
  releaseSlow();
  const out = await p;
  expect(out.rychly[0].name).toBe("main");
  expect(out.pomaly[0].name).toBe("main");
});

test("isValidTmuxName: only main / main-N", () => {
  expect(isValidTmuxName("main")).toBe(true);
  expect(isValidTmuxName("main-2")).toBe(true);
  expect(isValidTmuxName("main-13")).toBe(true);
  expect(isValidTmuxName("web-x")).toBe(false);
  expect(isValidTmuxName("main; rm -rf /")).toBe(false);
  expect(isValidTmuxName("main-")).toBe(false);
  expect(isValidTmuxName("")).toBe(false);
});

test("killSessionCmd", () => {
  expect(killSessionCmd("main-2")).toBe("tmux kill-session -t main-2 2>/dev/null");
});

test("labelSetCmd + singleQuote (moved to tmux.ts)", () => {
  expect(labelSetCmd("main-2", "SHOP-58")).toBe("tmux set -t main-2 @devd_label 'SHOP-58' 2>/dev/null");
  expect(labelSetCmd("main", null)).toBe("tmux set -u -t main @devd_label 2>/dev/null");
  expect(labelSetCmd("main", "a'b")).toContain(`'a'\\''b'`);
  expect(singleQuote("a'b")).toBe("'a'\\''b'");
});
