import { readFileSync } from "node:fs";
import { runClaudeTurn, type QueryFn } from "./claude.ts";
import { EventLog } from "./eventLog.ts";
import type { TokenUsage } from "./events.ts";

export interface OnceArgs {
  promptFile: string;
  cwd: string;
  model: string;
  log: string;
  configDir: string;
  entrypoint?: string;
  claudeExecutable?: string;
}

export interface OnceSummary {
  status: "completed" | "failed";
  nativeThreadId: string | null;
  model: string | null;
  usage: TokenUsage | null;
}

const REQUIRED: Record<string, keyof OnceArgs> = {
  "--prompt-file": "promptFile",
  "--cwd": "cwd",
  "--model": "model",
  "--log": "log",
};
const OPTIONAL: Record<string, keyof OnceArgs> = {
  "--entrypoint": "entrypoint",
  "--config-dir": "configDir",
};

export function parseArgs(argv: string[]): OnceArgs {
  if (argv[0] !== "once") throw new Error("usage: agent-bridge once --prompt-file <path> --cwd <dir> --model <m> --log <path>");
  const values: Partial<Record<keyof OnceArgs, string>> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = REQUIRED[argv[i]] ?? OPTIONAL[argv[i]];
    if (!key) throw new Error(`unknown flag ${argv[i]}`);
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${argv[i]}`);
    values[key] = value;
  }
  for (const [flag, key] of Object.entries(REQUIRED)) {
    if (!values[key]) throw new Error(`missing required flag ${flag}`);
  }
  const configDir = values.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  if (!configDir) throw new Error("missing --config-dir (and CLAUDE_CONFIG_DIR is not set)");
  return { ...values, configDir } as OnceArgs;
}

export async function runOnce(args: OnceArgs, queryFn?: QueryFn): Promise<OnceSummary> {
  const claudeExecutable = args.claudeExecutable ?? Bun.which("claude");
  if (!claudeExecutable) throw new Error("claude binary not found on PATH");
  const log = new EventLog(args.log);
  const summary: OnceSummary = { status: "failed", nativeThreadId: null, model: null, usage: null };
  const turn = runClaudeTurn(
    {
      runId: crypto.randomUUID(),
      prompt: readFileSync(args.promptFile, "utf8"),
      cwd: args.cwd,
      model: args.model,
      claudeExecutable,
      configDir: args.configDir,
      entrypoint: args.entrypoint,
    },
    queryFn,
  );
  for await (const event of turn) {
    log.append(event);
    if (event.type === "run.started") {
      summary.nativeThreadId = event.nativeThreadId;
      summary.model = event.model;
    } else if (event.type === "run.completed") {
      summary.status = "completed";
      summary.usage = event.usage;
    }
  }
  return summary;
}

if (import.meta.main) {
  try {
    const summary = await runOnce(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(summary));
    process.exit(summary.status === "completed" ? 0 : 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}
