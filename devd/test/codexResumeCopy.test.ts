import { expect, test } from "bun:test";
import { copyCodexConversation } from "../src/codexResumeCopy";

const THREAD = "01a1f354-0000-7000-8000-000000000001";
const A = "0c0c0c0c-0000-4000-8000-00000000000a";
const B = "0c0c0c0c-0000-4000-8000-00000000000b";

function fake(o: { volumes?: string[]; out?: string; code?: number } = {}) {
  const calls: string[][] = [];
  const volumes = o.volumes ?? ["codex-home", `codex-acct-${A}`, `codex-acct-${B}`];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[0] === "volume") return { code: 0, stdout: volumes.join("\n"), stderr: "" };
    return { code: o.code ?? 0, stdout: o.out ?? JSON.stringify({ ok: true, threadId: THREAD, copiedIds: [THREAD] }), stderr: "" };
  };
  return { d: { run, sleep: async () => {}, image: "devbox:test" }, calls, runs: () => calls.filter((c) => c[0] === "run") };
}

test("the conversation is copied in a throwaway container that mounts both accounts' homes where sessions do", async () => {
  const f = fake();
  expect(await copyCodexConversation(f.d, A, { accountId: B, label: "Work" }, THREAD)).toEqual({ account: B });
  const [run] = f.runs();
  expect(run!.slice(0, run!.indexOf("python3"))).toEqual(["run", "--rm", "--network", "none",
    "-v", `codex-acct-${A}:/home/dev/.codex-accounts/${A}`, "-v", `codex-acct-${B}:/home/dev/.codex-accounts/${B}`, "devbox:test"]);
  expect(run!.slice(run!.indexOf("-c") + 2)).toEqual(["copy", "--source-home", `/home/dev/.codex-accounts/${A}`,
    "--target-home", `/home/dev/.codex-accounts/${B}`, "--thread-id", THREAD]);
  expect(run![run!.indexOf("-c") + 1]).toContain("def copy_conversation(");
  // The default account is the image's own CODEX_HOME; the account it ended on only checks the conversation is there.
  const same = fake();
  expect(await copyCodexConversation(same.d, "default", { accountId: "default", label: "Main" }, THREAD)).toEqual({ account: "default" });
  const [one] = same.runs();
  expect(one!.filter((a) => a.includes(":/home/dev/"))).toEqual(["codex-home:/home/dev/.codex"]);
  expect(one!.slice(one!.indexOf("--source-home"))).toEqual(["--source-home", "/home/dev/.codex", "--target-home", "/home/dev/.codex", "--thread-id", THREAD]);
});

test("whatever stops the copy is the reason continue hands off with", async () => {
  const refused = fake({ out: JSON.stringify({ ok: false, error: "The selected account already has a different copy of this conversation; both were left unchanged." }), code: 1 });
  expect(await copyCodexConversation(refused.d, A, { accountId: B, label: "Work" }, THREAD)).toEqual({
    reason: "the Codex conversation could not be copied to the account Work: The selected account already has a different copy of this conversation; both were left unchanged" });
  // A volume that is gone is never created by mounting it.
  const gone = fake({ volumes: ["codex-home", `codex-acct-${B}`] });
  expect(await copyCodexConversation(gone.d, A, { accountId: B, label: "Work" }, THREAD)).toEqual({
    reason: `the Codex account ${A} that held the conversation no longer exists` });
  expect(gone.runs()).toEqual([]);
  const broken = fake({ out: "Traceback ...", code: 1 });
  expect(await copyCodexConversation(broken.d, A, { accountId: B, label: "Work" }, THREAD)).toEqual({
    reason: "the Codex conversation could not be copied to the account Work: the copy gave no result (exit 1)" });
  // Only ids ever reach docker.
  for (const [from, to, thread] of [["../x", B, THREAD], [A, "default/..", THREAD], [A, B, `${THREAD}/..`]] as const) {
    const f = fake();
    expect(await copyCodexConversation(f.d, from, { accountId: to, label: "Work" }, thread)).toEqual({ reason: "the Codex conversation or account id is not valid" });
    expect(f.calls).toEqual([]);
  }
});
