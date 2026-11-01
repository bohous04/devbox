import { join } from "node:path";
import type { RunOpts } from "../docker";

export const IBX_PATHS = {
  root: "/data/devbox",
  ws: (id: string) => `/data/devbox/ws/${id}`,
  ctl: (id: string) => `/data/devbox/ctl/${id}`,
  projects: (id: string) => `/data/devbox/claude-projects/${id}`,
  secrets: "/data/devbox/secrets",
};
/** SDK `DESKTOP_DISPLAY`; spike: Xvnc :1, socket without authentication, XAUTHORITY not needed. */
export const IBX_DISPLAY = ":1";
const DOCKER_SOCK = "/var/run/docker.sock:/var/run/docker.sock";

// VPS RunOpts → RunOpts for the docker daemon in the VM. VPS host paths do not exist in the VM:
// named volumes stay (devd copied them), control dir / transcripts / gh / gitea placeholder
// are remapped to copies in /data/devbox. Everything else from the VPS host (_inbox,
// prod-db keys and catalog, mac-mcp, the shared file with the REAL gitea tokens) is
// NEVER transferred. Dind is not transferred (R2): the VM is single-tenant, its own socket is mounted.
export function toRemoteRunOpts(base: RunOpts, o: { id: string; controlDir: string; claudeProjectsDir: string; ghConfigDir?: string }): RunOpts {
  const mounts: string[] = [];
  for (const m of base.extraMounts ?? []) {
    const src = m.slice(0, m.indexOf(":"));
    if (!src.startsWith("/")) { mounts.push(m); continue; }
    if (m === DOCKER_SOCK) { mounts.push(m); continue; }
    if (src === join(o.controlDir, "gitea-tokens.json")) { mounts.push(`${IBX_PATHS.ctl(o.id)}/gitea-tokens.json:/run/devbox-git/gitea-tokens.json:ro`); continue; }
    if (src === o.controlDir) { mounts.push(`${IBX_PATHS.ctl(o.id)}:/run/devd`); continue; }
    if (src === o.claudeProjectsDir) { mounts.push(`${IBX_PATHS.projects(o.id)}:/home/dev/.claude/projects/-workspace`); continue; }
    if (o.ghConfigDir && src === o.ghConfigDir) { mounts.push(`${IBX_PATHS.secrets}/gh:/home/dev/.config/gh:ro`); continue; }
  }
  if (!mounts.includes(DOCKER_SOCK)) mounts.unshift(DOCKER_SOCK);
  mounts.push("/tmp/.X11-unix:/tmp/.X11-unix");
  // The storage guard runs only on the devd host; a VM has no published state, so the flag
  // would make the in-container wrapper refuse clones and builds there.
  const { DOCKER_HOST: _dind, DEVBOX_STORAGE_GUARD: _guard, ...env } = base.env ?? {};
  return {
    ...base,
    network: undefined,
    workspace: IBX_PATHS.ws(o.id),
    bindIp: "127.0.0.1",
    extraMounts: mounts,
    env: { ...env, DISPLAY: IBX_DISPLAY, DEVBOX_HEADED: "1" },
  };
}
