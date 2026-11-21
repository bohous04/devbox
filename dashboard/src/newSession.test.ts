import { expect, test } from "bun:test";
import {
  AGENT_IDS, AGENT_PROFILES, SOLO, chatRuntimeBlock, continueTakesPrompt, defaultAgentFor, folderChoices, instaboxAgentBlock, isProxyAgent, profileFor, projectChoices, repoChoices, runningInOtherRuntime, continueDetail, runtimeAfterDefault, runtimeChoice, sendPlan, sessionsFor, soleProject, tmuxRuntimeBlock,
} from "./newSession";
import type { TreeProject } from "./api";
// Only this test may import devd — it ensures the manual mirror in newSession.ts
// (AGENT_PROFILES) does not drift from the single source of truth. Tests do not go into the vite
// bundle, so the production separation of the dashboard from devd stays intact (Ruling 3
// v task-6 dispatchi).
import { AGENTS as DEVD_AGENTS, AGENT_IDS as DEVD_AGENT_IDS, chatRuntimeBlock as devdChatRuntimeBlock, runtimeForOmitted as devdRuntimeForOmitted, tmuxRuntimeBlock as devdTmuxRuntimeBlock, usesProxy } from "../../devd/src/agents";

const tree: TreeProject[] = [
  { folder: "acme", project: "shop", repos: [
    { name: "web", cloneUrl: "https://x/web.git", provider: "github", cloned: false },
    { name: "cms", cloneUrl: "https://x/cms.git", provider: "github", cloned: true },
  ] },
  { folder: "acme", project: "infra", repos: [] },
  { folder: "games", project: "games", repos: [{ name: "core", cloneUrl: "https://x/c.git", provider: "gitea", cloned: false }] },
];

test("folderChoices unique and sorted", () => {
  expect(folderChoices(tree)).toEqual(["acme", "games"]);
});

test("projectChoices filters by folder", () => {
  expect(projectChoices(tree, "acme")).toEqual(["infra", "shop"]);
  expect(projectChoices(tree, "games")).toEqual(["games"]);
});

test("repoChoices sorts, marks cloned repos and ends with claudeSolo", () => {
  const r = repoChoices(tree, "acme", "shop");
  expect(r.map((x) => x.value)).toEqual(["cms", "web", SOLO]);
  expect(r[0].label).toBe("cms (cloned)");
  expect(r[1].label).toBe("web");
  expect(r[1].cloneUrl).toBe("https://x/web.git");
  expect(r.at(-1)!.value).toBe(SOLO);
});

// I3 from review: "New session" on a repo in the OLD layout (shared working directory) gives
// its own container, but the same files and the same branch — two agents on one git
// index. The `bare` flag is carried from the tree (devd computes it via isBareLayout), so the
// UI can say so instead of silently doing it.
test("repoChoices carries the repo layout, so the UI does not stay silent about a shared directory", () => {
  const t: TreeProject[] = [{ folder: "acme", project: "shop", repos: [
    { name: "novy", cloneUrl: "https://x/n.git", provider: "github", cloned: true, bare: true },
    { name: "stary", cloneUrl: "https://x/s.git", provider: "github", cloned: true },
  ] }];
  const r = repoChoices(t, "acme", "shop");
  expect(r.find((x) => x.value === "novy")!.bare).toBe(true);
  expect(r.find((x) => x.value === "stary")!.bare).toBeFalsy();
});

test("repoChoices on an empty project still offers claudeSolo", () => {
  expect(repoChoices(tree, "acme", "infra").map((x) => x.value)).toEqual([SOLO]);
});

test("soleProject returns the single project (flat folder), otherwise null", () => {
  expect(soleProject(tree, "games")).toBe("games"); // flat folder = 1 projekt → auto
  expect(soleProject(tree, "acme")).toBeNull();  // several projects → the user chooses
  expect(soleProject(tree, "neexistuje")).toBeNull();
});

const agentTree = [{
  folder: "acme", project: "shop", soloAgent: "codex" as const,
  repos: [
    { name: "app", cloneUrl: "u", provider: "github", cloned: true, agent: "codex" as const },
    { name: "web", cloneUrl: "u", provider: "github", cloned: true, agent: null },
  ],
}];

