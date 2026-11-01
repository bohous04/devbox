import { expect, test } from "bun:test";
import { runInVolume } from "../src/agentAuth";

// Exact shape (not just a slice) — locks in the choice WITHOUT `--entrypoint sh`, see the comment
// at runInVolume in agentAuth.ts: devbox-entrypoint execs "$@" when it gets
// arguments (image/entrypoint.sh:5-7), so `docker run ... devbox:latest sh -c
// script` works the same as readVolumeFile/proxyCredsPresent without an entrypoint.
test("builds docker run with sh -c and returns stdout", async () => {
  let seen: string[] = [];
  const d = { run: async (cmd: string[]) => { seen = cmd; return { code: 0, stdout: "OUT", stderr: "" }; } };
  const r = await runInVolume(d, "grok-home", "/home/dev/.grok", "echo OUT");
  expect(r).toEqual({ out: "OUT", dockerError: null });
  expect(seen).toEqual(["run", "--rm", "-v", "grok-home:/home/dev/.grok", "devbox:latest", "sh", "-c", "echo OUT"]);
});

test("respects a custom image (d.image)", async () => {
  let seen: string[] = [];
  const d = { run: async (cmd: string[]) => { seen = cmd; return { code: 0, stdout: "", stderr: "" }; }, image: "custom:tag" };
  await runInVolume(d, "v", "/m", "true");
  expect(seen[4]).toBe("custom:tag");
});

test("non-zero exit → dockerError with truncated stderr", async () => {
  const d = { run: async () => ({ code: 125, stdout: "", stderr: "x".repeat(500) }) };
  const r = await runInVolume(d, "v", "/m", "true");
  expect(r.out).toBeNull();
  expect(r.dockerError!.length).toBeLessThanOrEqual(300);
});

test("empty stderr on error → generic message with the exit code", async () => {
  const d = { run: async () => ({ code: 1, stdout: "", stderr: "" }) };
  const r = await runInVolume(d, "v", "/m", "true");
  expect(r.dockerError).toBe("docker run failed (exit 1)");
});
