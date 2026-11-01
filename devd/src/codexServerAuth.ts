// The main Codex account login that is actually alive. Since Codex Remote, the token is rotated
// only by the central `codex-remote-control` on the host; the `codex-home` volume holds a copy
// nobody refreshes anymore, so the quota poller over it ends up on
// `stale-login` after expiry (2026-10-05: volume last refreshed 24 Sep, the server lived on).
// devd only READS the file — the rule "devd does not refresh the token" (codexPoller.ts) still holds.
//
// CODEX_HOME is taken from the service environment, not hard-coded: the host may have a drop-in that
// gives the server its own home (/var/lib/codex-remote-home). Without the drop-in it is
// /home/dev/.codex without auth.json → null → the poller stays on the volume.
//
// Only while the service is RUNNING. A stopped server (2026-10-14 disabled) no longer refreshes
// its auth.json; if devd kept reading it, the Main account card would forever report
// `stale-login` — even after a successful reauth, which writes into `codex-home`.

export const CODEX_SERVER_UNIT = "codex-remote-control";

/** `systemctl show -p Environment --value` → CODEX_HOME (the last assignment wins). */
export function codexHomeFromEnvironment(env: string): string | null {
  let home: string | null = null;
  for (const m of env.matchAll(/(?:^|\s)CODEX_HOME=("([^"]*)"|\S+)/g)) home = m[2] ?? m[1]!;
  return home && home.startsWith("/") && !home.split("/").includes("..") ? home : null;
}

/** `systemctl show -p ActiveState -p Environment` → CODEX_HOME, but only for a running service. */
export function codexServerHome(show: string): string | null {
  const prop = (key: string) => show.split("\n").find(l => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
  return prop("ActiveState")?.trim() === "active" ? codexHomeFromEnvironment(prop("Environment") ?? "") : null;
}

export async function readCodexServerAuth(): Promise<string | null> {
  try {
    const p = Bun.spawn(["systemctl", "show", CODEX_SERVER_UNIT, "-p", "ActiveState", "-p", "Environment"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const show = await new Response(p.stdout).text();
    if (await p.exited !== 0) return null;
    const home = codexServerHome(show);
    if (!home) return null;
    const file = Bun.file(`${home.replace(/\/$/, "")}/auth.json`);
    if (!await file.exists()) return null;
    const raw = await file.text();
    return raw.trim() === "" ? null : raw;
  } catch {
    return null;
  }
}
