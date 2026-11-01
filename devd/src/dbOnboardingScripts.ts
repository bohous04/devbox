import { mariaInspectionCommand } from "./mariaDbOnboarding";
/** Templates for the fixed onboarding executor. No arbitrary commands from an
 * agent are inserted. All interpolated names are validated by validateHostPlan. */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { OnboardingPlan } from "./dbOnboarding";
export interface TargetInspection {
  running: boolean; image: string; networks: Record<string, { IPAddress?: string }>;
  ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
  remotePortBusy: boolean; relayManaged: boolean; systemd: boolean; proxyBinary: string; sshd: boolean;
  missingTools: string[];
  tunnelUserConflict: boolean; sshEffective: string; sshInclude: boolean; sshScopedAllow: boolean; clientAddress: string;
  database: null | { db: string; owner: string; ownerSafe: boolean; ownerOwnsTables: boolean; publicReadOnlySafe?: boolean; roles: { name: string; managed: boolean }[] };
}
const q = (v: string): string => `'${v.replaceAll("'", "'\\''")}'`;
const lit = (v: string): string => `'${v.replaceAll("'", "''")}'`;
const ident = (v: string): string => `"${v.replaceAll('"', '""')}"`;
const marker = (p: OnboardingPlan): string => `devd-db:${p.entry.server}:${p.entry.db}`;
const roleMarker = (p: OnboardingPlan, role: string): string => {
  const item = role === p.entry.roUser ? p.entry.opItem : role === p.entry.rwUser ? p.entry.rwOpItem : p.entry.migrationOpItem;
  return `${marker(p)}:${role}:${createHash("sha256").update(item ?? "").digest("hex").slice(0, 24)}`;
};

/** Check the fixed prerequisites before approval and before changing a host. */
export function onboardingDependencyScript(): string {
  return `missing_tools=''
for tool in docker systemctl ss sshd flock useradd usermod getent install grep sed awk base64 tr mktemp cat cp rm chmod chown id; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools="\${missing_tools}\${missing_tools:+,}$tool"
done
test -x /usr/sbin/nologin || missing_tools="\${missing_tools}\${missing_tools:+,}/usr/sbin/nologin"
proxy_binary=''
for candidate in /usr/lib/systemd/systemd-socket-proxyd /lib/systemd/systemd-socket-proxyd; do
  if test -x "$candidate"; then proxy_binary="$candidate"; break; fi
done
if [ -z "$proxy_binary" ]; then
  missing_tools="\${missing_tools}\${missing_tools:+,}systemd-socket-proxyd"
elif ! "$proxy_binary" --help 2>/dev/null | grep -q -- '--exit-idle-time'; then
  missing_tools="\${missing_tools}\${missing_tools:+,}systemd-socket-proxyd>=246"
fi
printf 'MISSING_TOOLS=%s\\n' "$missing_tools"
`;
}

/** useradd writes ownership in the same passwd record as the new user. A later
 * filesystem marker cannot identify an account after interrupted creation. */
export function onboardingAccountIdentityScript(p: OnboardingPlan): string {
  const ownership = `devd-db-tunnel-${createHash("sha256").update(JSON.stringify([p.entry.server, p.server.host, p.server.port, p.server.user])).digest("hex").slice(0, 24)}`;
  return `managed_user=/var/lib/${p.server.user}
account_marker=${q(ownership)}
devd_account_owned() {
  local record account password uid gid comment home shell groups group_record group_name group_password group_id members
  record=$(getent passwd ${q(p.server.user)}) || return 1
  IFS=: read -r account password uid gid comment home shell <<< "$record"
  [ "$account" = ${q(p.server.user)} ] && [ "$comment" = "$account_marker" ] && [ "$home" = "$managed_user" ] && [ "$shell" = /usr/sbin/nologin ] || return 1
  case "$uid:$gid" in *[!0-9:]*|:*|*:) return 1;; esac
  [ "$uid" -gt 0 ] && [ "$gid" -gt 0 ] || return 1
  group_record=$(getent group ${q(p.server.user)}) || return 1
  IFS=: read -r group_name group_password group_id members <<< "$group_record"
  [ "$group_name" = ${q(p.server.user)} ] && [ "$group_id" = "$gid" ] || return 1
  groups=$(id -G ${q(p.server.user)}) || return 1
  [ "$groups" = "$gid" ] || return 1
  [ ! -L "$managed_user" ]
}
`;
}

