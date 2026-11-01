import { expect, test } from "bun:test";
import { openDb } from "../src/db";
import { resolveDbAdminTarget } from "../src/dbAdminTarget";
import { activateApproval, createApproval, decideApproval } from "../src/sshApprovals";

const server = { host: "192.0.2.42", port: 2222, user: "main", key: "prod-tunnel-acme" };
const now = 1_700_000_000_000;
function fixture() {
  const db = openDb(":memory:");
  const add = (title: string, target: string, status = "activated", decidedBy: string | null = "dashboard") => {
    const id = createApproval(db, { session: "fixture", title, target, why: "Isolated historical SSH fixture", project: "apps-invoice-creator" }, now);
    if (status !== "pending") {
      decideApproval(db, id, { status: "approved", by: "dashboard" }, now + 1);
      if (status === "activated") activateApproval(db, id, "fixture", now + 2);
      else db.query("UPDATE ssh_approvals SET status=? WHERE id=?").run(status, id);
    }
    db.query("UPDATE ssh_approvals SET decided_by=? WHERE id=?").run(decidedBy, id);
    return id;
  };
  return { db, add };
}

test("unique activated human decision resolves key+user for exact host or catalog name, trimming only outer whitespace", () => {
  const { db, add } = fixture();
  try {
    add(" VPS Acme administrator ", " root@192.0.2.42 ");
    add("VPS Acme administrator", "root@acme");
    expect(resolveDbAdminTarget(db, "acme", server)).toEqual({ title: "VPS Acme administrator", user: "root" });
    add("malicious", "root @192.0.2.42");
    expect(resolveDbAdminTarget(db, "acme", server)?.title).toBe("VPS Acme administrator");
  } finally { db.close(); }
});

test("ambiguous title or remote user fails closed", () => {
  for (const target of ["root@acme", "main@acme"]) {
    const { db, add } = fixture();
    try {
      add("first-key", "root@192.0.2.42"); add(target.startsWith("main") ? "first-key" : "second-key", target);
      expect(resolveDbAdminTarget(db, "acme", server)).toBeUndefined();
    } finally { db.close(); }
  }
});

test("wrong server, project name, unspecified SSH user and command-like targets are ignored", () => {
  const { db, add } = fixture();
  try {
    for (const target of ["root@192.0.2.43", "root@apps-invoice-creator", "acme", "root@acme;id", "root@acme -p 2222"]) add("admin-key", target);
    expect(resolveDbAdminTarget(db, "acme", server)).toBeUndefined();
  } finally { db.close(); }
});

test("pending, denied, revoked, unactivated and non-human rows do not establish admin identity", () => {
  const { db, add } = fixture();
  try {
    for (const status of ["pending", "denied", "revoked", "approved", "expired"]) add("admin-key", "root@acme", status);
    add("admin-key", "root@acme", "activated", null);
    add("admin-key", "root@acme", "activated", "agent");
    add("prod-tunnel-acme", "root@acme");
    expect(resolveDbAdminTarget(db, "acme", server)).toBeUndefined();
  } finally { db.close(); }
});

test("historical identity does not transfer expired grant authority or mutate approval state", () => {
  const { db, add } = fixture();
  try {
    add("admin-key", "root@acme");
    const before = db.query("SELECT * FROM ssh_approvals").all();
    expect(resolveDbAdminTarget(db, "acme", server)).toEqual({ title: "admin-key", user: "root" });
    expect(db.query("SELECT * FROM ssh_approvals").all()).toEqual(before);
    expect(db.query("SELECT grant_until FROM ssh_approvals").get()).toEqual({ grant_until: null });
  } finally { db.close(); }
});
