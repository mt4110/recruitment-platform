'use strict';
// One job, fixed destination/schema. No auth credentials, URLs or file paths.
const http=require('node:http');let used=false;
const server=http.createServer(async(req,res)=>{
 function reply(status,bytes=Buffer.from('{}')){res.writeHead(status,{'Content-Type':'application/json','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);}
 if(req.method==='GET'&&req.url==='/live')return reply(200);
 const n=Number(req.headers['content-length']);
 if(used||req.method!=='POST'||req.url!=='/check'||!Number.isInteger(n)||n<1||n>10485760||!['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(req.headers['content-type'])||!/^[0-9a-f-]{36}$/.test(req.headers['x-job-id']||''))return reply(403);
 used=true;
 try{
  const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>n)throw Error('LIMIT');chunks.push(b);}if(size!==n)throw Error('LENGTH');
  const r=await fetch('http://sandbox:8080/check',{method:'POST',headers:{'Content-Type':req.headers['content-type'],'X-Job-ID':req.headers['x-job-id']},body:Buffer.concat(chunks),redirect:'error',signal:AbortSignal.timeout(8500)});
  const data=[];size=0;for await(const b of r.body){size+=b.length;if(size>4096)throw Error('LIMIT');data.push(b);}if(r.status!==200)throw Error('SANDBOX');
  const raw=Buffer.concat(data),v=JSON.parse(raw);
  if(Object.keys(v).sort().join(',')!=='ok,policy,rejection_code,sha256'||typeof v.ok!=='boolean'||!/^[a-f0-9]{64}$/.test(v.sha256)||!['static-resume-v1','xlsx-resume-v1'].includes(v.policy)||(v.ok?v.rejection_code!==null:!/^FORMAT_[A-Z0-9_]{1,64}$/.test(v.rejection_code)))throw Error('SCHEMA');
  reply(200,Buffer.from(JSON.stringify(v)));
 }catch{reply(503);}finally{setTimeout(()=>server.close(),10);}
});server.headersTimeout=5000;server.requestTimeout=10000;server.listen(8080,'0.0.0.0');
