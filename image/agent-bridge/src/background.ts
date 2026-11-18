import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundWork } from "./events.ts";

// Claude keeps one pending wakeup per session, so a new ScheduleWakeup replaces the previous one.
export const WAKEUP_ID = "wakeup";

// Kinds the SDK reports as tasks; wakeups and declared waits are tracked here, not by the SDK.
const TASK_KINDS: ReadonlySet<BackgroundWork["kind"]> = new Set(["subagent", "workflow", "monitor", "command"]);

// Only the launching Monitor tool tells a Monitor's local_bash task from a background Bash command.
// A shell command is not holding: the agent may never come back for it unless it declares a wait.
// Any other task type (remote agents, MCP tasks, types newer than this code) holds: the agent is
// woken by its notification, so treating it as done would report "done" too early.
function taskWork(id: string, taskType: string | undefined, description: string, byMonitor: boolean): BackgroundWork {
  if (taskType === "local_bash") {
    return byMonitor
      ? { id, kind: "monitor", label: description, holding: true }
      : { id, kind: "command", label: description, holding: false };
  }
  if (taskType === "local_workflow") return { id, kind: "workflow", label: description, holding: true };
  return { id, kind: "subagent", label: description, holding: true };
}

export class BackgroundTracker {
  private work = new Map<string, BackgroundWork>();
  private monitorCalls = new Set<string>();
  private wakeupCalls = new Map<string, string>(); // tool_use id -> reason

  apply(msg: SDKMessage): BackgroundWork[] | null {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type !== "tool_use") continue;
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (block.name === "Monitor") this.monitorCalls.add(block.id);
        if (block.name === "ScheduleWakeup") {
          this.wakeupCalls.set(block.id, typeof input.reason === "string" && input.reason ? input.reason : "Scheduled wakeup");
        }
      }
      return null;
    }
    if (msg.type === "user") return this.applyWakeupResult(msg);
    if (msg.type !== "system") return null;
    if (msg.subtype === "task_started") {
      if (msg.ambient) return null;
      const byMonitor = msg.tool_use_id !== undefined && this.monitorCalls.has(msg.tool_use_id);
      this.work.set(msg.task_id, taskWork(msg.task_id, msg.task_type, msg.description, byMonitor));
      return this.list();
    }
    if (msg.subtype === "task_notification") {
      return this.work.delete(msg.task_id) ? this.list() : null;
    }
    if (msg.subtype === "background_tasks_changed") {
      // Level signal with replace semantics (sdk.d.ts SDKBackgroundTasksChangedMessage).
      const next = new Map<string, BackgroundWork>();
      for (const [id, w] of this.work) if (!TASK_KINDS.has(w.kind)) next.set(id, w);
      for (const t of msg.tasks) {
        if (t.ambient) continue;
        next.set(t.task_id, this.work.get(t.task_id) ?? taskWork(t.task_id, t.task_type, t.description, false));
      }
      this.work = next;
      return this.list();
    }
    return null;
  }

  declare(w: BackgroundWork): BackgroundWork[] {
    this.work.set(w.id, w);
    return this.list();
  }

  clear(id: string): BackgroundWork[] {
    this.work.delete(id);
    return this.list();
  }

  list(): BackgroundWork[] {
    return [...this.work.values()];
  }

  private applyWakeupResult(msg: Extract<SDKMessage, { type: "user" }>): BackgroundWork[] | null {
    const content = msg.message.content;
    if (!Array.isArray(content)) return null;
    const returned = content.filter((b) => b.type === "tool_result" && this.wakeupCalls.has(b.tool_use_id));
    if (returned.length === 0) return null;
    const last = returned.at(-1) as { tool_use_id: string; is_error?: boolean };
    const reason = this.wakeupCalls.get(last.tool_use_id)!;
    for (const b of returned) this.wakeupCalls.delete((b as { tool_use_id: string }).tool_use_id);
    const result = msg.tool_use_result as { scheduledFor?: unknown } | undefined;
    // tool_use_result is one per message; with several ScheduleWakeup results it is the last call's (the one that stands).
    const scheduledFor = !last.is_error && result && typeof result === "object" ? result.scheduledFor : undefined;
    // stop:true reports scheduledFor 0, and a failed call schedules nothing: both clear the wakeup.
    if (typeof scheduledFor === "number" && scheduledFor > 0) {
      this.work.set(WAKEUP_ID, { id: WAKEUP_ID, kind: "wakeup", label: reason, holding: true, until: scheduledFor });
    } else {
      this.work.delete(WAKEUP_ID);
    }
    return this.list();
  }
}
