// Orchestrator of the Hardware page: combines Beszel + host probe + borg + Uptime Kuma into
// a single snapshot.
//
// Three rules it rests on:
//  1. EACH SOURCE FAILS ON ITS OWN. An SSH outage must not empty the page — the last known
//     value is shown along with an error at that source.
//  2. THE API NEVER WAITS FOR SSH. The response is always from the cache, refresh is driven by `tick`.
//  3. ONE MACHINE = ONE SSH CONNECTION PER TICK. A remote machine may have a ufw `limit` on SSH
//     (`-m recent --seconds 30 --hitcount 6 -j REJECT`), so six connections within half a
//     minute from the same IP end with "Connection refused". Verified live — that is why the probe,
//     borg and the unit state are sent as ONE script and machines are refreshed one after another.
//     The devbox has been exempt from the limit since 2026-07-27 (see docs/install.md), but the
//     exemption is MANUAL and a rebuild of the machine deletes it — this holds even without it. Saving
//     connections is also right in itself.

import { existsSync, readFileSync } from "node:fs";
import { createBeszel, type Beszel, type BeszelConfig, type BeszelSystem, type MachineSample, type RangeKey } from "./beszel";
import { borgReportScript, parseBorgReport, section, type BorgRepo } from "./borg";
import { HOST_PROBE, parseHostReport, type HostReport } from "./hostProbe";
import { fetchMonitors, type KumaConfig, type Monitor } from "./kuma";

/** Where commands run. `local` = the machine with devd, `remote` = via SSH (`remoteSsh` in secrets). */
export type Host = "local" | "remote";

export interface BackupSpec {
  repo: string;
  passFile: string;
  rsh?: string;
  remotePath?: string;
  /** systemd backup unit (without suffix); `<unit>.service` + `<unit>.timer`. */
  unit: string;
  /** The backup's own state file, when the script writes one (more precise than systemd). */
  statusFile?: string;
  /** Ready-made commands to download the repo — the dashboard just shows them for copying. */
  pull: { label: string; command: string }[];
  /** Quota of the storage the repo lives on (e.g. Storage Box). Only for a repo that
   *  should be shown in the dashboard as storage usage; without it nothing is shown. */
  quotaBytes?: number;
}

export interface MachineSpec {
  id: string;
  label: string;
  /** System name in Beszel; null = machine without an agent. */
  beszelName: string | null;
  /** The machine on which ALL commands of this entry run. */
  host: Host;
  backup?: BackupSpec;
}

/** Default registry without configuration: only the machine devd runs on, without backup.
 *  The real list (remote machines, borg repos, download commands) belongs in
 *  `DEVD_HARDWARE` (default `/etc/devd/hardware.json`) — see infra/hardware.example.json. */
export const DEFAULT_MACHINES: MachineSpec[] = [
  { id: "devbox", label: "devbox", beszelName: "devbox", host: "local" },
];

/** Loads the machine registry from JSON; a missing file = DEFAULT_MACHINES. A broken
 *  file is an error — silently falling back to the default would hide a typo in the configuration. */
export function loadMachines(path: string): MachineSpec[] {
  if (!existsSync(path)) return DEFAULT_MACHINES;
  const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(v)) throw new Error(`${path}: expected an array of machines`);
  for (const m of v as MachineSpec[]) {
    if (!m || typeof m.id !== "string" || !m.id) throw new Error(`${path}: machine without id`);
    if (m.host !== "local" && m.host !== "remote") throw new Error(`${path}: ${m.id}.host must be "local" or "remote"`);
  }
  return v as MachineSpec[];
}

/* --------------------------- backup run state --------------------------- */

export interface UnitRun {
  /** ok | failed | running | unknown */
  state: string;
  startedAt: number | null;
  finishedAt: number | null;
  nextAt: number | null;
  message: string | null;
}

/**
 * A `systemctl show` snippet to append after the borg report.
 *
 * Times go through `date -d` to epoch seconds on purpose: `--value` for
 * `NextElapseUSecRealtime` on newer systemd returns a HUMAN format
 * ("Tue 2026-07-28 02:34:22 CEST"), not microseconds as the name promises.
 */
