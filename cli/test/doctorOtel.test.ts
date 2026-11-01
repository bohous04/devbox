import { expect, test } from "bun:test";
import { checkMacOtel } from "../src/doctor";

const URL = "http://100.64.0.10:4300";
const good = { env: {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_ENDPOINT: URL,
  OTEL_RESOURCE_ATTRIBUTES: "devbox.host=mac",
} };

test("checkMacOtel: a complete setup passes", () => {
  expect(checkMacOtel(good, URL).ok).toBe(true);
});

test("checkMacOtel: missing settings do not crash the check", () => {
  expect(checkMacOtel(null, URL).ok).toBe(false);
  expect(checkMacOtel(undefined, URL).ok).toBe(false);
});

test("checkMacOtel: an endpoint pointing anywhere but devd is an error", () => {
  const bad = { env: { ...good.env, OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9999" } };
  const c = checkMacOtel(bad, URL);
  expect(c.ok).toBe(false);
  expect(c.hint).toContain(URL);
});

test("checkMacOtel: a missing devbox.host is an error", () => {
  const bad = { env: { ...good.env, OTEL_RESOURCE_ATTRIBUTES: "project=x" } };
  expect(checkMacOtel(bad, URL).ok).toBe(false);
});