export function onboardingAccountSetupScript(p: OnboardingPlan): string {
  return `${onboardingAccountIdentityScript(p)}
if getent passwd ${q(p.server.user)} >/dev/null; then
  devd_account_owned || { echo BLOCK:tunnel_user_conflict; exit 1; }
else
  # Refuse pre-existing homes/groups instead of claiming unrelated resources.
  if [ -e "$managed_user" ] || [ -L "$managed_user" ] || getent group ${q(p.server.user)} >/dev/null; then echo BLOCK:tunnel_user_conflict; exit 1; fi
  useradd --system --user-group --create-home --home-dir "$managed_user" --shell /usr/sbin/nologin --comment "$account_marker" ${q(p.server.user)}
  devd_account_owned || { echo BLOCK:tunnel_user_conflict; exit 1; }
fi
# Finish these steps after interruption immediately following useradd, too.
# '*' cannot authenticate with a password, without disabling public-key login.
usermod --password '*' ${q(p.server.user)}
install -d -o root -g root -m 0755 "$managed_user"
[ ! -L "$managed_user/.devd-managed" ] || { echo BLOCK:tunnel_user_conflict; exit 1; }
install -m 0600 /dev/null "$managed_user/.devd-managed"
`;
}

export function onboardingInspectionScript(p: OnboardingPlan): string {
  const cid = q(p.input.container); const name = p.entry.name;
  const roles = [p.entry.roUser, p.entry.rwUser, p.entry.migrationUser].filter((x): x is string => !!x);
  const sql = `SELECT json_build_object('db', d.datname, 'owner', o.rolname,
'ownerSafe', NOT (o.rolsuper OR o.rolcreaterole OR o.rolcreatedb OR o.rolreplication OR o.rolbypassrls) AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=o.oid) AND NOT EXISTS(SELECT 1 FROM pg_database other WHERE other.datdba=o.oid AND other.datname<>current_database()) AND NOT EXISTS(SELECT 1 FROM pg_shdepend dep WHERE dep.refclassid='pg_authid'::regclass AND dep.refobjid=o.oid AND dep.dbid NOT IN(0,d.oid)),
'ownerOwnsTables', NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') AND c.relowner <> o.oid${p.entry.migrationUser ? ` AND c.relowner <> COALESCE((SELECT oid FROM pg_roles WHERE rolname=${lit(p.entry.migrationUser)}),0)` : ""}),
'publicReadOnlySafe', NOT EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND a.grantee=0 AND a.privilege_type='CREATE')
AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) a WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND f.prosecdef AND a.grantee=0 AND a.privilege_type='EXECUTE')
AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('s',c.relowner))) a WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND a.grantee=0 AND a.privilege_type IN ('USAGE','UPDATE')),
'roles', COALESCE((SELECT json_agg(json_build_object('name', r.rolname, 'managed', COALESCE(shobj_description(r.oid, 'pg_authid'), '') = CASE r.rolname ${roles.map(role => `WHEN ${lit(role)} THEN ${lit(roleMarker(p, role))}`).join(' ')} ELSE '' END)) FROM pg_roles r WHERE r.rolname IN (${roles.map(lit).join(",")})), '[]'::json)) FROM pg_database d JOIN pg_roles o ON o.oid=d.datdba WHERE d.datname=current_database();`;
  return `set -eu
${onboardingDependencyScript()}
[ -z "$missing_tools" ] || exit 0
[ "$(id -u)" = 0 ] || { echo BLOCK:admin_privileges; exit 1; }
${onboardingAccountIdentityScript(p)}
printf 'RUNNING='; docker inspect --format '{{json .State.Running}}' ${cid} 2>/dev/null || true
printf 'IMAGE='; docker inspect --format '{{json .Config.Image}}' ${cid} 2>/dev/null || true
printf 'NETWORKS='; docker inspect --format '{{json .NetworkSettings.Networks}}' ${cid} 2>/dev/null || true
printf 'PORTS='; docker inspect --format '{{json .NetworkSettings.Ports}}' ${cid} 2>/dev/null || true
printf 'PORT_BUSY='; if ss -H -ltn 'sport = :${p.entry.hostPort}' | grep -q .; then echo yes; else echo no; fi
printf 'RELAY_MANAGED='; if [ ! -L /etc/systemd/system/devd-db-${name}.socket ] && grep -Fqx ${q("# " + marker(p))} /etc/systemd/system/devd-db-${name}.socket 2>/dev/null; then echo yes; else echo no; fi
printf 'SYSTEMD='; if test -d /run/systemd/system && command -v systemctl >/dev/null && command -v ss >/dev/null; then echo yes; else echo no; fi
printf 'PROXY_BINARY=%s\\n' "$proxy_binary"
printf 'SSHD='; if command -v sshd >/dev/null && test -d /etc/ssh/sshd_config.d; then echo yes; else echo no; fi
connection=\${DEVD_SSH_CONNECTION:-\${SSH_CONNECTION:-}}
client_addr=\${connection%% *}
printf 'CLIENT_ADDRESS=%s\\n' "$client_addr"
printf 'SSH_EFFECTIVE='; sshd -T -C "user=${p.server.user},host=$client_addr,addr=$client_addr" 2>/dev/null | grep -E '^(allowusers|denyusers|allowgroups|denygroups|authenticationmethods|authorizedkeysfile|pubkeyauthentication) ' | base64 | tr -d '\\n'; echo
# Test a scoped AllowUsers extension against the actual config without editing
# any live sshd file. Global root/main-only AllowUsers need no manual change.
probe=$(mktemp /run/devd-db-sshd-probe.XXXXXX)
trap 'rm -f "$probe"' EXIT
cat /etc/ssh/sshd_config > "$probe"
printf '\\nMatch User ${p.server.user}\\n    AllowUsers ${p.server.user}\\nMatch all\\n' >> "$probe"
printf 'SSH_SCOPED_ALLOW='; if sshd -t -f "$probe" 2>/dev/null && sshd -T -f "$probe" -C "user=${p.server.user},host=$client_addr,addr=$client_addr" 2>/dev/null | grep -Fqx 'allowusers ${p.server.user}'; then echo yes; else echo no; fi
printf 'SSH_INCLUDE='; if grep -Eq '^[[:space:]]*Include[[:space:]].*/etc/ssh/sshd_config[.]d/' /etc/ssh/sshd_config; then echo yes; else echo no; fi
printf 'USER_CONFLICT='; if getent passwd ${q(p.server.user)} >/dev/null; then
  if devd_account_owned; then echo no; else echo yes; fi
elif [ -e "$managed_user" ] || [ -L "$managed_user" ] || getent group ${q(p.server.user)} >/dev/null; then echo yes; else echo no; fi
${p.entry.engine === "mariadb" ? mariaInspectionCommand(p) : `printf 'DATABASE='; docker exec ${cid} sh -c ${q(`exec psql -X -h /var/run/postgresql -A -t -v ON_ERROR_STOP=1 -U "\${POSTGRES_USER:-postgres}" -d ${q(p.entry.db)} -c ${q(sql)}`)} 2>/dev/null || echo null`}
`;
}

