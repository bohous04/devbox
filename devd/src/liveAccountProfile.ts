import { isValidAccountId, profilePath, profileVolume } from "./accountProfiles";
import type { RunResult } from "./proc";

// Clone the canonical volume mount before entering the container namespace. A bind
// from a host pathname after setns cannot see that pathname. A detached mount can
// cross the namespace boundary without copying OAuth tokens or replacing Docker.
export const ATTACH_ACCOUNT_PROFILE = `import ctypes, os, platform, sys
from pathlib import Path
pid, source, target, container_id = sys.argv[1:]
def require(condition, message):
    if not condition:
        raise RuntimeError(message)
require(pid.isdigit() and int(pid) > 1, "Invalid container PID")
require(len(container_id) == 64 and all(c in "0123456789abcdef" for c in container_id), "Invalid container ID")
require(platform.machine() in ("x86_64", "aarch64"), "Unsupported host architecture")
require(Path(source, ".credentials.json").is_file(), "Account credentials are unavailable")
def verify_process():
    require(container_id in Path("/proc", pid, "cgroup").read_text(), "Container PID identity changed")
verify_process()
root_path = Path("/proc", pid, "root")
destination = root_path / target.lstrip("/")
if destination.exists() and os.path.samefile(source, destination):
    sys.exit(0)
lib = ctypes.CDLL(None, use_errno=True)
lib.syscall.restype = ctypes.c_long
def checked(value):
    if value < 0:
        raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
    return value
mount = checked(lib.syscall(428, -100, os.fsencode(source), 1 | os.O_CLOEXEC)) # open_tree(CLONE)
namespace = os.open("/proc/" + pid + "/ns/mnt", os.O_RDONLY)
root = os.open(root_path, os.O_RDONLY | os.O_DIRECTORY)
verify_process() # Refuse a PID recycled while the Docker inspection was in flight.
checked(lib.setns(namespace, 0))
os.fchdir(root)
os.chroot(".")
os.chdir("/")
path = Path(target)
# Never follow a session-created symlink when attaching a credential volume.
require(all(not parent.is_symlink() for parent in (path, *path.parents)), "Account mount path contains a symlink")
path.mkdir(parents=True, exist_ok=True)
checked(lib.syscall(429, mount, b"", -100, os.fsencode(target), 4)) # move_mount(EMPTY_PATH)
`;

export interface LiveAccountProfileDeps {
  docker(container: string, args: string[]): Promise<RunResult>;
  host(args: string[]): Promise<RunResult>;
  isRemote(container: string): boolean;
}

/** Older containers do not have accounts added after their creation. Attach the
 * original volume; refreshed credentials and revocation still use one source.
 * Failure happens before /exit. Never recreate a live workspace as a fallback. */
export async function ensureLiveAccountProfile(d: LiveAccountProfileDeps, container: string, account: string): Promise<void> {
  if (!isValidAccountId(account)) throw new Error("Invalid Claude account ID");
  const inspect = await d.docker(container, ["inspect", "--format", '{"id":{{json .Id}},"pid":{{.State.Pid}},"mounts":{{json .Mounts}}}', container]);
  if (inspect.code !== 0 || inspect.timedOut) throw new Error("Cannot inspect the Claude session container");
  const state = JSON.parse(inspect.stdout) as { id: string; pid: number; mounts: { Name?: string; Destination: string }[] };
  const target = profilePath(account);
  if (state.mounts.some(m => m.Name === profileVolume(account) && m.Destination === target)) return;
  if (!Number.isSafeInteger(state.pid) || state.pid <= 1) throw new Error("Claude session container is not running");
  if (d.isRemote(container)) throw new Error("The target Claude account is not mounted on the remote session host");
  const volume = await d.docker(container, ["volume", "inspect", "--format", "{{.Mountpoint}}", profileVolume(account)]);
  if (volume.code !== 0 || volume.timedOut || !volume.stdout.trim().startsWith("/"))
    throw new Error("The target Claude account volume is unavailable");
  const attached = await d.host(["python3", "-c", ATTACH_ACCOUNT_PROFILE, String(state.pid), volume.stdout.trim(), target, state.id]);
  if (attached.code !== 0 || attached.timedOut) throw new Error("Cannot attach the target Claude account to the running session");
}
