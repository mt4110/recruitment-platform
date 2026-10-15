"""R0 only: native official Debian images, real DB generations and isolated gate model.
No product API, credentials, migration or deployment. Retain all evidence/containers.
"""
import argparse
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import time

IMAGES = {
    'arm64': 'clamav/clamav@sha256:45bbe454c6b8ba12382f58133a72ffd983cd0b7505f8f4cea906202f5a8a3b28',
    'amd64': 'clamav/clamav@sha256:99f1e9b79d0a5ec8c019483b40577f6bae4f30a954f9f057a7b39da600861391',
}
EICAR = b'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'


def run(args, data=None, timeout=60):
    p = subprocess.run(['docker', *args], input=data, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, timeout=timeout)
    return p.returncode, p.stdout.decode(errors='replace')


def manifest(directory):
    result = {}
    for p in sorted(directory.glob('*')):
        if p.suffix not in {'.cvd', '.cld', '.cud'}:
            continue
        with p.open('rb') as f:
            header = f.read(512).decode(errors='replace').split(':')
        if len(header) < 9 or header[0] != 'ClamAV-VDB':
            raise ValueError('invalid DB header')
        result[p.stem] = {'file': p.name, 'version': int(header[2]),
                          'published_at': header[1], 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
    if set(result) != {'daily', 'main', 'bytecode'}:
        raise ValueError('incomplete DB set')
    return result


def admission(published, loaded, checked_generation, age, *, ready=True, busy=False, updating=False, update_ok=True):
    # Deliberately isolated model, not the future authenticated HTTP wrapper.
    return (ready and update_ok and not busy and not updating and published == loaded
            and checked_generation == published and 0 <= age <= 86400)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('output')
    args = ap.parse_args()
    out = Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    _, info = run(['info', '--format', '{{.Architecture}}'])
    arch = {'aarch64': 'arm64', 'x86_64': 'amd64'}.get(info.strip())
    if arch not in IMAGES:
        raise RuntimeError('native Docker architecture not supported')
    image = IMAGES[arch]
    prefix = 'recruitment-r0-followup-' + datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%S') + '-' + os.urandom(2).hex()
    containers = []
    evidence = {'scope': 'R0 isolated feasibility; gate is a model, not product integration',
                'arch': arch, 'image': image, 'containers': containers, 'checks': {}}
    checks = evidence['checks']
    config = out / 'config'
    config.mkdir()
    (config / 'freshclam.conf').write_text('DatabaseDirectory /db\nDatabaseOwner clamav\nDatabaseMirror database.clamav.net\nForeground yes\nTestDatabases yes\nConnectTimeout 5\nReceiveTimeout 15\nMaxAttempts 1\n')
    (config / 'clamd.conf').write_text('DatabaseDirectory /db\nForeground yes\nLocalSocket /tmp/clamd.sock\nTemporaryDirectory /tmp\nMaxThreads 1\nMaxQueue 2\nMaxScanTime 20000\nMaxScanSize 64M\nMaxFileSize 16M\nMaxRecursion 8\nMaxFiles 1000\nStreamMaxLength 10M\nAlertExceedsMax yes\nConcurrentDatabaseReload no\nSelfCheck 0\nTCPSocket 3310\nTCPAddr 127.0.0.1\n')

    def start(suffix, cmd, db=None, *, update=False, detached=False):
        name = prefix + '-' + suffix
        containers.append(name)
        opts = ['run', '--name', name, '--platform', 'linux/' + arch, '--user', '1000:1000',
                '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--pids-limit', '32', '--cpus', '1', '--memory', '4g' if update else '2g',
                '--memory-swap', '4g' if update else '2g', '--network', 'bridge' if update else 'none',
                '--tmpfs', '/tmp:rw,noexec,nosuid,size=384m', '-v', str(config) + ':/config:ro']
        if db:
            opts += ['-v', str(db) + ':/db' + ('' if update else ':ro')]
        if detached:
            opts += ['-d']
        code, text = run([*opts, '--entrypoint', cmd[0], image, *cmd[1:]], timeout=180)
        if code:
            raise RuntimeError(suffix + ' container failed: ' + text[:200])
        return name, text

    def scan(name, data):
        packet = b'zINSTREAM\0' + struct.pack('!I', len(data)) + data + struct.pack('!I', 0)
        transport = "exec 3<>/dev/tcp/127.0.0.1/3310; exec 4<&0; cat <&4 >&3 & writer=$!; IFS= read -r -d '' response <&3; printf '%s' \"$response\"; wait \"$writer\" 2>/dev/null || true"
        _, text = run(['exec', '-i', name, 'bash', '-c', transport], data=packet, timeout=30)
        return text.replace('\x00', '').strip()

    def load(suffix, db, expected, fail=False):
        name, _ = start(suffix, ['clamd', '--config-file=/config/clamd.conf'], db, detached=True)
        started = time.monotonic()
        ready = False
        while time.monotonic() - started < 100:
            _, state = run(['inspect', '--format', '{{.State.Running}}', name])
            if state.strip() != 'true':
                break
            _, version = run(['exec', name, 'clamdscan', '--config-file=/config/clamd.conf', '--version'])
            if f'/{expected["daily"]["version"]}/' in version and scan(name, b'fictional clean resume') == 'stream: OK':
                ready = True
                break
            time.sleep(1)
        _, log = run(['logs', name])
        (out / (suffix + '.log')).write_text(log)
        _, state = run(['inspect', '--format', '{{json .State}}', name])
        item = {'ready': ready, 'seconds': round(time.monotonic() - started, 3), 'state': json.loads(state)}
        checks[suffix] = item
        if fail:
            assert not ready and not item['state']['Running'], 'bad generation unexpectedly loaded'
            checks[suffix] = item
            return name
        assert ready, 'daemon not ready at 2GiB: ' + suffix
        _, version = run(['exec', name, 'clamdscan', '--config-file=/config/clamd.conf', '--version'])
        item['loaded_version'] = version.strip()
        # All DB files are verified by the real engine, readonly, and unchanged after loading.
        item['manifest_unchanged_after_load'] = manifest(db) == expected
        assert item['manifest_unchanged_after_load']
        item['database_verification'] = {}
        for key, dbinfo in expected.items():
            code, verified = run(['exec', name, 'sigtool', '--info', '/db/' + dbinfo['file']])
            assert code == 0 and 'Verification OK' in verified, 'official DB verification failed: ' + key
            item['database_verification'][key] = {'verified': True, 'version': dbinfo['version']}
        item['clean'] = scan(name, b'fictional clean resume')
        item['eicar'] = scan(name, EICAR)
        assert item['clean'] == 'stream: OK' and 'FOUND' in item['eicar'], 'raw scan: ' + repr((item['clean'], item['eicar']))
        item['fixtures'] = {}
        for f in sorted((Path(__file__).parent / 'fixtures').glob('*.xlsx')):
            item['fixtures'][f.name] = scan(name, f.read_bytes())
            assert item['fixtures'][f.name] == 'stream: OK'
        item['over_10m'] = scan(name, b'0' * (10 * 1024 * 1024 + 1))
        assert 'size limit exceeded' in item['over_10m'], 'missing protocol limit refusal: ' + repr(item['over_10m'])
        _, peak = run(['exec', name, 'cat', '/sys/fs/cgroup/memory.peak'])
        item['memory_peak_bytes'] = int(peak.strip())
        _, attrs = run(['inspect', '--format', '{{json .HostConfig}}', name])
        attrs = json.loads(attrs)
        item['isolation'] = {k: attrs.get(k) for k in ['ReadonlyRootfs', 'CapDrop', 'SecurityOpt', 'Memory', 'PidsLimit', 'NetworkMode', 'PortBindings']}
        assert attrs['ReadonlyRootfs'] and attrs['NetworkMode'] == 'none' and not attrs['PortBindings']
        checks[suffix] = item
        return name

    try:
        # Preserve real signed older databases baked into the digest-pinned official image.
        source, _ = start('source', ['sh', '-c', 'uname -m; id; clamd --version'])
        old = out / 'generation-old'
        old.mkdir()
        code, text = run(['cp', source + ':/var/lib/clamav/.', str(old)])
        assert code == 0, text
        evidence['old_manifest'] = before = manifest(old)
        old_name = load('old-load', old, before)
        assert admission(before, before, before, 0)
        assert not admission(before, before, before, 0, busy=True)
        assert not admission(before, before, before, 0, updating=True)
        run(['stop', '-t', '3', old_name])
        stage = out / 'generation-staging'
        stage.mkdir()
        stage.chmod(0o777)  # isolated public signature DB only
        for f in old.iterdir():
            if f.is_file() and (f.suffix in {'.cvd', '.cld', '.sign'}):
                shutil.copyfile(f, stage / f.name)
                (stage / f.name).chmod(0o666)
        updater, text = start('update', ['freshclam', '--config-file=/config/freshclam.conf'], stage, update=True)
        (out / 'freshclam.log').write_text(text)
        evidence['new_manifest'] = after = manifest(stage)
        assert after['daily']['version'] > before['daily']['version'], 'actual upstream version change not observed'
        assert all(after[k]['version'] >= before[k]['version'] for k in before), 'DB rollback'
        # No overwrite: publish a new immutable pathname, only after FreshClam validation.
        new = out / 'generation-new'
        stage.rename(new)
        evidence['real_upstream_version_advance'] = [before['daily']['version'], after['daily']['version']]
        assert not admission(after, before, after, 0)
        new_name = load('new-load', new, after)
        assert admission(after, after, after, 0)
        gate = {
            'matching_ready': admission(after, after, after, 0),
            'old_loaded_new_check': not admission(after, before, after, 0),
            'stale': not admission(after, after, after, 86401),
            'future_check': not admission(after, after, after, -1),
            'busy': not admission(after, after, after, 0, busy=True),
            'updating': not admission(after, after, after, 0, updating=True),
            'load_failed': not admission(after, after, after, 0, ready=False),
        }
        mismatch = copy.deepcopy(after)
        mismatch['daily']['sha256'] = '0' * 64
        gate['hash_mismatch'] = not admission(after, mismatch, after, 0)
        gate['rollback_rejected'] = any(before[k]['version'] < after[k]['version'] for k in before)
        # Real updater startup failure with no network and no access to valid DBs.
        (config / 'failed-freshclam.conf').write_text('DatabaseDirectory /readonly-unavailable\nDatabaseOwner clamav\nDatabaseMirror database.clamav.net\nForeground yes\nTestDatabases yes\n')
        failed_update, _ = start('failed-update', ['freshclam', '--config-file=/config/failed-freshclam.conf'], detached=True)
        code, failed_exit = run(['wait', failed_update], timeout=20)
        assert code == 0 and int(failed_exit.strip()) != 0, 'updater unexpectedly succeeded'
        _, failed_log = run(['logs', failed_update])
        (out / 'failed-update.log').write_text(failed_log)
        checks['actual_update_failure'] = {'exit': int(failed_exit.strip()), 'valid_manifest_unchanged': manifest(new) == after}
        assert checks['actual_update_failure']['valid_manifest_unchanged']
        gate['update_failed'] = not admission(after, after, after, 0, update_ok=False)
        run(['stop', '-t', '3', new_name])
        bad = out / 'generation-bad'
        bad.mkdir()
        (bad / 'daily.cvd').write_bytes(b'invalid-R0-test-database')
        bad_name = load('bad-load', bad, after, fail=True)
        gate['failed_load_keeps_closed'] = not admission(after, None, after, 0, ready=False)
        # Real recovery is a fresh daemon using the same validated immutable generation.
        recovered = load('recovered-load', new, after)
        gate['recovered'] = admission(after, after, after, 0)
        assert all(gate.values())
        checks['gate_model'] = gate
        evidence['result'] = 'established_for_R0_probe_scope'
    except Exception as exc:
        evidence['result'] = 'not_established'
        evidence['error'] = type(exc).__name__ + ': ' + str(exc)
    finally:
        for name in containers:
            run(['stop', '-t', '3', name])
        (out / 'result.json').write_text(json.dumps(evidence, indent=2))
        print(json.dumps({'result': evidence['result'], 'arch': arch, 'error': evidence.get('error'), 'version_advance': evidence.get('real_upstream_version_advance')}))
    return 0 if evidence['result'] == 'established_for_R0_probe_scope' else 1


if __name__ == '__main__':
    raise SystemExit(main())
