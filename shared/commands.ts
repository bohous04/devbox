import type { AgentCommand } from "../image/agent-bridge/src/events";

export type { AgentCommand };

/** An agent's slash commands as devd keeps and serves them, whatever shape a bridge sent: a command needs a name that
 *  can follow a "/" in a message (no spaces, no leading "/"); a description or hint of another type is left out.
 *  `dropped` names what was left out, one entry per kind. */
export function parseCommands(raw: unknown): { commands: AgentCommand[]; dropped: string[] } {
  const dropped = new Set<string>();
  const commands: AgentCommand[] = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    const name = typeof c === "object" && c !== null ? (c as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || !/^[^\s/]\S*$/.test(name)) {
      dropped.add("command without a valid name");
      continue;
    }
    const cmd: AgentCommand = { name };
    for (const field of ["description", "hint"] as const) {
      const v = (c as Record<string, unknown>)[field];
      if (v === undefined) continue;
      if (typeof v === "string") cmd[field] = v;
      else dropped.add(`command ${field} that is not a string`);
    }
    commands.push(cmd);
  }
  if (!Array.isArray(raw)) dropped.add("command list that is not a list");
  return { commands, dropped: [...dropped] };
}
