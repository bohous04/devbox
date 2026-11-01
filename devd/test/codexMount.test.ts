import { expect, test } from "bun:test";

test("index.ts mountuje codex-home volume vedle claude-home", async () => {
  const src = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();
  expect(src).toContain('"claude-home:/home/dev/.claude"');
  expect(src).toContain('"codex-home:/home/dev/.codex"');
});

test("index.ts mountuje i grok-home", async () => {
  const src = await Bun.file(new URL("../src/index.ts", import.meta.url).pathname).text();
  expect(src).toContain('"grok-home:/home/dev/.grok"');
});
