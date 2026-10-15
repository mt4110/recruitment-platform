"""FreshClam is the only outbound service. Publish verified immutable generations."""
import json, os, shutil, subprocess, time, uuid
from pathlib import Path
from common import ROOT, database_manifest, publish, read_manifest

def update():
    old=None
    try:old=read_manifest()
    except (OSError,ValueError,KeyError):pass
    work=ROOT/'working';work.mkdir(exist_ok=True)
    if not list(work.glob('*.c?d')):
        for p in Path('/var/lib/clamav').iterdir():
            if p.suffix in {'.cvd','.cld','.sign'}:shutil.copyfile(p,work/p.name)
    conf=Path('/tmp/freshclam.conf')
    conf.write_text('DatabaseDirectory /signatures/working\nDatabaseOwner clamav\nDatabaseMirror database.clamav.net\nForeground yes\nTestDatabases yes\nConnectTimeout 5\nReceiveTimeout 30\nMaxAttempts 1\n')
    try:
        # Never forward FreshClam output or signature content to application logs.
        result=subprocess.run(['freshclam','--config-file='+str(conf)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=240)
        if result.returncode:raise ValueError('update failed')
        db=database_manifest(work)
        if old and any(db[k]['version']<old['databases'][k]['version'] for k in db):raise ValueError('rollback')
        if old and db==old['databases']:
            current=dict(old,update_ok=True,last_successful_check=time.time())
        else:
            generation=str(uuid.uuid4());target=ROOT/generation;target.mkdir(mode=0o755)
            for v in db.values():
                shutil.copyfile(work/v['file'],target/v['file']);(target/v['file']).chmod(0o444)
                with (target/v['file']).open('rb') as f:os.fsync(f.fileno())
            if database_manifest(target)!=db:raise ValueError('publish mismatch')
            target.chmod(0o555)
            fd=os.open(target,os.O_RDONLY);os.fsync(fd);os.close(fd)
            current={'generation_id':generation,'databases':db,'update_ok':True,'last_successful_check':time.time()}
        publish(current)
        print('signature_check_ok',flush=True)
    except Exception:
        if old:publish(dict(old,update_ok=False))
        print('signature_check_failed',flush=True)

if __name__=='__main__':
    while True:
        update();time.sleep(6*3600)
