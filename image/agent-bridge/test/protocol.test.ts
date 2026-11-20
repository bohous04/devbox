import { describe, expect, test } from "bun:test";
import { encodeFrame, parseClientFrame, ProtocolError, type BridgeCommand } from "../src/protocol";

describe("parseClientFrame", () => {
  test("accepts an ack (1.5.0, S6-R21)", () => {
    expect(parseClientFrame('{"t":"ack","seq":7}')).toEqual({ t: "ack", seq: 7 });
  });

  test("accepts hello", () => {
    expect(parseClientFrame('{"t":"hello","afterSeq":0}')).toEqual({ t: "hello", afterSeq: 0 });
  });

  test("accepts a hello with a nonce (1.6.0 session binding)", () => {
    const nonce = "ab".repeat(16);
    expect(parseClientFrame(JSON.stringify({ t: "hello", afterSeq: 2, nonce }))).toEqual({ t: "hello", afterSeq: 2, nonce });
  });

  test("accepts a startTurn command", () => {
    const line = '{"t":"cmd","id":"c1","cmd":{"kind":"startTurn","text":"hi"}}';
    expect(parseClientFrame(line)).toEqual({ t: "cmd", id: "c1", cmd: { kind: "startTurn", text: "hi" } });
  });

  test("startTurn may name its origin: user, or critic for devd's critic follow-up", () => {
    for (const origin of ["user", "critic"] as const) {
      const line = JSON.stringify({ t: "cmd", id: "c1", cmd: { kind: "startTurn", text: "fix it", origin } });
      expect(parseClientFrame(line)).toEqual({ t: "cmd", id: "c1", cmd: { kind: "startTurn", text: "fix it", origin } });
    }
  });

  test("accepts the other command kinds", () => {
    const cmds: BridgeCommand[] = [
      { kind: "interrupt" },
      { kind: "answer", requestId: "q1", answer: "yes" },
      { kind: "restartAgent" },
      { kind: "stop" },
      { kind: "endWait" },
      { kind: "declareWait", reason: "ci", waitKind: "ci", timeoutMinutes: 5 },
      { kind: "setModel", model: "claude-opus-4-5" },
      {
        kind: "switchTarget",
        target: { harness: "codex", account: "acct-1", model: null, env: { A: "1" } },
        resume: "thread-1",
        handoff: { preamble: "earlier", injectItems: [{ type: "message" }] },
      },
      { kind: "switchTarget", target: { harness: "claude", account: null, model: "m", env: {} }, resume: null, handoff: null },
      { kind: "switchTarget", target: { harness: "claude", account: null, model: "m", env: {} }, resume: null, handoff: { preamble: null } },
      { kind: "switchTarget", target: { harness: "vibe", account: null, model: null, env: {} }, resume: "sess-1", handoff: { preamble: "earlier" } },
    ];
    for (const cmd of cmds) {
      expect(parseClientFrame(JSON.stringify({ t: "cmd", id: "c", cmd }))).toEqual({ t: "cmd", id: "c", cmd });
    }
  });

  test("rejects malformed input", () => {
    const bad = [
      "not json",
      '{"t":"nope"}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"explode"}}',
      '{"t":"hello","afterSeq":-1}',
      '{"t":"hello","afterSeq":1.5}',
      '{"t":"hello"}',
      '{"t":"hello","afterSeq":0,"nonce":""}',
      '{"t":"hello","afterSeq":0,"nonce":7}',
      `{"t":"hello","afterSeq":0,"nonce":"${"a".repeat(257)}"}`,
      '{"t":"ack"}',
      '{"t":"ack","seq":-1}',
      '{"t":"ack","seq":"3"}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"startTurn","text":""}}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"startTurn","text":"x","attachments":[1]}}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"startTurn","text":"x","origin":"agent"}}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"startTurn","text":"x","origin":null}}',
      '{"t":"cmd","id":"","cmd":{"kind":"stop"}}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"answer","requestId":"q1"}}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"declareWait","reason":"x","waitKind":"nope"}}',
      "null",
      '{"t":"cmd","id":"c1","cmd":{"kind":"setModel","model":""}}',
      ...[
        { harness: "gemini", account: null, model: null, env: {} },
        { harness: "claude", account: "", model: null, env: {} },
        { harness: "claude", account: null, model: 5, env: {} },
        { harness: "claude", account: null, model: null, env: { A: 1 } },
        { harness: "claude", account: null, model: null },
      ].map((target) => JSON.stringify({ t: "cmd", id: "c1", cmd: { kind: "switchTarget", target, resume: null, handoff: null } })),
      ...[
        { resume: "", handoff: null },
        { handoff: null },
        { resume: null },
        { resume: null, handoff: { preamble: 1 } },
        { resume: null, handoff: { preamble: null, injectItems: "x" } },
      ].map((rest) => JSON.stringify({ t: "cmd", id: "c1", cmd: { kind: "switchTarget", target: { harness: "claude", account: null, model: null, env: {} }, ...rest } })),
    ];
    for (const line of bad) expect(() => parseClientFrame(line)).toThrow(ProtocolError);
  });
});

describe("encodeFrame", () => {
  test("ends with exactly one newline and round-trips", () => {
    const frame = { t: "ready", lastSeq: 7 } as const;
    const out = encodeFrame(frame);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(JSON.parse(out)).toEqual(frame);
  });
});
