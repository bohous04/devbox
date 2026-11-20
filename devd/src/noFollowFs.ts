// devd runs as root and writes into directories the session's agent can also write into: the
// control dir (mounted rw as /run/devd), the workspace and the bare clone. Plain writeFileSync /
// chmodSync / chownSync follow symlinks, so an agent planting `ln -s /etc/x /run/devd/prompt`
// would make root overwrite (and chmod) a host file. Writes there go through these helpers instead:
//  - every directory below a trusted root is opened with O_DIRECTORY|O_NOFOLLOW from its parent's
//    fd. On Linux the next step resolves through /proc/self/fd/<fd> (openat semantics), so a
//    component swapped for a symlink after the check is not followed. Without /proc (macOS dev
//    machines) it falls back to the plain path — each component is still checked, but racily;
//  - a file is created with O_CREAT|O_EXCL|O_NOFOLLOW (never follows a link, never writes into an
//    existing file) and its mode/owner are set on the fd, not on the path.
import { closeSync, constants as C, existsSync, fchmodSync, fchownSync, lstatSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

const HAS_PROC = existsSync("/proc/self/fd");

export interface DirHandle {
  /** A path that resolves to the opened directory itself (via its fd on Linux). */
  readonly path: string;
  /** For fchown/fchmod of the directory itself. */
  readonly fd: number;
  close(): void;
}

/** Opens `rel` (one segment per element) below the trusted directory `root` without following any
 *  symlink; `create` makes missing directories (0o755). Throws on a symlink, a non-directory or
 *  a missing component. */
export function openDirNoFollow(root: string, rel: string[] = [], create = false): DirHandle {
  let fd = openSync(root, C.O_RDONLY | C.O_DIRECTORY);
  let plain = root;
  const at = () => (HAS_PROC ? `/proc/self/fd/${fd}` : plain);
  try {
    for (const seg of rel) {
      if (!seg || seg === "." || seg === ".." || seg.includes("/")) throw new Error(`invalid path segment ${JSON.stringify(seg)}`);
      const p = join(at(), seg);
      if (create) {
        try { mkdirSync(p, 0o755); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      }
      const next = openSync(p, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      closeSync(fd);
      fd = next;
      plain = join(plain, seg);
    }
  } catch (e) { closeSync(fd); throw e; }
  const path = at();
  return { path, fd, close: () => closeSync(fd) };
}

export interface WriteOpts {
  mode: number;
  owner?: { uid: number; gid: number };
  /** Unlink whatever is at the name first (a planted symlink goes, its target stays). Without it an
   *  existing name is an error (EEXIST). */
  replace?: boolean;
}

/** Writes `name` in `dir` as a new file; never follows a symlink at the name. */
export function writeFileAt(dir: DirHandle, name: string, data: string | Uint8Array, o: WriteOpts): void {
  const p = join(dir.path, name);
  if (o.replace) {
    // A planted directory is not "a file to replace": refuse explicitly instead of an EISDIR surprise.
    let isDir = false;
    try { isDir = lstatSync(p).isDirectory(); } catch { /* nothing there */ }
    if (isDir) throw new Error(`${name} is a directory, refusing to replace it`);
    rmSync(p, { force: true });
  }
  const fd = openSync(p, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, o.mode);
  try {
    const buf = Buffer.from(data);
    for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off);
    fchmodSync(fd, o.mode);   // the umask must not narrow it
    if (o.owner) fchownSync(fd, o.owner.uid, o.owner.gid);
  } finally { closeSync(fd); }
}

/** Opens `rel` below `root` (see openDirNoFollow), runs `fn` with it and closes it. */
export function withDir<T>(root: string, rel: string[], create: boolean, fn: (d: DirHandle) => T): T {
  const d = openDirNoFollow(root, rel, create);
  try { return fn(d); } finally { d.close(); }
}
