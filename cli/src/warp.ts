// Grok's OSC 777 identity first shipped in the September 9, 2026 desktop build.
export function warpClientSupportsGrok(version: string): boolean {
  const match = /^v?0\.(\d{4})\.(\d{2})\.(\d{2})(?:\.|$)/.exec(version.trim());
  return !!match && Number(match[1] + match[2] + match[3]) >= 20260909;
}

export async function detectedWarpGrokSupport(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
  readVersion: () => Promise<string> = async () => {
    const proc = Bun.spawn(["/usr/libexec/PlistBuddy", "-c", "Print CFBundleShortVersionString",
      "/Applications/Warp.app/Contents/Info.plist"], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(proc.stdout).text();
    return await proc.exited === 0 ? output.trim() : "";
  },
): Promise<boolean | undefined> {
  // The running client wins over the on-disk bundle during a pending update.
  if (env.WARP_CLIENT_VERSION) return warpClientSupportsGrok(env.WARP_CLIENT_VERSION);
  if (env.TERM_PROGRAM !== "WarpTerminal" || platform !== "darwin") return undefined;
  try {
    const version = await readVersion();
    return version ? warpClientSupportsGrok(version) : undefined;
  } catch { return undefined; }
}

export function warpGrokOption(support: boolean | undefined, session: string): string {
  if (support === undefined) return "";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(session)) throw new Error("Invalid tmux session name");
  // Set the session option on every attach: existing hook processes inherit old
  // environment values, but read this option afresh after the client reconnects.
  return `tmux set-option -t ${session} @devd_warp_grok_native ${support ? 1 : 0} 2>/dev/null`;
}

// Warp locks the agent type in a tab (icon, toasts) to the FIRST agent that reports during
// one running command — and `dev` is a single block across all re-attaches of its loop.
// We therefore send the block id (one per `dev` process) to tmux: warp-title.py remembers
// the locked agent for it and sends further events under it, otherwise Warp drops them.
export const WARP_BLOCK = `${process.pid}-${Date.now().toString(36)}`;

export function warpBlockOption(support: boolean | undefined, session: string, block = WARP_BLOCK): string {
  if (support === undefined) return "";
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/.test(session)) throw new Error("Invalid tmux session name");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(block)) throw new Error("Invalid Warp block id");
  return `tmux set-option -t ${session} @devd_warp_block ${block} 2>/dev/null`;
}
