// Sidecar with its own docker daemon for a single session.
//
// Today /var/run/docker.sock is mounted into the session, so the agent can start a container
// with `-v /:/host` and read anything on the host — including what devd holds in memory after
// the vault is unlocked. The sidecar closes this: `--privileged` is a necessity for dind, but it is
// a privilege INSIDE its own namespace, not on the host.
import { memoryArgs } from "./docker";
const IMAGE = "docker:27-dind";

export const dindName = (session: string) => `dind-${session}`;
export const dindNetwork = (session: string) => `dind-net-${session}`;
export const dindVolume = (session: string) => `${dindName(session)}-data`;

/** Daemon address for the session container — over the private network, by the sidecar's name. */
export const dockerHostFor = (session: string) => `tcp://${dindName(session)}:2375`;

export function dindRunArgs(session: string): string[] {
  return [
    "run", "-d", "--restart", "unless-stopped",
    "--name", dindName(session),
    "--privileged",
    // Containers the agent starts in the sidecar are in its cgroup — the cap applies to them too.
    ...memoryArgs(),
    // Empty CERTDIR = no TLS. The daemon is reachable only over the session's private network,
    // so certificates would add complexity with no gain.
    "-e", "DOCKER_TLS_CERTDIR=",
    // Layers and volumes of the agent's containers. Without this, images would be pulled after every start.
    "-v", `${dindVolume(session)}:/var/lib/docker`,
    "--network", dindNetwork(session),
    IMAGE,
    // After the image = arguments for dockerd (the entrypoint appends them after its --host). Without
    // an explicit --tls=false, dockerd 27 deliberately sleeps 15 s when listening on TCP without TLS
    // ("Startup is intentionally being slowed down"), so the sidecar took
    // 17.7 s to come up instead of 2.5 s and every session start waited for it. The empty CERTDIR above
    // disables TLS only in the entrypoint; dockerd itself does not take it as intentional.
    "--tls=false",
  ];
}

/** An orphaned sidecar holds a privileged container and tens of GB of layers, so cleanup is not
 *  cosmetic. On `stop` the data is deliberately kept — the session should be openable again. */
export function dindCleanupPlan(session: string, o: { keepData: boolean }): string[][] {
  if (o.keepData) return [["docker", "stop", dindName(session)]];
  return [
    ["docker", "rm", "-f", dindName(session)],
    ["docker", "network", "rm", dindNetwork(session)],
    ["docker", "volume", "rm", dindVolume(session)],
  ];
}

/** Candidate subnets for the session network. Docker's default pools (172.17–31/16 +
 *  192.168/20) give only ~30 networks and every session — even a stopped one — holds one, so
 *  the next session failed with "all predefined address pools have been fully subnetted"
 *  and did not start. Own /24s from 10.213/16 = 256 networks; the default pools stay for compose
 *  projects and Coolify. The starting point is derived from the name so it does not always try from zero. */
export function dindSubnetCandidates(session: string): string[] {
  let h = 0;
  for (const ch of session) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: 256 }, (_, i) => `10.213.${(h + i) % 256}.0/24`);
}

/** The network is created separately — `docker run --network` does not create it by itself and the error
 *  "network not found" would only show up at session start. */
export function dindNetworkCreate(session: string, subnet: string): string[] {
  return ["docker", "network", "create", "--subnet", subnet, dindNetwork(session)];
}

/** Commands the sidecar builds (network see dindNetworkCreate). */
export function dindEnsurePlan(session: string): string[][] {
  // `dindRunArgs` returns only the docker arguments (for testability), so the binary
  // must be added here — otherwise sh() tries to run `run`.
  return [["docker", ...dindRunArgs(session)]];
}
