#!/usr/bin/env bash
# Provisions read-only access to one prod DB: RO role (+ optionally an RW role for
# human-approved writes) + storing the passwords in 1P. Safe to repeat. Run by an admin from the mac
# (has SSH to '*-root-hardened' + 'op'). The loopback docker bind is set in the Coolify UI
# (127.0.0.1:<host-port>:5432) separately — see the plan.
set -euo pipefail

SSH="" CID="" ENGINE="" DB="" ROUSER="" PORT="" OPITEM="" RWUSER="" RWOPITEM="" VAULT="" ROTATE=0
while [ $# -gt 0 ]; do case "$1" in
  --server) SSH="$2"; shift 2;;
  --container) CID="$2"; shift 2;;
  --engine) ENGINE="$2"; shift 2;;
  --db) DB="$2"; shift 2;;
  --ro-user) ROUSER="$2"; shift 2;;
  --host-port) PORT="$2"; shift 2;;
  --op-item) OPITEM="$2"; shift 2;;
  --rw-user) RWUSER="$2"; shift 2;;
  --rw-op-item) RWOPITEM="$2"; shift 2;;
  --op-vault) VAULT="$2"; shift 2;;
  --rotate) ROTATE=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done
# 1P items belong in the vault the devd service account reads from (e.g. "VPS shop").
VAULT_FLAG=(); [ -n "$VAULT" ] && VAULT_FLAG=(--vault "$VAULT")
for v in SSH CID ENGINE DB ROUSER PORT OPITEM; do [ -n "${!v}" ] || { echo "missing --$v" >&2; exit 2; }; done
[ -n "$RWUSER" ] && [ -z "$RWOPITEM" ] && { echo "--rw-user requires --rw-op-item" >&2; exit 2; }

# password: new with --rotate or when missing in 1P, otherwise the existing one
op_pw() { op item get "$1" "${VAULT_FLAG[@]}" --fields password --reveal 2>/dev/null || true; }
op_store() {
  local item="$1" pw="$2"
  if op item get "$item" "${VAULT_FLAG[@]}" >/dev/null 2>&1; then
    op item edit "$item" "${VAULT_FLAG[@]}" password="$pw" >/dev/null
  else
    op item create --category=password --title="$item" "${VAULT_FLAG[@]}" password="$pw" >/dev/null
  fi
}

# --- RO role -------------------------------------------------------------------
ROPW="$(op_pw "$OPITEM")"
if [ -z "$ROPW" ] || [ "$ROTATE" -eq 1 ]; then ROPW="$(openssl rand -hex 24)"; ROROT=1; else ROROT=0; fi

case "$ENGINE" in
  postgres)
    ssh "$SSH" "docker exec -i $CID psql -U \$(docker exec $CID printenv POSTGRES_USER) -d $DB -v ON_ERROR_STOP=0" <<SQL
CREATE ROLE $ROUSER LOGIN PASSWORD '$ROPW';
ALTER ROLE $ROUSER LOGIN PASSWORD '$ROPW';
GRANT CONNECT ON DATABASE $DB TO $ROUSER;
GRANT USAGE ON SCHEMA public TO $ROUSER;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO $ROUSER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO $ROUSER;
SQL
    ;;
  mysql|mariadb)
    ssh "$SSH" "docker exec -i $CID sh -lc 'mysql -u root -p\"\$MYSQL_ROOT_PASSWORD\"'" <<SQL
CREATE USER IF NOT EXISTS '$ROUSER'@'%' IDENTIFIED BY '$ROPW';
ALTER USER '$ROUSER'@'%' IDENTIFIED BY '$ROPW';
GRANT SELECT ON \`$DB\`.* TO '$ROUSER'@'%';
FLUSH PRIVILEGES;
SQL
    ;;
  *) echo "unknown engine $ENGINE" >&2; exit 2;;
esac
[ "$ROROT" -eq 1 ] && op_store "$OPITEM" "$ROPW"

# --- RW role (optional, DML without DDL) ------------------------------------------
if [ -n "$RWUSER" ]; then
  RWPW="$(op_pw "$RWOPITEM")"
  if [ -z "$RWPW" ] || [ "$ROTATE" -eq 1 ]; then RWPW="$(openssl rand -hex 24)"; RWROT=1; else RWROT=0; fi
  case "$ENGINE" in
    postgres)
      ssh "$SSH" "docker exec -i $CID psql -U \$(docker exec $CID printenv POSTGRES_USER) -d $DB -v ON_ERROR_STOP=0" <<SQL
CREATE ROLE $RWUSER LOGIN PASSWORD '$RWPW';
ALTER ROLE $RWUSER LOGIN PASSWORD '$RWPW';
GRANT CONNECT ON DATABASE $DB TO $RWUSER;
GRANT USAGE ON SCHEMA public TO $RWUSER;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $RWUSER;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $RWUSER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $RWUSER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $RWUSER;
SQL
      ;;
    mysql|mariadb)
      ssh "$SSH" "docker exec -i $CID sh -lc 'mysql -u root -p\"\$MYSQL_ROOT_PASSWORD\"'" <<SQL
CREATE USER IF NOT EXISTS '$RWUSER'@'%' IDENTIFIED BY '$RWPW';
ALTER USER '$RWUSER'@'%' IDENTIFIED BY '$RWPW';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`$DB\`.* TO '$RWUSER'@'%';
FLUSH PRIVILEGES;
SQL
      ;;
  esac
  [ "$RWROT" -eq 1 ] && op_store "$RWOPITEM" "$RWPW"
fi

echo "PROVISIONED $DB ($ENGINE) ro=$ROUSER${RWUSER:+ rw=$RWUSER} host-port=$PORT"
echo "NEXT: add the DB to image/prod-db/catalog.json and set the Coolify loopback bind 127.0.0.1:$PORT:<db-port>."
