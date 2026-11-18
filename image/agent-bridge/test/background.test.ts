import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { BackgroundTracker } from "../src/background.ts";

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

const toolUse = (id: string, name: string, input: unknown = {}) =>
  msg({ type: "assistant", parent_tool_use_id: null, message: { id: "msg-1", content: [{ type: "tool_use", id, name, input }] } });

const toolResult = (id: string, toolUseResult: unknown, isError = false) =>
  msg({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: isError }] },
    tool_use_result: toolUseResult,
  });

const taskStarted = (taskId: string, taskType: string, extra: Record<string, unknown> = {}) =>
  msg({ type: "system", subtype: "task_started", task_id: taskId, task_type: taskType, description: `task ${taskId}`, ...extra });

const taskNotification = (taskId: string, status: "completed" | "failed" | "stopped") =>
  msg({ type: "system", subtype: "task_notification", task_id: taskId, status, output_file: "", summary: "" });

describe("BackgroundTracker", () => {
  test("ScheduleWakeup result adds a holding wakeup until its time", () => {
    const t = new BackgroundTracker();
    expect(t.apply(toolUse("toolu_w", "ScheduleWakeup", { delaySeconds: 600, reason: "check CI" }))).toBeNull();
    expect(t.apply(toolResult("toolu_w", { scheduledFor: 1_700_000_600_000, clampedDelaySeconds: 600, wasClamped: false }))).toEqual([
      { id: "wakeup", kind: "wakeup", label: "check CI", holding: true, until: 1_700_000_600_000 },
    ]);
  });

  test("a stopped or failed ScheduleWakeup clears the wakeup", () => {
    const t = new BackgroundTracker();
    t.apply(toolUse("toolu_w", "ScheduleWakeup", { delaySeconds: 600, reason: "r" }));
    t.apply(toolResult("toolu_w", { scheduledFor: 1_700_000_600_000 }));
    t.apply(toolUse("toolu_s", "ScheduleWakeup", { stop: true }));
    expect(t.apply(toolResult("toolu_s", { scheduledFor: 0, stopped: true }))).toEqual([]);

    t.apply(toolUse("toolu_w2", "ScheduleWakeup", { delaySeconds: 60, reason: "r" }));
    t.apply(toolResult("toolu_w2", { scheduledFor: 1_700_000_060_000 }));
    t.apply(toolUse("toolu_e", "ScheduleWakeup", { delaySeconds: 60, reason: "r" }));
    expect(t.apply(toolResult("toolu_e", "Error: boom", true))).toEqual([]);
  });

  test("two ScheduleWakeup results in one message keep the last wakeup", () => {
    const t = new BackgroundTracker();
    t.apply(toolUse("toolu_a", "ScheduleWakeup", { reason: "first" }));
    t.apply(toolUse("toolu_b", "ScheduleWakeup", { reason: "second" }));
    const both = msg({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "ok" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "ok" },
        ],
      },
      tool_use_result: { scheduledFor: 2_000 },
    });
    expect(t.apply(both)).toEqual([{ id: "wakeup", kind: "wakeup", label: "second", holding: true, until: 2_000 }]);
  });

  test("task_notification completed removes the subagent", () => {
    const t = new BackgroundTracker();
    expect(t.apply(taskStarted("a1", "local_agent", { is_backgrounded: true }))).toEqual([
      { id: "a1", kind: "subagent", label: "task a1", holding: true },
    ]);
    expect(t.apply(taskNotification("a1", "completed"))).toEqual([]);
    expect(t.apply(taskNotification("a1", "completed"))).toBeNull();
  });

  test("undeclared background command is not holding", () => {
    const t = new BackgroundTracker();
    expect(t.apply(taskStarted("b1", "local_bash", { tool_use_id: "toolu_bash" }))).toEqual([
      { id: "b1", kind: "command", label: "task b1", holding: false },
    ]);
  });

  test("a Monitor-launched shell task is a holding monitor; a workflow holds", () => {
    const t = new BackgroundTracker();
    t.apply(toolUse("toolu_mon", "Monitor", { command: "tail -f log" }));
    expect(t.apply(taskStarted("m1", "local_bash", { tool_use_id: "toolu_mon" }))).toEqual([
      { id: "m1", kind: "monitor", label: "task m1", holding: true },
    ]);
    expect(t.apply(taskStarted("w1", "local_workflow"))?.find((w) => w.id === "w1")).toEqual({
      id: "w1", kind: "workflow", label: "task w1", holding: true,
    });
  });

  test("ambient tasks are not background work", () => {
    const t = new BackgroundTracker();
    expect(t.apply(taskStarted("x1", "local_agent", { ambient: true }))).toBeNull();
  });

  test("background_tasks_changed replaces the task set but keeps wakeup and declared waits", () => {
    const t = new BackgroundTracker();
    t.apply(taskStarted("a1", "local_agent"));
    t.declare({ id: "wait-1", kind: "declared-wait", label: "CI", holding: true, until: 5 });
    t.apply(toolUse("toolu_w", "ScheduleWakeup", { reason: "r" }));
    t.apply(toolResult("toolu_w", { scheduledFor: 9 }));
    const after = t.apply(
      msg({
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "b2", task_type: "local_bash", description: "npm test" },
          { task_id: "amb", task_type: "local_bash", description: "watcher", ambient: true },
        ],
      }),
    );
    expect(after).toEqual([
      { id: "wait-1", kind: "declared-wait", label: "CI", holding: true, until: 5 },
      { id: "wakeup", kind: "wakeup", label: "r", holding: true, until: 9 },
      { id: "b2", kind: "command", label: "npm test", holding: false },
    ]);
  });

  test("declare and clear", () => {
    const t = new BackgroundTracker();
    expect(t.declare({ id: "wait-1", kind: "declared-wait", label: "CI", holding: true, until: 5 })).toEqual([
      { id: "wait-1", kind: "declared-wait", label: "CI", holding: true, until: 5 },
    ]);
    expect(t.clear("wait-1")).toEqual([]);
  });
});
