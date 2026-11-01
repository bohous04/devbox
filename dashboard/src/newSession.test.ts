import { expect, test } from "bun:test";
import {
  AGENT_IDS, AGENT_PROFILES, SOLO, defaultAgentFor, folderChoices, isProxyAgent, profileFor, projectChoices, repoChoices, sessionsFor, soleProject,
} from "./newSession";
import type { TreeProject } from "./api";
// Only this test may import devd — it ensures the manual mirror in newSession.ts
// (AGENT_PROFILES) does not drift from the single source of truth. Tests do not go into the vite
// bundle, so the production separation of the dashboard from devd stays intact (Ruling 3
// v task-6 dispatchi).
import { AGENTS as DEVD_AGENTS, AGENT_IDS as DEVD_AGENT_IDS, usesProxy } from "../../devd/src/agents";

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
  }
});

test("isProxyAgent: InstaBox cannot reach profiles running through CLIProxyAPI/OpenRouter", () => {
  expect(isProxyAgent("claude")).toBe(false);
  expect(isProxyAgent("codex")).toBe(false);
  expect(isProxyAgent("claude-gpt")).toBe(true);
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
