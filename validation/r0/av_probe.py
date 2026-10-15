"""R0 isolated ClamAV feasibility probe; never modifies product services or DBs."""
import argparse, datetime, hashlib, io, json, os, pathlib, struct, subprocess, time, zipfile

IMAGE = 'clamav/clamav@sha256:96b28b83eb72fb497c2400a94229844226e5fe4da9061fad1988092d9fcd88f3'

def main():
    ap=argparse.ArgumentParser();ap.add_argument('output');ap.add_argument('--platform',default='linux/amd64');args=ap.parse_args()
    out=pathlib.Path(args.output).resolve();out.mkdir(parents=True,exist_ok=True)
    db=out/'db';db.mkdir(exist_ok=True);db.chmod(0o777)  # isolated public signature DB only
    cfg=out/'config';cfg.mkdir(exist_ok=True)
    (cfg/'freshclam.conf').write_text('DatabaseDirectory /db\nDatabaseOwner clamav\nDatabaseMirror database.clamav.net\nForeground yes\nTestDatabases yes\nChecks 4\nUpdateLogFile /tmp/freshclam.log\n')
    (cfg/'clamd.conf').write_text('DatabaseDirectory /db\nForeground yes\nLocalSocket /tmp/clamd.sock\nPidFile /tmp/clamd.pid\nLogFile /tmp/clamd.log\nTemporaryDirectory /tmp\nMaxThreads 1\nMaxQueue 2\nMaxScanTime 20000\nMaxScanSize 64M\nMaxFileSize 16M\nMaxRecursion 8\nMaxFiles 1000\nStreamMaxLength 10M\nAlertExceedsMax yes\nConcurrentDatabaseReload no\nSelfCheck 0\nTCPSocket 3310\nTCPAddr 127.0.0.1\n')
    prefix='recruitment-r0-'+datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%S')+'-'+os.urandom(2).hex()
    created=[];evidence={'image':IMAGE,'platform':args.platform,'native_host':os.uname().machine,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'containers':created,'checks':{}}
    def run(argv,*,data=None,timeout=60):
        p=subprocess.run(['docker',*argv],input=data,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=timeout)
        return p.returncode,p.stdout.decode(errors='replace')
    def container(name,command,*,network='none',memory='2g',detach=False,source=db):
        created.append(name)
        opts=['run','--name',name,'--platform',args.platform,'--user','100:101','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','32','--cpus','1','--memory',memory,'--memory-swap',memory,'--network',network,'--tmpfs','/tmp:rw,noexec,nosuid,size=384m','-v',f'{cfg}:/config:ro','-v',f'{source}:/db'+('' if network!='none' else ':ro')]
        if detach:opts+=['-d']
        opts+=['--entrypoint',command[0],IMAGE,*command[1:]]
        return run(opts,timeout=600)
    try:
        for i in range(2):
            started=time.monotonic();code,log=container(prefix+f'-update-{i}', ['freshclam','--config-file=/config/freshclam.conf'],network='bridge',memory='4g')
            (out/f'freshclam-{i}.log').write_text(log)
            evidence['checks'][f'update_{i}']={'exit':code,'elapsed_seconds':round(time.monotonic()-started,3),'up_to_date':'up-to-date' in log}
            if code:raise RuntimeError('FreshClam failed; see retained freshclam log')
        files=sorted(p for p in db.iterdir() if p.suffix in {'.cvd','.cld','.cud'})
        manifest={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        if not manifest:raise RuntimeError('No official signature database downloaded')
        evidence['signature_manifest']=manifest
        name=prefix+'-scanner';code,log=container(name,['clamd','--config-file=/config/clamd.conf'],detach=True)
        if code:raise RuntimeError('clamd container creation failed: '+log[:200])
        ready=False;start=time.monotonic()
        while time.monotonic()-start<150:
            code,state=run(['inspect','--format','{{.State.Running}}',name])
            if state.strip()!='true':break
            code,log=run(['exec',name,'clamdscan','--config-file=/config/clamd.conf','--version'])
            code,ping=run(['exec','-i',name,'clamdscan','--config-file=/config/clamd.conf','--stream','-'],data=b'R0 clean fictional resume\n')
            if code==0:ready=True;break
            time.sleep(2)
        code,logs=run(['logs',name]);(out/'clamd.log').write_text(logs)
        evidence['checks']['load_2g']={'ready':ready,'seconds':round(time.monotonic()-start,3)}
        code,state=run(['inspect','--format','{{json .State}}',name]);evidence['scanner_state']=json.loads(state)
        if not ready:raise RuntimeError('clamd did not become ready at 2GiB')
        code,version=run(['exec',name,'clamdscan','--config-file=/config/clamd.conf','--version']);evidence['loaded_version']=version.strip()
        cases={'clean':b'Fictional resume only\n','eicar':b'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*','stream_over_10m':b'0'*(10*1024*1024+1)}
        for label,data in cases.items():
            start=time.monotonic();code,result=run(['exec','-i',name,'clamdscan','--config-file=/config/clamd.conf','--stream','-'],data=data)
            evidence['checks'][label]={'exit':code,'seconds':round(time.monotonic()-start,3),'clean':'OK' in result,'detected':'FOUND' in result,'limit':'limit' in result.lower(),'output':result[-800:]}
        # Raw INSTREAM avoids clamdscan stdin truncation. Loopback only, no published ports.
        raw_results={}
        for label,data in cases.items():
            frame=b'zINSTREAM\0'+struct.pack('!I',len(data))+data+struct.pack('!I',0)
            code,result=run(['exec','-i',name,'nc','-w','25','127.0.0.1','3310'],data=frame,timeout=40)
            raw_results[label]={'exit':code,'response':result[:200].replace('\x00',''),'clean':'OK' in result,'detected':'FOUND' in result,'limit':'size limit exceeded' in result.lower()}
        evidence['checks']['raw_instream']=raw_results
        for fixture in sorted((pathlib.Path(__file__).parent/'fixtures').glob('*.xlsx')):
            code,result=run(['exec','-i',name,'clamdscan','--config-file=/config/clamd.conf','--stream','-'],data=fixture.read_bytes())
            evidence['checks'][fixture.name]={'exit':code,'clean':code==0}
            eicar=io.BytesIO(fixture.read_bytes())
            with zipfile.ZipFile(eicar,'a') as archive:archive.writestr('r0-eicar.txt',cases['eicar'])
            code,result=run(['exec','-i',name,'clamdscan','--config-file=/config/clamd.conf','--stream','-'],data=eicar.getvalue())
            evidence['checks'][fixture.name+'-eicar-copy']={'exit':code,'detected':'FOUND' in result}
        if not(raw_results['clean']['clean'] and raw_results['eicar']['detected'] and raw_results['stream_over_10m']['limit']):
            raise RuntimeError('Raw INSTREAM clean/detection/size boundary not established')
        for field,file in [('peak_memory_bytes','memory.peak'),('memory_limit','memory.max'),('pids_limit','pids.max')]:
            code,value=run(['exec',name,'cat','/sys/fs/cgroup/'+file]);evidence[field]=value.strip() if code==0 else 'unavailable'
        code,attrs=run(['inspect','--format','{{json .HostConfig}}',name]);attrs=json.loads(attrs)
        evidence['isolation']={k:attrs.get(k) for k in ['ReadonlyRootfs','CapDrop','SecurityOpt','Memory','PidsLimit','NetworkMode','PortBindings']}
        evidence['checks']['same_generation_manifest_after_load']=manifest=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
        # Actual daemon load failure, without changing the valid retained DB.
        empty=out/'empty-db';empty.mkdir(exist_ok=True)
        code,result=container(prefix+'-missing-db',['clamd','--config-file=/config/clamd.conf'],source=empty)
        evidence['checks']['missing_db_refused']={'exit':code,'refused':code!=0};(out/'missing-db.log').write_text(result)
        evidence['result']='partial'  # real upstream changed-version reload and native arm64 are separate checks
    except Exception as exc:
        evidence['result']='not_established';evidence['error']=str(exc)
    finally:
        for name in created:run(['stop','-t','3',name])
        evidence['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        (out/'av.json').write_text(json.dumps(evidence,indent=2,ensure_ascii=False));print(json.dumps(evidence,ensure_ascii=False))
    return 0 if evidence.get('result')=='partial' else 1

if __name__=='__main__':raise SystemExit(main())
