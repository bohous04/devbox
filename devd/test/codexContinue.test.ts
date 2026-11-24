import { expect, test } from "bun:test";
import { sharedRolloutBlock } from "../src/codexContinue";

const THREAD = "01a1f354-0000-7000-8000-000000000001";

function fake(o: { volumes?: string[]; found?: string; code?: number; stderr?: string } = {}) {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[0] === "volume") return { code: 0, stdout: (o.volumes ?? ["codex-home", "codex-v2-shared"]).join("\n"), stderr: "" };
    return { code: o.code ?? 0, stdout: o.found ?? "", stderr: o.stderr ?? "" };
  };
  return { d: { run, sleep: async () => {}, image: "devbox:test" }, calls, runs: () => calls.filter((c) => c[0] === "run") };
}

test("a chat Codex conversation continues only while its rollout is in the shared Codex home (review M2)", async () => {
  const found = fake({ found: `/home/dev/.codex-v2/shared/sessions/2026/11/20/rollout-2026-11-20T10-00-00-${THREAD}.jsonl\n` });
  expect(await sharedRolloutBlock(found.d, THREAD)).toBeNull();
  const [run] = found.runs();
  // Read-only, no network, only the shared volume.
  expect(run!.slice(0, 7)).toEqual(["run", "--rm", "--network", "none", "-v", "codex-v2-shared:/home/dev/.codex-v2:ro", "devbox:test"]);
  expect(run!.at(-1)).toContain(`-name 'rollout-*-${THREAD}.jsonl'`);
  expect(await sharedRolloutBlock(fake({ found: "" }).d, THREAD)).toBe(`the Codex conversation ${THREAD} is no longer in the shared Codex home`);
  // No shared volume: never created by looking.
  const none = fake({ volumes: ["codex-home"] });
  expect(await sharedRolloutBlock(none.d, THREAD)).toBe(`the Codex conversation ${THREAD} is no longer in the shared Codex home`);
  expect(none.runs()).toEqual([]);
  expect(await sharedRolloutBlock(fake({ code: 125, stderr: "docker: Error response from daemon" }).d, THREAD))
    .toBe("devd could not check the shared Codex home for the conversation: docker: Error response from daemon");
  const bad = fake();
  expect(await sharedRolloutBlock(bad.d, `${THREAD}' -o -name '*`)).toBe("the Codex conversation id is not valid");
  expect(bad.calls).toEqual([]);
});
