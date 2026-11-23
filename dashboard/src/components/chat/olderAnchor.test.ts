import { expect, test } from "bun:test";
import { anchorRow } from "./olderAnchor";

const row = (rowKey: string) => ({ dataset: { rowKey } as DOMStringMap });

test("anchorRow finds the row that was first in view, else the fold its run became after the load", () => {
  const a = { key: "item:61:r2:i61:tool", run: "r2", top: 40 };
  const rows = [row("item:1:r1:i1:user"), row("item:61:r2:i61:tool")];
  expect(anchorRow(rows, a)).toBe(rows[1]!);
  const folded = [row("item:60:r2:i60:user"), row("work:r2")];
  expect(anchorRow(folded, a)).toBe(folded[1]!);
  expect(anchorRow(folded, { ...a, run: null })).toBeNull();
});
