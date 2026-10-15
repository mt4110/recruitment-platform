"""M0-only parser/policy feasibility probe; not production validation service."""
from pathlib import Path
import sys,json,subprocess,resource,time,hashlib,os

LIMIT=256*1024*1024
def limits():
    resource.setrlimit(resource.RLIMIT_AS,(LIMIT,LIMIT));resource.setrlimit(resource.RLIMIT_CPU,(5,5))
def inspect(path):
    import pikepdf as p
    class Refused(Exception):pass
    def refuse(reason):raise Refused(reason)
    def key(obj):
        try:return obj.objgen if obj.objgen!=(0,0) else ('direct',id(obj))
        except AttributeError:return None
    banned={'/Annots','/AcroForm','/XFA','/OpenAction','/AA','/JS','/JavaScript','/EmbeddedFiles','/EF','/Launch','/RichMedia','/Collection'}
    actions={'/JavaScript','/Launch','/URI','/GoToR','/GoToE','/SubmitForm','/ImportData','/Rendition'}
    try:
        if path.stat().st_size>10*1024*1024:refuse('SIZE')
        with p.Pdf.open(path,attempt_recovery=False) as pdf:
            if pdf.is_encrypted:refuse('ENCRYPTED')
            if not 1<=len(pdf.pages)<=20:refuse('PAGES')
            if len(pdf.objects)>10000:refuse('OBJECTS')
            if pdf.check_pdf_syntax() or pdf.get_warnings():refuse('SYNTAX_WARNING')
            allowed=set();tree=pdf.Root.get('/StructTreeRoot');ancestry=set()
            def structural(children,parent,depth=0):
                if depth>64:refuse('DEPTH')
                if isinstance(children,p.Array):
                    for child in children:structural(child,parent,depth+1)
                elif isinstance(children,p.Dictionary) and children.get('/Type')==p.Name('/StructElem'):
                    k=key(children)
                    if k in ancestry:refuse('STRUCTURE_CYCLE')
                    if not isinstance(children.get('/S'),p.Name) or key(children.get('/P'))!=key(parent):refuse('STRUCTURE_PARENT')
                    allowed.add(k);ancestry.add(k);structural(children.get('/K'),children,depth+1);ancestry.remove(k)
            if isinstance(tree,p.Dictionary) and tree.get('/Type')==p.Name('/StructTreeRoot'):structural(tree.get('/K'),tree)
            def attributes(value):
                if isinstance(value,p.Dictionary):return
                if not isinstance(value,p.Array) or not len(value):refuse('ATTRIBUTE_TYPE')
                previous_dict=False
                for item in value:
                    if isinstance(item,p.Dictionary):previous_dict=True
                    elif isinstance(item,int) and not isinstance(item,bool) and item>=0 and previous_dict:previous_dict=False
                    else:refuse('ATTRIBUTE_TYPE')
            visited=set()
            def walk(obj,depth=0):
                if depth>64:refuse('DEPTH')
                is_dict=isinstance(obj,(p.Dictionary,p.Stream))
                if is_dict:
                    keys=set(obj.keys())
                    if keys & banned:refuse('FORBIDDEN_KEY')
                    if obj.get('/Type')==p.Name('/Action') or str(obj.get('/S')) in actions:refuse('ACTION')
                    if '/A' in keys:
                        if key(obj) not in allowed:refuse('UNSUPPORTED_A')
                        attributes(obj['/A'])
                if not isinstance(obj,(p.Array,p.Dictionary,p.Stream)):return
                k=key(obj)
                if k in visited:return
                visited.add(k)
                if is_dict:
                    for value in obj.values():walk(value,depth+1)
                else:
                    for value in obj:walk(value,depth+1)
            for obj in pdf.objects:walk(obj)
            if pdf.get_warnings():refuse('PARSE_WARNING')
            return {'accepted':True,'policy':'static-resume-v1','sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    except Refused as e:return {'accepted':False,'reason':str(e)}
    except (p.PdfError,p.PasswordError,ValueError,TypeError,RecursionError):return {'accepted':False,'reason':'PARSER_OR_STRUCTURE'}

def suite():
    root=Path('/opt/probe/fixtures');manifest=json.loads((root/'manifest.json').read_text());results=[]
    for accepted,names in ((True,manifest['expected_accept']),(False,manifest['expected_reject'])):
        for name in names:
            t=time.monotonic()
            try:
                proc=subprocess.run([sys.executable,__file__,'check',str(root/name)],capture_output=True,text=True,timeout=5,preexec_fn=limits)
                actual=json.loads(proc.stdout) if proc.returncode==0 else {'accepted':False,'reason':'WORKER_FAILURE','exit_code':proc.returncode}
                ok=actual['accepted']==accepted and proc.returncode==0
            except subprocess.TimeoutExpired:actual={'accepted':False,'reason':'WORKER_TIMEOUT'};ok=not accepted
            results.append({'fixture':name,'expected_accept':accepted,**actual,'pass':ok,'seconds':round(time.monotonic()-t,4)})
    controls=[]
    t=time.monotonic()
    try:
        subprocess.run([sys.executable,'-c','import time; time.sleep(10)'],timeout=5,preexec_fn=limits,capture_output=True)
        wall_ok=False
    except subprocess.TimeoutExpired:wall_ok=True
    controls.append({'name':'wall_timeout_5s','pass':wall_ok,'seconds':round(time.monotonic()-t,3)})
    mem=subprocess.run([sys.executable,'-c','try:\n x=bytearray(512*1024*1024)\nexcept MemoryError:\n raise SystemExit(23)'],capture_output=True,preexec_fn=limits,timeout=5)
    controls.append({'name':'address_space_256MiB','pass':mem.returncode==23,'exit_code':mem.returncode})
    cpu=subprocess.run([sys.executable,'-c','while True: pass'],capture_output=True,preexec_fn=limits,timeout=8)
    controls.append({'name':'cpu_limit_5s','pass':cpu.returncode in (-9,-24),'exit_code':cpu.returncode})
    status=Path('/proc/self/status').read_text()
    controls.append({'name':'non_root_and_no_capabilities','pass':os.getuid()!=0 and 'CapEff:\t0000000000000000' in status,'uid':os.getuid()})
    try:Path('/opt/probe/should-not-write').write_text('x');ro=False
    except OSError:ro=True
    controls.append({'name':'read_only_root','pass':ro})
    import socket
    try:socket.create_connection(('1.1.1.1',443),timeout=1);egress=False
    except OSError:egress=True
    controls.append({'name':'no_network_egress','pass':egress})
    import pikepdf as p,platform
    result={'scope':'isolated M0 parser/policy harness; not production service','python':platform.python_version(),'pikepdf':p.__version__,'libqpdf':p.__libqpdf_version__,
      'fixtures':results,'controls':controls,'all_passed':all(x['pass'] for x in results+controls)}
    Path('/out').mkdir(exist_ok=True);Path('/out/pdf-validation-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
    if not result['all_passed']:raise SystemExit(1)

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='check':print(json.dumps(inspect(Path(sys.argv[2]))))
    else:suite()
