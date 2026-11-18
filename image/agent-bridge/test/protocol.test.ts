import { describe, expect, test } from "bun:test";
import { encodeFrame, parseClientFrame, ProtocolError, type BridgeCommand } from "../src/protocol";

describe("parseClientFrame", () => {
  test("accepts hello", () => {
    expect(parseClientFrame('{"t":"hello","afterSeq":0}')).toEqual({ t: "hello", afterSeq: 0 });
  });

  test("accepts a startTurn command", () => {
    const line = '{"t":"cmd","id":"c1","cmd":{"kind":"startTurn","text":"hi"}}';
    expect(parseClientFrame(line)).toEqual({ t: "cmd", id: "c1", cmd: { kind: "startTurn", text: "hi" } });
  });

  test("accepts the other command kinds", () => {
    const cmds: BridgeCommand[] = [
      { kind: "interrupt" },
      { kind: "answer", requestId: "q1", answer: "yes" },
      { kind: "restartAgent" },
      { kind: "stop" },
      { kind: "endWait" },
      { kind: "declareWait", reason: "ci", waitKind: "ci", timeoutMinutes: 5 },
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
      '{"t":"cmd","id":"c1","cmd":{"kind":"startTurn","text":""}}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"startTurn","text":"x","attachments":[1]}}',
      '{"t":"cmd","id":"","cmd":{"kind":"stop"}}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"answer","requestId":"q1"}}',
      '{"t":"cmd","id":"c1","cmd":{"kind":"declareWait","reason":"x","waitKind":"nope"}}',
      "null",
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