export function unitStatusScript(unit: string, sectionName = "unit"): string {
  return [
    `echo "##${sectionName}"`,
    `_s=$(systemctl show ${unit}.service -p ExecMainStartTimestamp --value 2>/dev/null)`,
    `_f=$(systemctl show ${unit}.service -p ExecMainExitTimestamp --value 2>/dev/null)`,
    `_n=$(systemctl show ${unit}.timer -p NextElapseUSecRealtime --value 2>/dev/null)`,
    '_ts() { [ -n "$1" ] && date -d "$1" +%s 2>/dev/null; }',
    'echo "started=$(_ts "$_s")"',
    'echo "finished=$(_ts "$_f")"',
    'echo "next=$(_ts "$_n")"',
    `echo "result=$(systemctl show ${unit}.service -p Result --value 2>/dev/null)"`,
    `echo "active=$(systemctl is-active ${unit}.service 2>/dev/null)"`,
    // CAUTION: `Result=success` is the systemd DEFAULT even for a unit that DOES NOT EXIST.
    // Without LoadState the page would claim "the last run went well" for something that
    // never ran (discovered live on `devd-apt-upgrade`).
    `echo "load=$(systemctl show ${unit}.service -p LoadState --value 2>/dev/null)"`,
  ].join("\n");
}

/* ------------------------- host maintenance (apt, reboot) -------------------- */

/** Transient unit in which apt upgrade runs. */
export const APT_UNIT = "devd-apt-upgrade";
/** State of the last run. The script writes it itself — see aptUpgradeScript. */
export const APT_STATUS_FILE = "/var/lib/devd-apt-status.json";
/** Exists only while the unit runs. */
const APT_CGROUP = `/sys/fs/cgroup/system.slice/${APT_UNIT}.service`;

/**
 * Starts apt upgrade as a TRANSIENT systemd unit and returns immediately.
 *
 * Synchronously over SSH is not possible — the upgrade takes minutes and the connection would take it
 * down with it if it dropped along the way. `systemd-run` detaches it from our connection.
 *
 * The script writes its result to a file ITSELF, instead of it being read back from systemd later.
 * systemd cleans up the transient unit after it finishes, but `systemctl show` on it then
 * logs "Failed to open /run/systemd/transient/… No such file" on every query
 * — six lines into the journal for every probe, forever. Verified live after the first
 * run from the dashboard.
 *
 * `--with-new-pkgs` on purpose: without it `apt-get upgrade` holds back packages that
 * need a new dependency, and the list of "pending" ones would not empty after clicking.
 * `upgrade` (not `dist-upgrade`) because it never uninstalls anything.
 * `--force-confold` leaves existing config files alone — we will not let sshd_config be overwritten.
 */
/**
 * Wraps the script in SINGLE quotes for nested execution.
 *
 * DO NOT USE `JSON.stringify` here: it produces double quotes, so the outer shell
 * expands `$1`, `$S` and `$(date)` before systemd-run even sees them, and converts newlines
 * into a literal "\\n". Discovered live — the executed command had empty strings instead of
 * variables and bash failed with "syntax error".
 */
export function shQuote(script: string): string {
  return `'${script.replace(/'/g, `'\\''`)}'`;
}

export function aptUpgradeScript(): string {
  const apt = [
    "DEBIAN_FRONTEND=noninteractive apt-get -y",
    "-o Dpkg::Options::=--force-confold",
    "-o Dpkg::Options::=--force-confdef",
    "--with-new-pkgs upgrade",
  ].join(" ");
  const inner = [
    "S=$(date +%s)",
    `w() { printf '{"state":"%s","startedAt":%s000,"finishedAt":%s000,"message":"%s"}\\n' "$1" "$S" "$(date +%s)" "$2" > ${APT_STATUS_FILE}; }`,
    'w running ""',
    "apt-get update >/dev/null 2>&1",
    `N=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst' || true)`,
    `if ${apt}; then w ok "$N packages upgraded"; else w failed "apt exited with an error"; fi`,
  ].join("\n");
  return [
    // A leftover from the previous run would prevent starting ("unit already exists").
    `systemctl reset-failed ${APT_UNIT}.service 2>/dev/null || true`,
    `systemd-run --unit=${APT_UNIT} --description="devd apt upgrade" bash -lc ${shQuote(inner)}`,
  ].join("\n");
}