export function onboardingInstallScript(p: OnboardingPlan, publicKey: string, ports: number[]): string {
  const user = p.server.user; const name = p.entry.name; const cid = p.input.container; const hp = p.entry.hostPort;
  const keyOptions = ['restrict', 'port-forwarding', ...ports.map(port => `permitopen="127.0.0.1:${port}"`), 'command="/bin/false"'].join(',');
  const authorized = `${keyOptions} ${publicKey} devd-managed-${p.entry.server}`;
  const sshConfig = `# devd-managed ${user}\nMatch User ${user}\n    AllowUsers ${user}\n    AuthenticationMethods publickey\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n    AllowTcpForwarding local\n    AllowStreamLocalForwarding no\n    AllowAgentForwarding no\n    PermitTTY no\n    X11Forwarding no\n    PermitUserRC no\n    PermitOpen ${ports.map(port => `127.0.0.1:${port}`).join(" ")}\n    ForceCommand /bin/false\nMatch all\n`;
  const socket = `# ${marker(p)}\n[Unit]\nDescription=Devbox loopback DB relay ${name}\n[Socket]\nListenStream=127.0.0.1:${hp}\nNoDelay=true\n[Install]\nWantedBy=sockets.target\n`;
  // Resolve Docker's current network address each time socket activation starts
  // the service. No remote database credentials are read by the relay.
  const relayScript = `#!/bin/sh\n# ${marker(p)}\nset -eu\nip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{.IPAddress}} {{end}}{{end}}' ${q(cid)} | awk '{print $1}')\ncase "$ip" in ''|*[!0-9.]*) exit 1;; esac\nexec /usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=5s "$ip:${p.entry.engine === "mariadb" ? 3306 : 5432}"\n`;
  const service = `# ${marker(p)}\n[Unit]\nDescription=Devbox DB relay ${name}\nAfter=docker.service\nRequires=devd-db-${name}.socket\n[Service]\nType=notify\nExecStart=/usr/local/libexec/devd-db-${name}\nPrivateTmp=true\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\n`;
  return `set -eu
${onboardingDependencyScript()}
[ -z "$missing_tools" ] || { echo BLOCK:host_tools_missing; exit 1; }
[ "$(id -u)" = 0 ] || { echo BLOCK:admin_privileges; exit 1; }
umask 077
connection=\${DEVD_SSH_CONNECTION:-\${SSH_CONNECTION:-}}
# Serialize target-side changes too, including retries after a devd restart.
exec 9>/run/lock/devd-db-onboarding.lock
flock -x 9
${onboardingAccountSetupScript(p)}
[ ! -L "$managed_user/.ssh" ] || { echo BLOCK:tunnel_user_conflict; exit 1; }
install -d -o root -g root -m 0755 "$managed_user/.ssh"
[ ! -L "$managed_user/.ssh/authorized_keys" ] || { echo BLOCK:tunnel_user_conflict; exit 1; }
printf '%s\\n' ${q(authorized)} > "$managed_user/.ssh/authorized_keys"
chmod 0644 "$managed_user/.ssh/authorized_keys"
chown root:root "$managed_user/.ssh/authorized_keys"
config=/etc/ssh/sshd_config.d/90-devd-db-${user}.conf
[ ! -L "$config" ] || { echo BLOCK:sshd_config; exit 1; }
if [ -e "$config" ]; then grep -Fqx ${q("# devd-managed " + user)} "$config" || { echo BLOCK:sshd_config; exit 1; }; fi
scratch=$(mktemp -d /run/devd-db-ssh.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
if [ -f "$config" ]; then cp "$config" "$scratch/old"; fi
printf '%s' ${q(sshConfig)} > "$config"
check_config() {
  sshd -t >/dev/null 2>&1 || return 1
  sshd -T -C "user=${user},host=\${connection%% *},addr=\${connection%% *}" > "$scratch/effective" 2>/dev/null || return 1
  grep -Fqx 'allowtcpforwarding local' "$scratch/effective" && grep -Fqx 'allowstreamlocalforwarding no' "$scratch/effective" && grep -Fqx 'forcecommand /bin/false' "$scratch/effective"
}
if ! check_config; then
  if [ -f "$scratch/old" ]; then cp "$scratch/old" "$config"; else rm -f "$config"; fi
  echo BLOCK:sshd_config; exit 1
fi
if ! systemctl reload ssh.service >/dev/null 2>&1 && ! systemctl reload sshd.service >/dev/null 2>&1; then
  if [ -f "$scratch/old" ]; then cp "$scratch/old" "$config"; else rm -f "$config"; fi
  echo BLOCK:sshd_config; exit 1
fi
# An existing exact loopback Docker mapping already serves the target. A relay
# is needed only when Docker has no matching bind; do not restart its database.
bindings=$(docker inspect --format '{{range (index .NetworkSettings.Ports "${p.entry.engine === "mariadb" ? 3306 : 5432}/tcp")}}{{.HostIp}}:{{.HostPort}} {{end}}' ${q(cid)})
if ! printf '%s\\n' "$bindings" | tr ' ' '\\n' | grep -Fqx '127.0.0.1:${hp}'; then
  unit=/etc/systemd/system/devd-db-${name}
  if ss -H -ltn 'sport = :${hp}' | grep -q .; then
    grep -Fqx ${q("# " + marker(p))} "$unit.socket" 2>/dev/null && systemctl is-active --quiet devd-db-${name}.socket || { echo BLOCK:relay_conflict; exit 1; }
  fi
  for file in "$unit.socket" "$unit.service" /usr/local/libexec/devd-db-${name}; do
    [ ! -L "$file" ] || { echo BLOCK:relay_conflict; exit 1; }
    if [ -e "$file" ]; then grep -Fqx ${q("# " + marker(p))} "$file" || { echo BLOCK:relay_conflict; exit 1; }; fi
  done
  install -d -m 0755 /usr/local/libexec
  printf '%s' ${q(socket)} > "$unit.socket"
  printf '%s' ${q(service)} > "$unit.service"
  printf '%s' ${q(relayScript)} > /usr/local/libexec/devd-db-${name}
  if [ ! -x /usr/lib/systemd/systemd-socket-proxyd ]; then sed -i 's@/usr/lib/systemd/systemd-socket-proxyd@/lib/systemd/systemd-socket-proxyd@' /usr/local/libexec/devd-db-${name}; fi
  chmod 0755 /usr/local/libexec/devd-db-${name}
  chmod 0644 "$unit.socket" "$unit.service"
  systemctl daemon-reload
  systemctl enable --now devd-db-${name}.socket >/dev/null
  systemctl is-active --quiet devd-db-${name}.socket
fi
printf 'INSTALLED\\n'
`;
}

