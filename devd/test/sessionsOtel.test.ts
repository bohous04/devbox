import { expect, test } from "bun:test";
import { otelResourceAttributes } from "../src/sessions";

test("otelResourceAttributes: carries session id, project, repo and host", () => {
  const s = otelResourceAttributes("dev-alfa-web", "alfa", "web");
  expect(s).toBe("devbox.session.id=dev-alfa-web,project=alfa,repo=web,devbox.host=devbox");
});

test("otelResourceAttributes: host is always devbox, even for an odd project", () => {
  // a safeguard that host is not accidentally derived from something variable
  expect(otelResourceAttributes("dev-x-y", "", "")).toContain("devbox.host=devbox");
});

// Regression for the reason `repo` is in the attributes at all: metrics of an ended session
// must still be attributable after its row disappears from the `sessions` table. If
// `repo` were lost from the attributes, all ended sessions would fall into a single "—".
test("otelResourceAttributes: repo stays in the attributes next to host", () => {
  expect(otelResourceAttributes("dev-alfa-web", "alfa", "web")).toContain("repo=web");
});