/** Reads the apt upgrade state: the state file + liveness via cgroup (without systemctl). */
export function aptStatusScript(): string {
  return [
    'echo "##apt"',
    `echo "live=$([ -d ${APT_CGROUP} ] && echo 1 || echo 0)"`,
    `cat ${APT_STATUS_FILE} 2>/dev/null`,
    "echo",
  ].join("\n");
}

/**
 * State from `aptStatusScript`. The file is the truth about the result, the cgroup about whether it
 * is still running — when the file claims "running" but the unit is gone, the process died
 * without writing the result (typically a machine restart in the middle of the upgrade).
 */
export function parseAptStatus(text: string): UnitRun | null {
  const body = section(text, "apt");
  if (!body) return null;
  const live = /^live=1$/m.test(body);
  const json = body.slice(body.indexOf("{"));
  const run = json.startsWith("{") ? parseStatusFile(json) : null;
  if (!run) return null;
  if (run.state === "running" && !live) {
    return { ...run, state: "failed", message: "the upgrade did not finish (machine restarted?)" };
  }
  return run;
}

export const REBOOT_SCRIPT = "systemctl reboot --no-block";

/**
 * borg report, but only when a backup is not running right now. A running `borg create` holds the repo
 * lock, so `borg list` would either wait or return nothing — and the nothing would get
 * stored in our cache. When the unit is active, we print `##busy` and skip the listing.
 */
export function borgWhenIdleScript(b: BackupSpec): string {
  return [
    `if systemctl is-active --quiet ${b.unit}.service; then`,
    '  echo "##busy"',
    "else",
    borgReportScript(b),
    "fi",
  ].join("\n");
}

export function parseUnitStatus(text: string, sectionName = "unit"): UnitRun {
  const out: UnitRun = { state: "unknown", startedAt: null, finishedAt: null, nextAt: null, message: null };
  let result = "", active = "", load = "";
  for (const line of section(text, sectionName).split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!value) continue;
    const n = Number(value);
    if (key === "started" && Number.isFinite(n)) out.startedAt = n * 1000;
    else if (key === "finished" && Number.isFinite(n)) out.finishedAt = n * 1000;
    else if (key === "next" && Number.isFinite(n) && n > 0) out.nextAt = n * 1000;
    else if (key === "result") result = value;
    else if (key === "active") active = value;
    else if (key === "load") load = value;
  }
  // A unit systemd does not know has no result — it stays `unknown`.
  if (load === "not-found") return out;
  if (active === "activating" || active === "active") out.state = "running";
  else if (result === "success") out.state = "ok";
  else if (result) out.state = "failed";
  if (result && result !== "success") out.message = `systemd: ${result}`;
  return out;
}

/** State file that devbox-backup.sh writes itself (it knows the message too, systemd only the code). */
export function parseStatusFile(json: string): UnitRun | null {
  try {
    const s = JSON.parse(json) as { state?: string; message?: string; startedAt?: number; finishedAt?: number };
    if (typeof s !== "object" || s === null) return null;
    return {
      state: s.state ?? "unknown",
      startedAt: typeof s.startedAt === "number" ? s.startedAt : null,
      finishedAt: typeof s.finishedAt === "number" ? s.finishedAt : null,
      nextAt: null,
      message: s.message ?? null,
    };
  } catch { return null; }
}

/** Assembles the backup state: systemd determines "running" and "when next", the file the rest. */
export function mergeUnitRun(unit: UnitRun, file: UnitRun | null): UnitRun {
  if (!file) return unit;
  return {
    state: unit.state === "running" ? "running" : file.state,
    startedAt: file.startedAt ?? unit.startedAt,
    finishedAt: file.finishedAt ?? unit.finishedAt,
    nextAt: unit.nextAt,
    message: file.message ?? unit.message,
  };
}

/* ------------------------------- snapshot ------------------------------- */

