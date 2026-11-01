// Inventory of borg repositories. Two repos, each read SOMEWHERE ELSE:
//
//   remote → the repo lives on the Storage Box, the passphrase is on the remote machine (/etc/borg/passphrase)
//            → `borg` runs ON the remote machine
//   devbox → the repo lives on the remote machine (/var/backups/devbox-borg), the passphrase is on the devbox
//            → `borg` runs ON the devbox via BORG_RSH
//
// devd knows neither repo's passphrase and does not need to.

export interface BorgArchive { name: string; at: number; id: string }
export interface BorgRepo {
  archives: BorgArchive[];
  lastArchiveAt: number | null;
  /** Sum of the original data of all archives (without dedup). */
  originalBytes: number;
  /** How much the repo actually takes up on the target. */
  storedBytes: number;
}

export interface BorgTarget {
  /** Complete `borg list/info` wrapper — passphrase export, BORG_RSH, repo. */
  script: string;
}

/** Builds a script that prints `##list` and `##info` as JSON. Runs on the `runOn` machine. */
export function borgReportScript(opts: { repo: string; passFile: string; rsh?: string; remotePath?: string }): string {
  const remote = opts.remotePath ? `--remote-path ${opts.remotePath}` : "";
  return [
    "set -u",
    `export BORG_PASSPHRASE="$(cat ${opts.passFile})"`,
    opts.rsh ? `export BORG_RSH=${JSON.stringify(opts.rsh)}` : "",
    // Non-interactively: without this borg asks about an unknown/moved repo, and what would
    // stay hanging is the SSH connection, not a user.
    "export BORG_RELOCATED_REPO_ACCESS_IS_OK=no BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=no",
    'echo "##list"',
    `borg list ${remote} --json ${JSON.stringify(opts.repo)} 2>/dev/null`,
    'echo "##info"',
    `borg info ${remote} --json ${JSON.stringify(opts.repo)} 2>/dev/null`,
    'echo "##end"',
  ].filter(Boolean).join("\n") + "\n";
}

/** Borg writes `start` as local time without a zone ("2026-07-27T04:03:05.000000"). */
function borgTime(s: unknown): number {
  if (typeof s !== "string") return 0;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Cuts the `##name` section out of the (possibly combined) output — the next `##` ends it. */
export function section(text: string, name: string): string {
  const start = text.indexOf(`##${name}`);
  if (start < 0) return "";
  const body = text.slice(start + name.length + 2);
  const next = body.search(/^##/m);
  return (next < 0 ? body : body.slice(0, next)).trim();
}

/** Parses the output of `borgReportScript`. An empty/broken section → empty repo, not an exception. */
export function parseBorgReport(text: string): BorgRepo {
  let archives: BorgArchive[] = [];
  let originalBytes = 0;
  let storedBytes = 0;

  const listRaw = section(text, "list");
  if (listRaw) {
    try {
      const parsed = JSON.parse(listRaw) as { archives?: { name?: string; start?: string; id?: string }[] };
      archives = (parsed.archives ?? [])
        .map((a) => ({ name: a.name ?? "", at: borgTime(a.start), id: (a.id ?? "").slice(0, 12) }))
        .filter((a) => a.name !== "")
        .sort((a, b) => b.at - a.at);          // newest first
    } catch { /* unparseable list → we behave as with an empty repo */ }
  }

  const infoRaw = section(text, "info");
  if (infoRaw) {
    try {
      const parsed = JSON.parse(infoRaw) as { cache?: { stats?: { total_size?: number; unique_csize?: number } } };
      const stats = parsed.cache?.stats ?? {};
      originalBytes = Number(stats.total_size) || 0;
      // unique_csize = what the repo actually takes up after dedup and compression; total_csize is only
      // compression without dedup and for "how much it takes on disk" it would overstate.
      storedBytes = Number(stats.unique_csize) || 0;
    } catch { /* dtto */ }
  }

  return { archives, lastArchiveAt: archives[0]?.at ?? null, originalBytes, storedBytes };
}
