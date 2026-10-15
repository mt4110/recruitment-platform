"""Public signature metadata only. No resume bytes, credentials or commands in logs."""
import datetime, hashlib, json, os, subprocess, uuid
from pathlib import Path
ROOT = Path('/signatures')

def read_manifest():
    m=json.loads((ROOT/'published.json').read_text())
    uuid.UUID(m['generation_id'])
    if set(m['databases']) != {'main','daily','bytecode'}: raise ValueError('databases')
    for key, v in m['databases'].items():
        if v['file'] not in {key+'.cvd',key+'.cld'} or len(v['sha256'])!=64:raise ValueError('database')
    return m

def identity(m):return {'generation_id':m['generation_id'],'databases':m['databases']}

def fresh(m):
    age=datetime.datetime.now(datetime.timezone.utc).timestamp()-m['last_successful_check']
    return m['update_ok'] is True and 0<=age<=86400

def database_manifest(directory):
    result={}
    for key in ('main','daily','bytecode'):
        files=[p for p in directory.iterdir() if p.name in {key+'.cvd',key+'.cld'}]
        if len(files)!=1:raise ValueError('database set')
        p=files[0]
        r=subprocess.run(['sigtool','--info',str(p)],capture_output=True,timeout=60)
        if r.returncode or b'Verification OK' not in r.stdout:raise ValueError('signature verification')
        with p.open('rb') as f:header=f.read(512).decode().split(':')
        if header[0]!='ClamAV-VDB':raise ValueError('header')
        with p.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
        result[key]={'file':p.name,'version':int(header[2]),'published_at':header[1],'sha256':digest}
    return result

def publish(m):
    p=ROOT/('manifest-'+str(uuid.uuid4())+'.tmp')
    with p.open('x') as f:
        json.dump(m,f);f.flush();os.fsync(f.fileno())
    os.replace(p,ROOT/'published.json')
    fd=os.open(ROOT,os.O_RDONLY);os.fsync(fd);os.close(fd)
