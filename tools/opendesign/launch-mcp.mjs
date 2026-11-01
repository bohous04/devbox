// Discover the installed OpenDesign instance in either GUI or headless mode.
// The application SDK supplies the URL; no ephemeral port or IPC path is stored.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const app = '/Applications/Open Design.app';
const req = createRequire(`${app}/Contents/Resources/app/package.json`);
const { getSidecarStatus } = await import(req.resolve('@open-design/sidecar'));
const stamp = { app: 'daemon', channel: 'stable', namespace: 'release-stable', source: 'packaged' };
async function discover() {
  for (const mode of ['runtime', 'headless']) {
    try {
      const state = await getSidecarStatus({ ...stamp, mode }, { timeoutMs: 500 });
      if (state.state !== 'running' || typeof state.url !== 'string') continue;
      const url = new URL(state.url);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) continue;
      const health = await fetch(`${url.origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (health.ok) return url.origin;
    } catch {}
  }
  return null;
}
let url = await discover();
if (!url) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith('OD_SIDECAR_')) delete env[key];
  const launch = spawn('/usr/bin/open', ['-g', '-j', app, '--args', '--headless'], { env, stdio: 'ignore' });
  await new Promise((resolve, reject) => { launch.once('error', reject); launch.once('exit', code => code === 0 ? resolve() : reject(new Error(`OpenDesign launch failed (${code})`))); });
  const deadline = Date.now() + 60000;
  while (!url && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    url = await discover();
  }
}
if (!url) throw new Error('The installed OpenDesign daemon did not become healthy.');
const child = spawn(process.execPath, [`${app}/Contents/Resources/app/prebundled/daemon/daemon-cli.mjs`, 'mcp', '--daemon-url', url], { env: process.env, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
