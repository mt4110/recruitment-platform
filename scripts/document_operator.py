"""Small local operator primitives, not application endpoints. No delete operations."""
import fcntl,hashlib,json,os,re,subprocess,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def instance():
 name=os.environ.get('RP_INSTANCE','default')
 if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',name):raise ValueError('Invalid instance')
 local=ROOT/'.local' if name=='default' else ROOT/'.local'/name
 if not (local/'worker-keys-initialized').is_file():raise ValueError('Existing provisioned instance required')
 return name,local

def values(local):return dict(line.split('=',1) for line in (local/'local.env').read_text().splitlines() if '=' in line)
def run(args,**kwargs):return subprocess.run(args,cwd=ROOT,check=True,capture_output=True,**kwargs).stdout
def compose(*args,**kw):return run(['python3','scripts/local.py','compose',*args],**kw)
def sql(statement):return compose('exec','-T','db','psql','-U','postgres','-d','recruitment','-v','ON_ERROR_STOP=1','-At',input=statement.encode()).decode().strip()
def quote(v):return "'"+str(v).replace("'","''")+"'"
def digest(b):return hashlib.sha256(b).hexdigest()
def lock(local):
 f=(local/'document-job.lock').open('a');fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);return f

def write_new(path,raw,mode=0o600):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 with path.open('xb') as f:os.fchmod(f.fileno(),mode);f.write(raw);f.flush();os.fsync(f.fileno())
 fd=os.open(path.parent,os.O_RDONLY);os.fsync(fd);os.close(fd)
def crypto(mode,key,aad,raw):return run(['node','scripts/document_crypto.cjs',mode,str(key),aad],input=raw)
# Trusted Node helper runs in a networkless, readonly, unprivileged container.
READ="""const fs=require('fs'),p=process.argv[1],s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>536870884)throw Error('FILE_LIMIT');process.stdout.write(fs.readFileSync(p));"""
WRITE="""const fs=require('fs'),path=require('path'),p=process.argv[1];let n=0,a=[];process.stdin.on('data',b=>{n+=b.length;if(n>536870884)process.exit(2);a.push(b)});process.stdin.on('end',()=>{fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const b=Buffer.concat(a);if(fs.existsSync(p)){if(!fs.readFileSync(p).equals(b))throw Error('NO_OVERWRITE');return}const f=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(f,b);fs.fsyncSync(f)}finally{fs.closeSync(f)}const d=fs.openSync(path.dirname(p),'r');fs.fsyncSync(d);fs.closeSync(d)});"""
LIST="""const fs=require('fs'),path=require('path'),base=process.argv[1],out=[];function walk(dir){for(const f of fs.readdirSync(dir)){const p=path.join(dir,f),s=fs.lstatSync(p);if(s.isSymbolicLink()||(!s.isDirectory()&&!s.isFile()))throw Error('INVALID_PATH');if(s.isDirectory())walk(p);else{out.push({path:path.relative(base,p),size:s.size});if(out.length>20000)throw Error('FILE_COUNT')}}}walk(base);process.stdout.write(JSON.stringify(out));"""
def volume_helper(project,role,volumes,writable=False,uid=1001):
 name='s4-'+role+'-'+uuid.uuid4().hex[:12]
 args=['docker','run','-d','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','32','--memory','768m','--user',f'{uid}:{uid}']
 for source,target in volumes:args+=['--mount',f'type=volume,src={source},dst={target}'+('' if writable else ',readonly')]
 run([*args,project+'-document-broker','node','-e','setInterval(()=>{},60000)'])
 return name