export interface MachineSnapshot {
  id: string;
  label: string;
  beszel: BeszelSystem | null;
  host: HostReport | null;
  backup: (UnitRun & { repo: BorgRepo | null; pull: { label: string; command: string }[] }) | null;
  /** State of an apt upgrade started from the dashboard; null = never run from here. */
  upgrade: UnitRun | null;
  /** When the last refresh went through (even an unsuccessful one). */
  checkedAt: number;
  /** Human-readable description of what failed to load for this machine. */
  errors: string[];
}

export interface HardwareSnapshot {
  updatedAt: number;
  machines: MachineSnapshot[];
  monitors: Monitor[];
  storageBox: { usedBytes: number; totalBytes: number } | null;
  errors: string[];
}

interface Slot<T> { value: T | null; at: number; error: string | null }
const slot = <T,>(): Slot<T> => ({ value: null, at: 0, error: null });

export interface HardwareDeps {
  /** Runs a bash script on the given machine (the script goes to STDIN). */
  run: (host: Host, script: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  beszel?: Beszel;
  kuma?: KumaConfig;
  fetchImpl?: typeof fetch;
  machines?: MachineSpec[];
  now?: () => number;
}

/** How often each source is refreshed. borg is a network path to the Storage Box (~4 s). */
export const INTERVALS = { beszel: 60_000, host: 5 * 60_000, borg: 15 * 60_000, kuma: 60_000 };
const TIMEOUT_MS = 150_000;

export interface Hardware {
  snapshot: () => HardwareSnapshot;
  tick: () => Promise<void>;
  series: (machineId: string, range: RangeKey) => Promise<MachineSample[]>;
  runBackup: (machineId: string) => Promise<void>;
  runUpgrade: (machineId: string) => Promise<void>;
  reboot: (machineId: string) => Promise<void>;
}

export function createHardware(d: HardwareDeps): Hardware {
  const machines = d.machines ?? DEFAULT_MACHINES;
  const now = d.now ?? Date.now;
  const beszel = d.beszel;
  const systems = slot<BeszelSystem[]>();
  const monitors = slot<Monitor[]>();
  const hosts = new Map(machines.map((m) => [m.id, slot<HostReport>()]));
  const backups = new Map(machines.map((m) => [m.id, slot<{ repo: BorgRepo; run: UnitRun }>()]));
  const upgrades = new Map(machines.map((m) => [m.id, slot<UnitRun>()]));

  const spec = (id: string) => machines.find((m) => m.id === id);
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const due = (s: Slot<unknown>, every: number) => now() - s.at >= every;
  const fail = (s: Slot<unknown>, error: string) => { s.error = error; s.at = now(); };

  /**
   * A single run over a single machine. Probe and borg go in ONE script (see rule 3
   * above) and the result is split by sections.
   */
  async function refreshMachine(m: MachineSpec, wantHost: boolean, wantBackup: boolean): Promise<void> {
    const hostSlot = hosts.get(m.id)!;
    const backupSlot = backups.get(m.id)!;
    const parts: string[] = [];
    if (wantHost) parts.push(HOST_PROBE, aptStatusScript());
    if (wantBackup && m.backup) {
      parts.push(unitStatusScript(m.backup.unit), borgWhenIdleScript(m.backup));
      if (m.backup.statusFile) parts.push(`echo "##status"`, `cat ${m.backup.statusFile} 2>/dev/null`);
    }
    if (parts.length === 0) return;

    let out: { code: number; stdout: string; stderr: string };
    try {
      out = await d.run(m.host, parts.join("\n") + '\necho "##done"\n', TIMEOUT_MS);
    } catch (e) {
      if (wantHost) fail(hostSlot, msg(e));
      if (wantBackup) fail(backupSlot, msg(e));
      return;
    }
    // The connection did not go through at all (SSH error) — stdout is empty and the rest is pointless.
    const reachable = out.stdout.includes("##done");
    const why = () => `${out.stderr.trim().slice(0, 200) || `code ${out.code}`}`;

    if (wantHost) {
      if (reachable && out.stdout.includes("##host")) {
        hostSlot.value = parseHostReport(out.stdout); hostSlot.error = null; hostSlot.at = now();
        // null = the state file does not exist, so nobody has started an upgrade from here.
        const apt = parseAptStatus(out.stdout);
        const aptSlot = upgrades.get(m.id)!;
        if (apt) aptSlot.value = apt;
        aptSlot.at = now();
        // During an upgrade we want to see progress sooner than in five minutes (and above all we want
        // to catch in time that the list of pending packages has emptied).
        if (apt?.state === "running") hostSlot.at = now() - INTERVALS.host + 20_000;
      } else fail(hostSlot, why());
    }
    if (wantBackup && m.backup) {
      if (!reachable) { fail(backupSlot, why()); return; }
      const run = mergeUnitRun(parseUnitStatus(out.stdout), m.backup.statusFile ? parseStatusFile(section(out.stdout, "status")) : null);
      if (out.stdout.includes("##busy")) {
        // A backup is running right now and holds the repo lock — `borg list` would return nothing and we
        // would store that zero for the next 15 minutes (verified live after clicking
        // "Back up now"). So we keep the old archive list and try again in a minute.
        backupSlot.value = { repo: backupSlot.value?.repo ?? { archives: [], lastArchiveAt: null, originalBytes: 0, storedBytes: 0 }, run };
        backupSlot.error = null;
        backupSlot.at = now() - INTERVALS.borg + 60_000;
        return;
      }
      const repo = parseBorgReport(out.stdout);
      backupSlot.value = { repo, run };
      // borg can fail even after a successful connection (wrong passphrase, unreachable target) —
      // an empty archive list gives it away and there is no point passing it off as success.
      backupSlot.error = repo.archives.length === 0 ? "borg returned no archives" : null;
      backupSlot.at = now();
    }
  }

  return {
    snapshot(): HardwareSnapshot {
      const errors: string[] = [];
      if (systems.error) errors.push(`Beszel: ${systems.error}`);
      if (monitors.error) errors.push(`Uptime Kuma: ${monitors.error}`);
      const out = machines.map((m): MachineSnapshot => {
        const h = hosts.get(m.id)!;
        const b = backups.get(m.id)!;
        const mErrors: string[] = [];
        if (h.error) mErrors.push(`probe: ${h.error}`);
        if (b.error) mErrors.push(`borg: ${b.error}`);
        return {
          id: m.id, label: m.label,
          beszel: (m.beszelName && systems.value?.find((x) => x.name === m.beszelName)) || null,
          host: h.value,
          backup: b.value ? { ...b.value.run, repo: b.value.repo, pull: m.backup?.pull ?? [] } : null,
          upgrade: upgrades.get(m.id)!.value,
          checkedAt: Math.max(h.at, b.at),
          errors: mErrors,
        };
      });
      // Storage usage is shown only for a repo with `quotaBytes` — other repos may
      // live on a local disk and get into the storage only inside another archive.
      const quotaMachine = machines.find((m) => m.backup?.quotaBytes);
      const quotaRepo = quotaMachine ? out.find((m) => m.id === quotaMachine.id)?.backup?.repo ?? null : null;
      return {
        updatedAt: Math.max(systems.at, monitors.at, ...out.map((m) => m.checkedAt)),
        machines: out,
        monitors: monitors.value ?? [],
        storageBox: quotaRepo && quotaRepo.storedBytes > 0 ? { usedBytes: quotaRepo.storedBytes, totalBytes: quotaMachine!.backup!.quotaBytes! } : null,
        errors,
      };
    },

    async tick() {
      // HTTP sources may run in parallel, shell ones may not — see rule 3.
      const http: Promise<unknown>[] = [];
      if (beszel && due(systems, INTERVALS.beszel)) {
        http.push(beszel.systems().then(
          (v) => { systems.value = v; systems.error = null; systems.at = now(); },
          (e) => fail(systems, msg(e))));
      }
      if (d.kuma && due(monitors, INTERVALS.kuma)) {
        http.push(fetchMonitors(d.kuma, d.fetchImpl).then(
          (v) => { monitors.value = v; monitors.error = null; monitors.at = now(); },
          (e) => fail(monitors, msg(e))));
      }
      // At most ONE backup per tick. `borg list` + `borg info` are two separate
      // connections, so both repos at once plus the remote machine's probe would make three, leaving no headroom
      // for the ufw limit (6/30 s) or for a human who happens to log in. The one checked
      // least recently is taken, so the two alternate and do not run in lockstep.
      const backupTurn = machines
        .filter((m) => m.backup && due(backups.get(m.id)!, INTERVALS.borg))
        .sort((a, b) => backups.get(a.id)!.at - backups.get(b.id)!.at)[0];
      for (const m of machines) {
        const wantHost = due(hosts.get(m.id)!, INTERVALS.host);
        const wantBackup = m === backupTurn;
        if (wantHost || wantBackup) await refreshMachine(m, wantHost, wantBackup);
      }
      await Promise.all(http);
    },

    async series(machineId, range) {
      const m = spec(machineId);
      if (!m?.beszelName) throw new Error(`machine ${machineId} has no Beszel agent`);
      if (!beszel) throw new Error("Beszel is not configured");
      const sys = (systems.value ?? []).find((x) => x.name === m.beszelName)
        ?? (await beszel.systems()).find((x) => x.name === m.beszelName);
      if (!sys) throw new Error(`Beszel does not know system ${m.beszelName}`);
      return beszel.samples(sys.id, range);
    },

    async runBackup(machineId) {
      const m = spec(machineId);
      if (!m?.backup) throw new Error(`machine ${machineId} has no backup`);
      // --no-block: `Type=oneshot` would otherwise hold the HTTP request for whole minutes.
      // The return code is DELIBERATELY not evaluated (for oneshot it is 3 even after success) —
      // the result shows up at the next refresh from the state file / systemd.
      await d.run(m.host, `systemctl start --no-block ${m.backup.unit}.service`, 20_000);
      const slot = backups.get(machineId)!;
      // Optimistically "running" right now — same as runUpgrade below. Without this the
      // snapshot kept the old state until the next tick (30 s) + FE poll (20 s)
      // and the button gave no feedback for up to a minute after clicking. If the
      // unit did not start, the next tick (slot.at = 0) overwrites the state with the truth anyway.
      if (slot.value) {
        slot.value = { ...slot.value, run: { ...slot.value.run, state: "running", startedAt: now(), finishedAt: null } };
      }
      slot.at = 0;   // so the state is loaded right at the next tick
    },

    async runUpgrade(machineId) {
      const m = spec(machineId);
      if (!m) throw new Error(`unknown machine ${machineId}`);
      const r = await d.run(m.host, aptUpgradeScript(), 30_000);
      // Here the code DOES MATTER (unlike `systemctl start` for oneshot): systemd-run
      // returns right after creating the unit, so nonzero means it did not start.
      if (r.code !== 0) throw new Error(`apt upgrade could not be started: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      upgrades.get(machineId)!.value = { state: "running", startedAt: now(), finishedAt: null, nextAt: null, message: null };
      hosts.get(machineId)!.at = 0;     // the unit state is fetched right at the next tick
    },

    async reboot(machineId) {
      const m = spec(machineId);
      if (!m) throw new Error(`unknown machine ${machineId}`);
      await d.run(m.host, REBOOT_SCRIPT, 20_000);
      // We do not check the return code: on the devbox this command kills ourselves.
      hosts.get(machineId)!.at = 0;
    },
  };
}

/**
 * argv for running a script on a remote machine. The script goes to STDIN (`bash -s`), not
 * into argv — otherwise the quotes inside would break against the remote shell.
 *
 * `BatchMode` on purpose: without a key it should fail immediately, not wait for a password nobody will type.
 */
export function sshArgv(cfg: { host: string; port: number | string; user: string; key: string }): string[] {
  return [
    "ssh", "-i", cfg.key, "-p", String(cfg.port),
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15", "-o", "IdentitiesOnly=yes",
    `${cfg.user}@${cfg.host}`, "bash", "-s",
  ];
}

/** Beszel client from the secrets section; returns undefined when configuration is missing. */
export function beszelFrom(cfg: Partial<BeszelConfig> | undefined, fetchImpl?: typeof fetch): Beszel | undefined {
  if (!cfg?.url || !cfg.email || !cfg.password) return undefined;
  return createBeszel({ url: cfg.url, email: cfg.email, password: cfg.password }, fetchImpl);
}