test("defaultAgentFor: remembered choice, claudeSolo from the project, otherwise claude", () => {
  expect(defaultAgentFor(agentTree, "acme", "shop", "app")).toBe("codex");
  expect(defaultAgentFor(agentTree, "acme", "shop", "web")).toBe("claude");
  expect(defaultAgentFor(agentTree, "acme", "shop", SOLO)).toBe("codex");
  expect(defaultAgentFor(agentTree, "acme", "shop", "neznamy")).toBe("claude");
  expect(defaultAgentFor([], "", "", "")).toBe("claude");
});

test("mirror in newSession.ts (AGENT_PROFILES) matches devd/src/agents.ts", () => {
  expect(AGENT_IDS).toEqual(DEVD_AGENT_IDS);
  for (const id of DEVD_AGENT_IDS) {
    expect(AGENT_PROFILES[id].label).toBe(DEVD_AGENTS[id].label);
    expect(AGENT_PROFILES[id].short).toBe(DEVD_AGENTS[id].short);
    expect(AGENT_PROFILES[id].yolo).toBe(DEVD_AGENTS[id].yolo);
    expect(AGENT_PROFILES[id].proxy).toBe(usesProxy(id));
    expect(AGENT_PROFILES[id].runtime).toBe(DEVD_AGENTS[id].runtime);
    expect(AGENT_PROFILES[id].acp).toBe(DEVD_AGENTS[id].acp);
    expect(AGENT_PROFILES[id].acpLive).toBe(DEVD_AGENTS[id].acpLive);
    expect(AGENT_PROFILES[id].chatOnly).toBe(DEVD_AGENTS[id].chatOnly);
  }
});

test("chatRuntimeBlock, tmuxRuntimeBlock and instaboxAgentBlock mirror devd", () => {
  for (const id of DEVD_AGENT_IDS) {
    for (const host of ["vps", "instabox"] as const) expect(chatRuntimeBlock(id, host)).toBe(devdChatRuntimeBlock(id, host));
    expect(tmuxRuntimeBlock(id)).toBe(devdTmuxRuntimeBlock(id));
  }
  expect(instaboxAgentBlock("vibe")).toBe("Mistral Vibe runs only in chat sessions");
  expect(chatRuntimeBlock("claude", "vps")).toBeNull();
  expect(chatRuntimeBlock("codex", "vps")).toBeNull();
  expect(chatRuntimeBlock("claude-gemini", "vps")).toBeNull();
  expect(chatRuntimeBlock("grok", "vps")).toBeNull();
  expect(chatRuntimeBlock("antigravity", "vps")).not.toBeNull();
  expect(chatRuntimeBlock("vibe", "vps")).toBeNull();
  expect(tmuxRuntimeBlock("vibe")).toBe("Mistral Vibe runs only in chat sessions");
});

test("isProxyAgent: InstaBox cannot reach profiles running through CLIProxyAPI/OpenRouter", () => {
  expect(isProxyAgent("claude")).toBe(false);
  expect(isProxyAgent("codex")).toBe(false);
  expect(isProxyAgent("claude-gemini")).toBe(true);
  expect(isProxyAgent("claude-openrouter")).toBe(true);
});

// The dashboard gets `agent` from the API as a plain string. `AGENT_PROFILES[s.agent].short`
// throws on an unknown value and takes down the render of the WHOLE sessions page — a worse
// failure than in devd, where only one request fails. Mirrors specFor from devd/src/agents.ts.
test("profileFor: an unknown value, null and undefined fall back to claude", () => {
  expect(profileFor("gpt")).toBe(AGENT_PROFILES.claude);
  expect(profileFor(null)).toBe(AGENT_PROFILES.claude);
  expect(profileFor(undefined)).toBe(AGENT_PROFILES.claude);
  expect(profileFor("constructor")).toBe(AGENT_PROFILES.claude);
  for (const id of AGENT_IDS) expect(profileFor(id)).toBe(AGENT_PROFILES[id]);
});

// The dashboard must know the repo already has a session — otherwise "Open" would silently attach
// to the existing one and the user would not understand why no second session was created.
test("knows how many sessions the repo already has", () => {
  const sessions = [
    { id: "dev-portal-web", project: "portal", repo: "web" },
    { id: "dev-portal-web-2", project: "portal", repo: "web" },
    { id: "dev-portal-api", project: "portal", repo: "api" },
  ] as never[];
  expect(sessionsFor(sessions, "portal", "web")).toHaveLength(2);
  expect(sessionsFor(sessions, "portal", "api")).toHaveLength(1);
  expect(sessionsFor(sessions, "portal", "nic")).toHaveLength(0);
});

