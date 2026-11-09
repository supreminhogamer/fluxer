// SPDX-License-Identifier: AGPL-3.0-or-later
// Patch *only* the two daemon cases which require snap_daemon / setpriv.
// Fail closed if upstream Snap entrypoint changes; never run a silently broken patch.
import { readFile, writeFile, chmod } from 'node:fs/promises';

const postgres = `postgres)
    pgdata="$STATE/postgres/data"
    pgrun="$STATE/postgres/run"
    mkdir -p "$pgrun" "$STATE/postgres"
    [ "$(id -u)" != 0 ] || die "PostgreSQL refuses to run as root; configure external PostgreSQL"
    if [ ! -s "$pgdata/PG_VERSION" ]; then
        [ ! -e "$pgdata" ] || die "Existing PostgreSQL data directory is incomplete; refusing to overwrite"
        mkdir -p "$pgdata"
        chmod 700 "$pgdata"
        pwfile="$(mktemp)"
        chmod 600 "$pwfile"
        printf '%s' "$POSTGRES_PASSWORD" > "$pwfile"
        "$PG_BIN/initdb" -D "$pgdata" -U fluxer --pwfile="$pwfile" \\
            --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --locale=C.UTF-8
        rm -f "$pwfile"
    fi
    clear_ready postgres
    "$PG_BIN/postgres" -D "$pgdata" \\
        -c listen_addresses=127.0.0.1 -c port="$PORT_POSTGRES" \\
        -c unix_socket_directories="$pgrun" \\
        -c dynamic_shared_memory_type=mmap -c huge_pages=off \\
        -c max_connections="\${FLUXER_POSTGRES_SERVER_MAX_CONNECTIONS:-80}" \\
        -c shared_buffers="\${FLUXER_POSTGRES_SHARED_BUFFERS:-128MB}" \\
        -c effective_cache_size=512MB -c work_mem=4MB -c jit=off &
    pg=$!
    trap 'kill -TERM "$pg" 2>/dev/null || true' TERM INT
    for _ in $(seq 1 120); do
        "$PG_BIN/pg_isready" -q -h "$pgrun" -p "$PORT_POSTGRES" && break
        kill -0 "$pg" 2>/dev/null || die "PostgreSQL died during startup"
        sleep 1
    done
    "$PG_BIN/pg_isready" -q -h "$pgrun" -p "$PORT_POSTGRES" || die "PostgreSQL did not become ready"
    if ! "$PG_BIN/psql" -h "$pgrun" -p "$PORT_POSTGRES" -U fluxer -d postgres -Atc \\
        "SELECT 1 FROM pg_database WHERE datname = 'fluxer'" | grep -q 1; then
        "$PG_BIN/createdb" -h "$pgrun" -p "$PORT_POSTGRES" -U fluxer fluxer
    fi
    mark_ready postgres
    wait "$pg"
    ;;

`;
const valkey = `valkey)
    mkdir -p "$STATE/valkey"
    exec "$SNAP/usr/bin/valkey-server" --bind 127.0.0.1 --port "$PORT_VALKEY" --dir "$STATE/valkey" \\
        --appendonly yes --appendfsync everysec --save "" \\
        --maxmemory "\${FLUXER_VALKEY_MAXMEMORY:-192mb}" --maxmemory-policy noeviction \\
        --daemonize no --logfile ""
    ;;

`;
const remoteCheck = `wait_db() {
    for _ in $(seq 1 120); do
        PGCONNECT_TIMEOUT=5 "$PG_BIN/psql" "$FLUXER_POSTGRES_URL" -X -qAt -c 'SELECT 1' \\
            >/dev/null 2>&1 && return 0
        sleep 2
    done
    die "PostgreSQL connection timed out"
}

`;
export function patchService(original) {
  if (!original.includes('chown snap_daemon:snap_daemon') || !original.includes('as_daemon valkey-server')) {
    throw new Error('Snap service script layout changed; review the new upstream version before patching');
  }
  const first = original.indexOf('\npostgres)');
  const middle = original.indexOf('\nvalkey)', first);
  const last = original.indexOf('\nnats)', middle);
  if (first < 0 || middle < 0 || last < 0) throw new Error('Cannot find postgres/valkey/nats service cases');
  let patched = original.slice(0,first+1) + postgres + valkey + original.slice(last+1);
  if (!patched.includes('run_svc() {')) throw new Error('Cannot find run_svc function');
  patched = patched.replace('run_svc() {', remoteCheck+'run_svc() {');
  const checks = [
    ['[ "${4:-}" = postgres ] && wait_port "$PORT_POSTGRES" postgres', '[ "${4:-}" = postgres ] && wait_db'],
    ['    wait_port "$PORT_POSTGRES" postgres', '    wait_db'],
  ];
  for (const [before,after] of checks) {
    if (!patched.includes(before)) throw new Error(`Expected Postgres check missing: ${before}`);
    patched = patched.replaceAll(before, after);
  }
  return patched;
}
export async function writePatchedService(source, dest) {
  const contents = await readFile(source, 'utf8');
  await writeFile(dest, patchService(contents), {mode:0o700});
  await chmod(dest, 0o700);
}
