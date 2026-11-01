import { Hono } from "hono";
import type { Vault } from "./vault";

// Reverse proxy for git. The container speaks plain HTTP over the docker bridge, the real HTTPS
// is established only by this code on the host — that is why there is no custom CA or TLS unwrapping here.
//
// Instead of a token the container has a DUMMY (`devbox-<session>-<random>`). Outside this process it
// opens nothing, so when it leaks — into a log, a commit, a prompt — it gives nobody anything.
// The real token is added only here, from the unlocked vault, and never travels back down.

export interface PlaceholderRef { instance: string; session: string }

export interface GitProxyDeps {
  vault: Vault;
  instances: () => { name: string; url: string }[];
  /** dummy → which instance and whose session. The map is held by whoever creates sessions. */
  placeholders: () => Record<string, PlaceholderRef>;
  /** Deliberately narrower than `typeof fetch` — we call it only with a Request and the wider type carries
   *  Bun's `preconnect`, which every test stub would have to provide. */
  fetch?: (req: Request) => Promise<Response>;
  audit?: (e: { session: string; instance: string; path: string }) => void;
}

/** Extracts the password from the `Authorization: Basic` header. Git sends user:password, the dummy is
 *  in place of the password — the name (`devbox`) does not interest us. */
function basicPassword(auth: string): string {
  if (!auth.startsWith("Basic ")) return "";
  try { return atob(auth.slice(6)).split(":").slice(1).join(":"); }
  catch { return ""; }   // invalid base64 → simply no dummy
}

export function createGitProxy(d: GitProxyDeps): Hono {
  const app = new Hono();
  const doFetch = d.fetch ?? ((req: Request) => fetch(req));

  app.all("/git/:instance/*", async (c) => {
    const instName = c.req.param("instance");
    const inst = d.instances().find((i) => i.name === instName);
    if (!inst) return c.json({ error: "unknown instance" }, 404);

    // Git first asks WITHOUT authorization and calls the credential helper only when it
    // gets a 401 with a challenge. Without this header the dummy would never be sent and the clone would
    // fail with "not valid: is this a git repository?" (verified in production 2026-08-22).
    const auth = c.req.header("authorization");
    if (!auth) {
      return c.body(null, 401, { "WWW-Authenticate": 'Basic realm="devbox"' });
    }

    // The dummy is verified BEFORE the vault: we reject an unknown one even on a locked devd, so that
    // the response does not reveal whether the vault is unlocked.
    const placeholder = basicPassword(auth);
    // The dummy belongs to the SESSION, not the instance: the credential helper in the container keys by
    // host and all instances go through one host (devd), so a session has only one
    // dummy (issued for the first instance). The instance is determined by the path `/git/<instance>/`.
    // The instance used to be compared here and a push to a second Gitea failed with 403.
    const mapped = d.placeholders()[placeholder];
    if (!mapped) return c.json({ error: "unknown placeholder" }, 403);

    if (d.vault.isLocked()) return c.json({ error: "vault is locked — unlock it in the dashboard" }, 423);
    const real = d.vault.secrets().giteaTokens?.[instName];
    // Better a loud error than forwarding without authorization — that would look like
    // a broken repo, not like a missing token.
    if (!real) return c.json({ error: `token for ${instName} is missing from the vault` }, 502);

    const url = new URL(c.req.url);
    const suffix = url.pathname.slice(`/git/${instName}`.length);
    d.audit?.({ session: mapped.session, instance: instName, path: suffix });

    const headers = new Headers(c.req.raw.headers);
    headers.set("authorization", "Basic " + btoa(`devbox:${real}`));
    headers.delete("host");   // otherwise the upstream would get the proxy's hostname
    // Body framing is determined by the outgoing request. If we forwarded the client's
    // `transfer-encoding: chunked` (git uses it for larger pushes) and sent the body
    // as a fixed-length buffer, the upstream gets two contradictory signals and returns 400.
    headers.delete("transfer-encoding");
    headers.delete("content-length");

    // The body goes as a STREAM, not via a buffer: repositories on this instance are 8-27 GB and
    // a push of such a pack held in memory would take devd down. `duplex: "half"` is mandatory for
    // a streamed body and is missing from Bun's types.
    const body = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body;

    return doFetch(new Request(inst.url + suffix + url.search, {
      method: c.req.method,
      headers,
      body,
      redirect: "manual",
      duplex: "half",
    } as RequestInit));
  });

  return app;
}

/** `git config --global url.<proxy>.insteadOf <gitea>` for each instance.
 *  The trailing slash on both sides is mandatory — without it git glues the address together without a separator
 *  and `clone http://gitea/org/repo.git` ends up on a nonsensical path. */
export function insteadOfArgs(instances: { name: string; url: string }[], devdUrl: string): string[][] {
  const base = devdUrl.replace(/\/+$/, "");
  return instances.map((i) => [
    "git", "config", "--global",
    `url.${base}/git/${i.name}/.insteadOf`,
    i.url.replace(/\/+$/, "") + "/",
  ]);
}

/** Compact notation for the container entrypoint: `name=url,name=url`. The proxy address is
 *  not passed — the entrypoint knows it from DEVD_URL. */
export function insteadOfEnv(instances: { name: string; url: string }[]): string {
  return instances.map((i) => `${i.name}=${i.url.replace(/\/+$/, "")}`).join(",");
}
