// One-time fix before host git runs as the agent uid: root's git left root-owned files in the
// agent repos. Dry run by default (prints counts); --apply chowns exactly those repo dirs.
//   bun tools/own-agent-repos.ts [ROOT] [--apply]      ROOT defaults to $DEVD_ROOT or /srv/dev
import { ownAgentRepos } from "../devd/src/agentRepos";
import { run } from "../devd/src/proc";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const rest = args.filter((a) => a !== "--apply");
if (rest.length > 1 || rest.some((a) => a.startsWith("-"))) throw new Error("Usage: bun tools/own-agent-repos.ts [ROOT] [--apply] (default: dry run)");
const root = rest[0] ?? process.env.DEVD_ROOT ?? "/srv/dev";
if (apply && process.getuid?.() !== 0) throw new Error("--apply needs root (chown)");

const report = await ownAgentRepos(root, {
  apply,
  chown: async (argv) => {
    const r = await run(argv, { timeoutMs: 30 * 60_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`${argv.join(" ")} failed: ${r.timedOut ? "timed out" : r.stderr.trim()}`);
  },
});
const dirty = report.filter((r) => r.foreign > 0);
for (const r of dirty) console.log(`${String(r.foreign).padStart(8)}  ${r.path}`);
const total = dirty.reduce((n, r) => n + r.foreign, 0);
console.log(`${report.length} agent repos, ${dirty.length} with ${total} entries not owned by the agent uid${apply ? " — chowned" : " (dry run; --apply to chown)"}`);
