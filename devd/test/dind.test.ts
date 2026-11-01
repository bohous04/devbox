import { expect, test } from "bun:test";
import { dindCleanupPlan, dindEnsurePlan, dindName, dindNetwork, dindNetworkCreate, dindRunArgs, dindSubnetCandidates, dindVolume, dockerHostFor } from "../src/dind";

test("names are derived from the session, not random", () => {
  expect(dindName("dev-shop-web")).toBe("dind-dev-shop-web");
  expect(dindNetwork("dev-shop-web")).toBe("dind-net-dev-shop-web");
  expect(dindVolume("dev-shop-web")).toBe("dind-dev-shop-web-data");
});

test("sidecar runs privileged, but WITHOUT published ports on the host", () => {
  const a = dindRunArgs("dev-shop-web");
  expect(a).toContain("--privileged");
  expect(a.join(" ")).not.toContain(" -p ");
});

test("layers go to their own volume so images are not pulled after every restart", () => {
  expect(dindRunArgs("dev-x-y").join(" ")).toContain("dind-dev-x-y-data:/var/lib/docker");
});

test("TLS is off — the sidecar network does not leave the session bridge", () => {
  expect(dindRunArgs("dev-x-y").join(" ")).toContain("DOCKER_TLS_CERTDIR=");
});

test("sidecar has NO access to the host socket", () => {
  expect(dindRunArgs("dev-x-y").join(" ")).not.toContain("/var/run/docker.sock");
});

test("session container points at the sidecar, not the host", () => {
  expect(dockerHostFor("dev-x-y")).toBe("tcp://dind-dev-x-y:2375");
});

test("end session removes the sidecar, network and data", () => {
  expect(dindCleanupPlan("dev-x-y", { keepData: false })).toEqual([
    ["docker", "rm", "-f", "dind-dev-x-y"],
    ["docker", "network", "rm", "dind-net-dev-x-y"],
    ["docker", "volume", "rm", "dind-dev-x-y-data"],
  ]);
});

test("stop session stops the sidecar but keeps the data", () => {
  expect(dindCleanupPlan("dev-x-y", { keepData: true })).toEqual([["docker", "stop", "dind-dev-x-y"]]);
});

// Regression: dindEnsurePlan returned a command starting with "run", not "docker run", so
// sh() tried to run a `run` binary and the sidecar was never created — the session then started
// with DOCKER_HOST pointing at nothing.
test("all commands in the plans are complete, i.e. start with docker", () => {
  const plans = [dindNetworkCreate("dev-x-y", "10.213.0.0/24"), ...dindEnsurePlan("dev-x-y"), ...dindCleanupPlan("dev-x-y", { keepData: false }), ...dindCleanupPlan("dev-x-y", { keepData: true })];
  for (const cmd of plans) expect(cmd[0]).toBe("docker");
});

// Regression: dockerd 27 listening on TCP without TLS deliberately sleeps 15 s ("Startup is
// intentionally being slowed down to show this message") unless you explicitly pass
// --tls=false. The sidecar took 17.7 s instead of 2.5 s to start and the session open() waited for it.
// The flag must come AFTER the image — it goes to the entrypoint's `"$@"`, i.e. dockerd, not `docker run`.
test("dockerd in the sidecar gets an explicit --tls=false, otherwise it deliberately sleeps 15 s", () => {
  const a = dindRunArgs("dev-x-y");
  const image = a.findIndex((x) => x.startsWith("docker:"));
  expect(image).toBeGreaterThan(0);
  expect(a.slice(image + 1)).toContain("--tls=false");
});

test("sidecar has the same memory cap as the session — its containers count towards it", () => {
  const a = dindRunArgs("dev-x-y").join(" ");
  expect(a).toContain("--memory 15g");
  expect(a).toContain("--memory-swap 35g");
});

// Regression: without --subnet docker took networks from the default pools (~30 networks). With 25 sessions
// and a few compose projects they ran out and a new session failed with "fully subnetted".
test("session network has its own subnet outside docker's default pools", () => {
  expect(dindNetworkCreate("dev-x-y", "10.213.7.0/24")).toEqual(["docker", "network", "create", "--subnet", "10.213.7.0/24", "dind-net-dev-x-y"]);
  const c = dindSubnetCandidates("dev-x-y");
  expect(c).toHaveLength(256);
  expect(new Set(c).size).toBe(256);
  for (const s of c) expect(s).toMatch(/^10\.213\.\d{1,3}\.0\/24$/);
  expect(dindSubnetCandidates("dev-x-y")).toEqual(c);
});
