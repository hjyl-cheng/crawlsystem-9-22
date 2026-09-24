#!/usr/bin/env python3
"""Repair infra-outbox CDC after its logical slot was invalidated, and add a heartbeat.

2026-09-23: the slot only advanced on outbox changes; WAL from every other database
accumulated until max_slot_wal_keep_size (4 GiB) invalidated it (wal_status=lost) and
the Debezium task failed. Fix: heartbeat topic + ACL, a heartbeat table inside the
publication (not in table.include.list), heartbeat config, then recreate the slot.

Default is a read-only plan. `--apply` performs it. Outbox rows written while the
slot was lost are recovered by a fresh snapshot of the outbox table (offsets reset),
so consumers see duplicates, never gaps; outbox consumers must be idempotent anyway."""
import json, sys, time, urllib.request
from infra_common import ROOT, k, obj, pg_primary, sql, forward

HEARTBEAT = {
    'heartbeat.interval.ms': '60000',
    'topic.heartbeat.prefix': 'infra-heartbeat',
    'heartbeat.action.query': "INSERT INTO publication.debezium_heartbeat(id, beat_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET beat_at = EXCLUDED.beat_at",
}
SQL = """
CREATE TABLE IF NOT EXISTS publication.debezium_heartbeat(id smallint PRIMARY KEY CHECK (id = 1), beat_at timestamptz NOT NULL);
ALTER TABLE publication.debezium_heartbeat OWNER TO crawler_owner;
GRANT SELECT, INSERT, UPDATE ON publication.debezium_heartbeat TO dbz_svc;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM pg_publication_tables WHERE pubname='infra_outbox_pub' AND tablename='debezium_heartbeat') THEN
   ALTER PUBLICATION infra_outbox_pub ADD TABLE publication.debezium_heartbeat;
 END IF;
END $$;
"""
SLOT = "SELECT coalesce(json_agg(json_build_object('active',active,'wal_status',wal_status,'retained_bytes',pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn))),'[]') FROM pg_replication_slots WHERE slot_name='infra_outbox_slot'"

def connect(port, method, path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', method=method, data=None if body is None else json.dumps(body).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read(); return json.loads(raw) if raw else None

def slot(primary):
    rows = json.loads(sql(primary, 'postgres', SLOT)); return rows[0] if rows else None

def status(port):
    s = connect(port, 'GET', '/connectors/infra-outbox/status'); return s['connector']['state'], [t['state'] for t in s['tasks']]

def main(apply):
    primary = pg_primary()
    with forward('kafka', 'svc/debezium-connect', 8083) as port:
        config = connect(port, 'GET', '/connectors/infra-outbox/config')
        plan = {'primary': primary, 'slot': slot(primary), 'connector': status(port),
                'missing_heartbeat_config': sorted(key for key in HEARTBEAT if config.get(key) != HEARTBEAT[key])}
        print(json.dumps({'plan': plan}, ensure_ascii=False))
        if not apply: return
        # 1. Heartbeat topic + ACL (auto topic creation is disabled; ACLs are literal).
        k('apply', '-f', str(ROOT / 'manifests/31-topics-users.yaml'))
        k('-n', 'kafka', 'wait', '--for=condition=Ready', 'kafkatopic/infra-heartbeat-infra-cdc', 'kafkauser/dbz-connect', '--timeout=180s')
        # 2. Heartbeat table inside the publication.
        sql(primary, 'infra_smoke', SQL)
        # 3. Stop the task, drop only an invalidated inactive slot, add heartbeat config, restart.
        connect(port, 'PUT', '/connectors/infra-outbox/pause'); time.sleep(5)
        current = slot(primary)
        if current and current['wal_status'] == 'lost' and not current['active']:
            sql(primary, 'postgres', "SELECT pg_drop_replication_slot('infra_outbox_slot')")
        elif current and current['wal_status'] == 'lost':
            raise RuntimeError('Lost slot is still active; stop the connector task first')
        connect(port, 'PUT', '/connectors/infra-outbox/config', {**config, **HEARTBEAT})
        if current is None or current['wal_status'] == 'lost':
            # Stored offsets point at WAL that no longer exists; Debezium refuses to stream from
            # them. Reset offsets (connector must be STOPPED) so it snapshots the outbox afresh.
            connect(port, 'PUT', '/connectors/infra-outbox/stop')
            for _ in range(30):
                if status(port)[0] == 'STOPPED': break
                time.sleep(2)
            else: raise RuntimeError('Connector did not stop for offset reset')
            connect(port, 'DELETE', '/connectors/infra-outbox/offsets')
        connect(port, 'POST', '/connectors/infra-outbox/restart?includeTasks=true&onlyFailed=false')
        # 4. The task recreates the slot; after a heartbeat the retained WAL must shrink.
        deadline = time.time() + 300; first = None
        while time.time() < deadline:
            time.sleep(10)
            state, current = status(port), slot(primary)
            healthy = state == ('RUNNING', ['RUNNING']) and current and current['active'] and current['wal_status'] in ('reserved', 'extended')
            if healthy and first is None: first = time.time()
            if healthy and time.time() - first > 90 and current['retained_bytes'] < 256 * 1024 * 1024:
                print(json.dumps({'result': 'REPAIRED', 'connector': state, 'slot': current}, ensure_ascii=False)); return
        raise RuntimeError(f'CDC not healthy after repair: {json.dumps({"connector": status(port), "slot": slot(primary)})}')

if __name__ == '__main__':
    main('--apply' in sys.argv[1:])