test("runtimeChoice: keeps the wanted runtime unless it is blocked and the other is not, then says so", () => {
  expect(runtimeChoice("chat", null, null)).toEqual({ runtime: "chat", notice: null });
  expect(runtimeChoice("chat", "Antigravity is not available in chat sessions yet", null))
    .toEqual({ runtime: "tmux", notice: "Antigravity is not available in chat sessions yet, so this session runs in tmux" });
  expect(runtimeChoice("tmux", null, "Mistral Vibe runs only in chat sessions"))
    .toEqual({ runtime: "chat", notice: "Mistral Vibe runs only in chat sessions, so this session runs in chat" });
  // Both blocked: nothing to switch to, the wanted runtime stays and the server refuses it.
  expect(runtimeChoice("chat", "a", "b")).toEqual({ runtime: "chat", notice: null });
});

test("runtimeChoice on the VPS mirrors devd runtimeForOmitted for every agent and default", () => {
  for (const id of AGENT_IDS) {
    for (const def of ["tmux", "chat"] as const) {
      const devd = devdRuntimeForOmitted(def, id, "session");
      expect(runtimeChoice(def, chatRuntimeBlock(id, "vps"), tmuxRuntimeBlock(id))).toEqual({ runtime: devd.runtime, notice: devd.notice ?? null });
    }
  }
});

test("runtimeAfterDefault: the configured default fills an unpicked runtime, never overwrites a pick (S6-R18)", () => {
  expect(runtimeAfterDefault(null, "chat")).toBe("chat");
  expect(runtimeAfterDefault("tmux", "chat")).toBe("tmux");
  expect(runtimeAfterDefault("chat", "tmux")).toBe("chat");
});

test("runningInOtherRuntime: the repo's running sessions the form's runtime would not join (S6-R18)", () => {
  const s = (id: string, runtime: "tmux" | "chat" | undefined, status: "running" | "stopped") => ({ id, runtime, status });
  const repo = [s("dev-x-r", "tmux", "running"), s("dev-x-r-2", "chat", "stopped"), s("dev-x-r-3", undefined, "running"), s("dev-x-r-4", "chat", "running")];
  expect(runningInOtherRuntime(repo, "chat").map((x) => x.id)).toEqual(["dev-x-r", "dev-x-r-3"]);   // no runtime = tmux
  expect(runningInOtherRuntime(repo, "tmux").map((x) => x.id)).toEqual(["dev-x-r-4"]);
});

test("sendPlan: typed text with an existing session is asked about, never sent to one side by itself", () => {
  const s = { id: "dev-acme-web" };
  expect(sendPlan("fix it now", s, false)).toBe("ask");
  expect(sendPlan("", s, false)).toBe("open");
  expect(sendPlan("fix it now", null, false)).toBe("new");
  expect(sendPlan("", null, false)).toBe("new");
  expect(sendPlan("", s, true)).toBe("instabox");
});

test("continueTakesPrompt: not on InstaBox, not into a running terminal (its agent already read the prompt file)", () => {
  expect(continueTakesPrompt({ status: "running" }, "chat")).toBe(true);
  expect(continueTakesPrompt({ status: "stopped" }, "tmux")).toBe(true);
  expect(continueTakesPrompt({ status: "running" }, "tmux")).toBe(false);
  expect(continueTakesPrompt({ status: "stopped", host: "instabox" }, "tmux")).toBe(false);
});

test("continuing an existing session says what happens to the message, and to an effort chosen for a new one", () => {
  const vps = { host: "vps" as const }, ibx = { host: "instabox" as const };
  expect(continueDetail(vps, true, false)).toBe("Your message goes to that session.");
  expect(continueDetail(vps, false, false)).toBe("Opens it without your message: its agent is already running, so the message would not reach it.");
  expect(continueDetail(ibx, false, false)).toBe("Opens it without your message: an InstaBox session takes no message.");
  expect(continueDetail(vps, true, true)).toBe("Your message goes to that session. Effort applies to a new session only — set it in the thread.");
  expect(continueDetail(vps, false, true)).toBe("Opens it without your message: its agent is already running, so the message would not reach it. Effort applies to a new session only — set it in the thread.");
});
