"""Bounded static-resume-v1 policy worker. No database or storage access."""
import sys,json,hashlib,resource,io
from pathlib import Path
def inspect(raw):
    import pikepdf as p
    class Refused(Exception):pass
    def refuse(reason):raise Refused(reason)
    def key(obj):
        try:return obj.objgen if obj.objgen!=(0,0) else ('direct',id(obj))
        except AttributeError:return None
    banned={'/Annots','/AcroForm','/XFA','/OpenAction','/AA','/JS','/JavaScript','/EmbeddedFiles','/EF','/Launch','/RichMedia','/Collection'}
    actions={'/JavaScript','/Launch','/URI','/GoToR','/GoToE','/SubmitForm','/ImportData','/Rendition'}
    try:
        if len(raw)>10*1024*1024:refuse('SIZE')
        with p.Pdf.open(io.BytesIO(raw),attempt_recovery=False) as pdf:
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
            visited=set();count=0
            def walk(obj,depth=0):
                nonlocal count
                count+=1
                if count>10000:refuse("OBJECTS")
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
                if isinstance(k,tuple) and len(k)==2 and isinstance(k[0],int):
                    if k in visited:return
                    visited.add(k)
                if is_dict:
                    for value in obj.values():walk(value,depth+1)
                else:
                    for value in obj:walk(value,depth+1)
            for obj in pdf.objects:walk(obj)
            if pdf.get_warnings():refuse('PARSE_WARNING')
            return {'accepted':True,'policy':'static-resume-v1','sha256':hashlib.sha256(raw).hexdigest()}
    except Refused as e:return {'accepted':False,'reason':str(e)}
    except (p.PdfError,p.PasswordError,ValueError,TypeError,RecursionError):return {'accepted':False,'reason':'PARSER_OR_STRUCTURE'}

if __name__ == "__main__":
    resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,)*2)
    resource.setrlimit(resource.RLIMIT_CPU,(5,5))
    print(json.dumps(inspect(sys.stdin.buffer.read(10*1024*1024+1))))
