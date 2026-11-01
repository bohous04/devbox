/** Servers attached to SSH keys (see the internal design notes
 *  section 5). `name` is an alias the operator chooses in the config (dashboard); `key` is
 *  the title of the 1Password key. Thanks to this `srv`/devd can infer the server from the
 *  target alone, even when the request carries no alias — agents routinely guess the target. */
export interface SshServer {
  name: string;
  key: string;
  user: string;
  host: string;
  port: number;
  note?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isNonEmptyNoWhitespace(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !/\s/.test(v);
}

/** [] = valid. Validates only the shape — devd does not verify that the key exists in 1Password. */
export function sshServerIssues(list: unknown): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["sshServers must be an array"];
  const issues: string[] = [];
  const seenNames = new Set<string>();
  list.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") {
      issues.push(`sshServers[${i}] must be an object`);
      return;
    }
    const item = raw as Partial<SshServer>;
    if (typeof item.name !== "string" || !NAME_RE.test(item.name)) {
      issues.push(`sshServers[${i}].name has an invalid format: ${JSON.stringify(item.name)}`);
    } else if (seenNames.has(item.name)) {
      issues.push(`sshServers[${i}].name "${item.name}" already exists`);
    } else {
      seenNames.add(item.name);
    }
    // `key` is the title of the 1Password item ("SSH Key - Client shop") — spaces in it are
    // normal, it just must not be empty. `user` and `host` go to ssh, where a space makes no sense.
    if (typeof item.key !== "string" || item.key.trim() === "") {
      issues.push(`sshServers[${i}].key must be a non-empty string`);
    }
    for (const field of ["user", "host"] as const) {
      if (!isNonEmptyNoWhitespace(item[field])) {
        issues.push(`sshServers[${i}].${field} must be a non-empty string without spaces`);
      }
    }
    if (typeof item.port !== "number" || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) {
      issues.push(`sshServers[${i}].port must be an integer 1–65535`);
    }
  });
  return issues;
}

/** Parses `user@host[:port]` / `user@[ipv6]:port` / a bare `user@ipv6` (without brackets,
 *  the port is then filled in as 22, because without brackets the host cannot be separated from the port).
 *  Returns `null` when the input carries no `user@` — typically an ssh option (`-o`, `-p 2222`), not a target;
 *  such a target stays raw and unnormalized (see resolveSshTarget). */
export function normalizeTarget(t: string): string | null {
  if (typeof t !== "string") return null;
  const at = t.indexOf("@");
  if (at <= 0) return null; // no "user@" or an empty user
  const user = t.slice(0, at);
  const rest = t.slice(at + 1);
  if (!rest) return null;

  let host: string;
  let port: number;

  const bracketMatch = rest.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketMatch) {
    host = bracketMatch[1];
    port = bracketMatch[2] ? Number(bracketMatch[2]) : 22;
  } else {
    const colonCount = rest.split(":").length - 1;
    if (colonCount > 1) {
      // more than one colon without brackets = a bare IPv6 literal, the port cannot be separated → default
      host = rest;
      port = 22;
    } else if (colonCount === 1) {
      const idx = rest.lastIndexOf(":");
      const hostPart = rest.slice(0, idx);
      const portPart = rest.slice(idx + 1);
      if (!hostPart || !/^\d+$/.test(portPart)) return null;
      host = hostPart;
      port = Number(portPart);
    } else {
      host = rest;
      port = 22;
    }
  }

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  const lowerHost = host.toLowerCase();
  const hostStr = lowerHost.includes(":") ? `[${lowerHost}]` : lowerHost;
  return `${user}@${hostStr}:${port}`;
}

/** Normalized form (see normalizeTarget) of the given server, for comparison with a free-form target. */
function serverTarget(s: SshServer): string | null {
  return normalizeTarget(`${s.user}@${s.host}:${s.port}`);
}

/** Resolves a request to a concrete server/target against the config.
 *  - `server` given → must exist with a matching `key`, otherwise error; returns its `user@host:port`.
 *  - only `target` → normalizes it; if it matches a server with the same key, fills in its `server`;
 *    otherwise `server: null` and `target` is normalized, or raw if it does not normalize
 *    (a target without `user@`, e.g. an ssh option captured by mistake).
 *  - nothing → `{ok:true, server:null, target:null}`. */
export function resolveSshTarget(
  servers: SshServer[],
  key: string,
  req: { server?: string; target?: string }
): { ok: true; server: string | null; target: string | null } | { ok: false; error: string } {
  if (req.server) {
    const srv = servers.find((s) => s.name === req.server);
    if (!srv || srv.key !== key) {
      return { ok: false, error: `server ${req.server} does not belong to key ${key}` };
    }
    return { ok: true, server: srv.name, target: serverTarget(srv) };
  }
  if (req.target) {
    const normalized = normalizeTarget(req.target);
    if (normalized === null) {
      return { ok: true, server: null, target: req.target };
    }
    const match = servers.find((s) => s.key === key && serverTarget(s) === normalized);
    return { ok: true, server: match ? match.name : null, target: normalized };
  }
  return { ok: true, server: null, target: null };
}
