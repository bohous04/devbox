import { expect, test } from "bun:test";
import { terminalWsUrl, encodeInput, encodeResize, encodeUnlock, encodeScroll, encodeBottom, wheelSteps, KEY_SEQ, KEY_BAR } from "./terminalProto";

test("wss for https, ws for http", () => {
  expect(terminalWsUrl("dev-shop-cms", undefined, { protocol: "https:", host: "dev.example.com" })).toBe("wss://dev.example.com/api/sessions/dev-shop-cms/terminal");
  expect(terminalWsUrl("a", undefined, { protocol: "http:", host: "vps:4300" })).toBe("ws://vps:4300/api/sessions/a/terminal");
});

test("terminalWsUrl: ?tmux= when a session is given", () => {
  const loc = { protocol: "https:", host: "dev.example.com" };
  expect(terminalWsUrl("dev-x", "main-2", loc)).toBe("wss://dev.example.com/api/sessions/dev-x/terminal?tmux=main-2");
  expect(terminalWsUrl("dev-x", undefined, loc)).toBe("wss://dev.example.com/api/sessions/dev-x/terminal");
});

test("encoders match the server-side ClientMsg protocol", () => {
  expect(JSON.parse(encodeInput("y\r"))).toEqual({ t: "i", d: "y\r" });
  expect(JSON.parse(encodeResize(80, 24))).toEqual({ t: "r", cols: 80, rows: 24 });
  expect(JSON.parse(encodeUnlock())).toEqual({ t: "unlock" });
  expect(encodeScroll("up", 3)).toBe('{"t":"s","d":"up","n":3}');
  expect(encodeScroll("down", 99)).toBe('{"t":"s","d":"down","n":20}'); // the server clamps anyway
  expect(encodeBottom()).toBe('{"t":"b"}');
});

test("wheelSteps: deltaY → line steps, direction, the remainder carries over", () => {
  expect(wheelSteps(-50, 16)).toEqual({ dir: "up", n: 3, rest: -2 });   // wheel up = older history
  expect(wheelSteps(40, 16)).toEqual({ dir: "down", n: 2, rest: 8 });
  expect(wheelSteps(10, 16)).toEqual({ dir: null, n: 0, rest: 10 });    // trackpad: small deltas accumulate
  expect(wheelSteps(16 * 50, 16)).toEqual({ dir: "down", n: 20, rest: 0 }); // clamp, the excess is dropped
  expect(wheelSteps(5, 0)).toEqual({ dir: null, n: 0, rest: 0 });       // nonsensical line height
  expect(wheelSteps(4, 16, 10)).toEqual({ dir: null, n: 0, rest: 14 });  // same direction: the remainder accumulates
  expect(wheelSteps(-4, 16, 14)).toEqual({ dir: null, n: 0, rest: -4 }); // reversing drops the remainder (no step in the wrong direction)
  expect(wheelSteps(-10, 16, -10)).toEqual({ dir: "up", n: 1, rest: -4 });
});

test("key bar: Esc and arrows have the correct sequences and are in the bar", () => {
  expect(KEY_SEQ.Esc).toBe("\x1b");
  expect(KEY_SEQ.Up).toBe("\x1b[A");
  expect(KEY_SEQ["Ctrl-C"]).toBe("\x03");
  for (const k of KEY_BAR) expect(KEY_SEQ[k]).toBeDefined();
});
