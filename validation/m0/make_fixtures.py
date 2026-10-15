"""Generate fictional static/forbidden PDF cases. No input from real users."""
from pathlib import Path
import io,json,secrets
import pikepdf as p
from reportlab.pdfgen import canvas

root=Path(__file__).parent/'fixtures';root.mkdir(exist_ok=True)
b=io.BytesIO();c=canvas.Canvas(b,pagesize=(595.276,841.89));c.drawString(60,780,'FICTIONAL RESUME - M0 ONLY');c.drawString(60,750,'Sample Applicant A / no real personal data');c.save();base=b.getvalue()
(root/'static.pdf').write_bytes(base)
def save(name,modify):
    with p.Pdf.open(io.BytesIO(base)) as pdf:modify(pdf);pdf.save(root/name,compress_streams=False)
def tag(pdf,revision=False):
    tree=pdf.make_indirect(p.Dictionary(Type=p.Name('/StructTreeRoot')))
    elem=pdf.make_indirect(p.Dictionary(Type=p.Name('/StructElem'),S=p.Name('/P'),P=tree,Pg=pdf.pages[0].obj,K=0))
    attr=p.Dictionary(O=p.Name('/Layout'),SpaceBefore=0);elem.A=p.Array([attr,0]) if revision else attr
    tree.K=p.Array([elem]);tree.ParentTree=pdf.make_indirect(p.Dictionary(Nums=p.Array([0,p.Array([elem])])))
    pdf.Root.StructTreeRoot=tree;pdf.Root.MarkInfo=p.Dictionary(Marked=True);pdf.pages[0].obj.StructParents=0
    old=pdf.pages[0].obj.Contents.read_bytes();pdf.pages[0].obj.Contents=pdf.make_stream(b'/P <</MCID 0>> BDC\n'+old+b'\nEMC');return elem
save('tagged.pdf',tag);save('tagged-revision.pdf',lambda x:tag(x,True))
save('javascript.pdf',lambda x:setattr(x.Root,'OpenAction',x.make_indirect(p.Dictionary(S=p.Name('/JavaScript'),JS=p.String('void(0)')))))
save('link.pdf',lambda x:setattr(x.pages[0].obj,'Annots',p.Array([x.make_indirect(p.Dictionary(Type=p.Name('/Annot'),Subtype=p.Name('/Link'),Rect=p.Array([0,0,10,10]),A=p.Dictionary(S=p.Name('/URI'),URI=p.String('https://example.com'))))])))
save('form.pdf',lambda x:setattr(x.Root,'AcroForm',p.Dictionary(Fields=p.Array())))
save('attachment.pdf',lambda x:x.attachments.__setitem__('fictional.txt',b'M0 only'))
save('forged-struct.pdf',lambda x:setattr(x.Root,'M0Pretend',x.make_indirect(p.Dictionary(Type=p.Name('/StructElem'),S=p.Name('/P'),A=p.Dictionary(O=p.Name('/Layout'))))))
def hidden(x):tag(x).A.M0Hidden=p.Dictionary(JS=p.String('void(0)'))
save('attribute-hidden-js.pdf',hidden)
def shared(x):x.pages[0].obj.A=tag(x)
save('shared-action.pdf',shared)
def depth(x):
    a=p.Array([0])
    for _ in range(70):a=p.Array([a])
    x.Root.M0Nested=a
save('too-deep.pdf',depth)
save('too-many-objects.pdf',lambda x:setattr(x.Root,'M0Objects',p.Array([x.make_indirect(p.Dictionary(M0=i)) for i in range(10010)])))
save('too-many-pages.pdf',lambda x:[x.add_blank_page() for _ in range(20)])
save('too-large.pdf',lambda x:setattr(x.Root,'M0Payload',x.make_stream(b'x'*(11*1024*1024))))
with p.Pdf.open(io.BytesIO(base)) as pdf:pdf.save(root/'encrypted-empty.pdf',encryption=p.Encryption(owner=secrets.token_urlsafe(20),user='',R=6))
(root/'broken.pdf').write_bytes(b'%PDF-1.7\n1 0 obj << /Type /Catalog >>\nTRUNCATED')
def minimal(name,dictionary):
    objs=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 4 0 R >>',b'<< /Length 0 >>\nstream\n\nendstream',dictionary]
    out=bytearray(b'%PDF-1.7\n');offsets=[]
    for i,data in enumerate(objs,1):offsets.append(len(out));out.extend(f'{i} 0 obj\n'.encode()+data+b'\nendobj\n')
    xref=len(out);out.extend(b'xref\n0 6\n0000000000 65535 f \n')
    for off in offsets:out.extend(f'{off:010d} 00000 n \n'.encode())
    out.extend(f'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode());(root/name).write_bytes(out)
minimal('unreferenced-js.pdf',b'<< /S /JavaScript /JS (void\\(0\\)) >>')
minimal('escaped-js-key.pdf',b'<< /#4A#53 (void\\(0\\)) >>')
accepted=['static.pdf','tagged.pdf','tagged-revision.pdf']
(root/'manifest.json').write_text(json.dumps({'expected_accept':accepted,'expected_reject':sorted(x.name for x in root.glob('*.pdf') if x.name not in accepted)},indent=2))
print('Generated 18 fictional PDF fixtures')
