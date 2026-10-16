// Trusted host harness IPC only. No Docker socket is exposed to application roles.
const chunks=[];let n=0;
process.stdin.on('data',b=>{n+=b.length;if(n>16*1024*1024)process.exit(2);chunks.push(b);});
process.stdin.on('end',async()=>{
 try{
  const p=JSON.parse(Buffer.concat(chunks));
  const allowed=['/','/favicon.ico','/health','/public','/state','/decrypt','/seal','/restore','/revoke'];
  if(!allowed.includes(p.path)||!['GET','POST'].includes(p.method))throw Error('route');
  const r=await fetch('http://127.0.0.1:8080'+p.path,{method:p.method,body:p.method==='POST'?p.body:undefined});
  console.log(JSON.stringify({status:r.status,contentType:r.headers.get('content-type'),body:await r.text()}));
 }catch{process.exitCode=1;}
});