/** PostgreSQL accepts a SCRAM verifier in CREATE/ALTER ROLE PASSWORD. Only this
 * one-way verifier crosses SSH, never the plaintext generated by 1Password. */
export function scramVerifier(password: string, salt = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

export function onboardingRoleSql(p: OnboardingPlan, passwords: Record<string, string>): string {
  const e = p.entry; const db = ident(e.db);
  const roles: [string, "read" | "write" | "migration"][] = [[e.roUser, "read"]];
  if (e.rwUser) roles.push([e.rwUser, "write"]);
  if (e.migrationUser) roles.push([e.migrationUser, "migration"]);
  const statements = ["SET log_statement = 'none';", "SET log_min_error_statement = 'panic';", "SET pgaudit.log = 'none';", "SET standard_conforming_strings = on;", "BEGIN;", `SELECT pg_advisory_xact_lock(hashtextextended(${lit(marker(p))}, 0));`];
  for (const [user, mode] of roles) {
    const role = ident(user); const mark = lit(roleMarker(p, user));
    const password = passwords[user];
    if (!password) throw new Error("The host password for the role is missing.");
    const verifier = lit(scramVerifier(password));
    statements.push(`DO $devd$ BEGIN
IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${lit(user)}) THEN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${lit(user)} AND shobj_description(oid,'pg_authid')=${mark}) THEN RAISE EXCEPTION 'devd role_conflict'; END IF;
ELSE
 CREATE ROLE ${role} LOGIN;
 COMMENT ON ROLE ${role} IS ${mark};
END IF;
END $devd$;`);
    statements.push(`ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${verifier};`);
    if (mode !== "migration") {
      statements.push(`DO $devd$ BEGIN IF EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.member WHERE r.rolname=${lit(user)}) THEN RAISE EXCEPTION 'devd role_conflict membership'; END IF; END $devd$;`);
      statements.push(`GRANT CONNECT ON DATABASE ${db} TO ${role};`, `GRANT USAGE ON SCHEMA public TO ${role};`);
      if (mode === "read") statements.push(`ALTER ROLE ${role} SET default_transaction_read_only=on;`, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};`);
      else statements.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};`, `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};`);
      // Default privileges are scoped to each actual object owner, plus the DB
      // owner and the explicit migration role that may create future tables.
      const grants = mode === "read" ? "SELECT" : "SELECT, INSERT, UPDATE, DELETE";
      statements.push(`DO $devd$ DECLARE owner_name text; BEGIN FOR owner_name IN SELECT DISTINCT name FROM (SELECT pg_get_userbyid(c.relowner) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' UNION SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) owners LOOP EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT ${grants} ON TABLES TO %I', owner_name, ${lit(user)}); ${mode === "write" ? `EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', owner_name, ${lit(user)});` : ""} END LOOP; END $devd$;`);
    } else {
      statements.push(`DO $devd$ DECLARE owner_row record; BEGIN
SELECT r.* INTO owner_row FROM pg_roles r JOIN pg_database d ON d.datdba=r.oid WHERE d.datname=current_database();
IF owner_row.rolsuper OR owner_row.rolcreaterole OR owner_row.rolcreatedb OR owner_row.rolreplication OR owner_row.rolbypassrls OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=owner_row.oid) OR EXISTS(SELECT 1 FROM pg_database WHERE datdba=owner_row.oid AND datname<>current_database()) OR EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=owner_row.oid AND dbid NOT IN(0,(SELECT oid FROM pg_database WHERE datname=current_database()))) THEN RAISE EXCEPTION 'devd ddl_owner'; END IF;
IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') AND c.relowner <> owner_row.oid AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname=${lit(user)})) THEN RAISE EXCEPTION 'devd ddl_owner'; END IF;
IF EXISTS(SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.member WHERE r.rolname=${lit(user)} AND a.roleid<>owner_row.oid) THEN RAISE EXCEPTION 'devd role_conflict'; END IF;
EXECUTE format('GRANT %I TO %I',owner_row.rolname,${lit(user)});
END $devd$;`);
    }
  }
  if (e.migrationUser) {
    statements.push(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(e.migrationUser)} IN SCHEMA public GRANT SELECT ON TABLES TO ${ident(e.roUser)};`);
    if (e.rwUser) statements.push(`ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(e.migrationUser)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(e.rwUser)};`, `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(e.migrationUser)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident(e.rwUser)};`);
  }
  statements.push("COMMIT;");
  return statements.join("\n");
}

export function onboardingVerifySql(p: OnboardingPlan): string {
  return `SELECT (
 current_database()=${lit(p.entry.db)} AND current_user=${lit(p.entry.roUser)}
 AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 AND NOT has_database_privilege(current_user,current_database(),'CREATE')
 AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_' AND has_schema_privilege(current_user,n.oid,'CREATE'))
 AND NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND f.prosecdef AND has_function_privilege(current_user,f.oid,'EXECUTE'))
 AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='S' AND n.nspname NOT IN ('pg_catalog','information_schema') AND has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE'))
 AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)))
 AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND NOT has_table_privilege(current_user,c.oid,'SELECT'))
 AND current_setting('default_transaction_read_only')='on'
) AS verified;`;
}

export function onboardingWriteVerifySql(p: OnboardingPlan, role: string, migration: boolean): string {
  return `SELECT (
 current_database()=${lit(p.entry.db)} AND current_user=${lit(role)}
 AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
 ${migration ? `AND EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database() AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls) AND pg_has_role(current_user,r.oid,'USAGE'))
 AND has_schema_privilege(current_user,'public','CREATE')
 AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') AND NOT pg_has_role(current_user,c.relowner,'USAGE'))` : `AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user))
 AND NOT has_database_privilege(current_user,current_database(),'CREATE')
 AND NOT has_schema_privilege(current_user,'public','CREATE')
 AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (NOT has_table_privilege(current_user,c.oid,'SELECT') OR NOT has_table_privilege(current_user,c.oid,'INSERT') OR NOT has_table_privilege(current_user,c.oid,'UPDATE') OR NOT has_table_privilege(current_user,c.oid,'DELETE')))`}
) AS verified;`;
}
