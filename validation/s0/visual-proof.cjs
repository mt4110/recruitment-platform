// Encrypt private synthetic visual evidence for its owner; never upload the key.
const fs=require('node:fs'),path=require('node:path'),c=require('node:crypto');
const [run,publicFile]=process.argv.slice(2),images=[];
for(const name of fs.readdirSync(path.join(run,'private'))){
 const target=path.join(run,'private',name);
 if(fs.statSync(target).isDirectory()){
  for(const f of fs.readdirSync(target))if(f==='japanese-1.png'||f==='twenty-20.png')images.push({name:f,data:fs.readFileSync(path.join(target,f)).toString('base64')});
 }else if(['types.xlsx.png','sheets-resume.xlsx.png','sheets-career-history.xlsx.png'].includes(name))images.push({name,data:fs.readFileSync(target).toString('base64')});
}
if(images.length!==5)throw Error('visual evidence incomplete');
const key=c.randomBytes(32),iv=c.randomBytes(12),aad=Buffer.from(JSON.parse(fs.readFileSync(path.join(run,'summary.json'))).prefix);
const cipher=c.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
const ciphertext=Buffer.concat([cipher.update(JSON.stringify({images})),cipher.final()]);
const publicKey=c.createPublicKey({key:Buffer.from(fs.readFileSync(publicFile,'utf8').trim(),'base64'),type:'spki',format:'der'});
const wrapped=c.publicEncrypt({key:publicKey,oaepHash:'sha256'},key);key.fill(0);
fs.writeFileSync(path.join(run,'visual-proof.json'),JSON.stringify({algorithm:'AES-256-GCM/RSA-OAEP-SHA256',iv:iv.toString('base64'),aad:aad.toString('base64'),tag:cipher.getAuthTag().toString('base64'),wrapped:wrapped.toString('base64'),ciphertext:ciphertext.toString('base64')}));
console.log('Encrypted 5 synthetic visual proofs; no plaintext artifact/key exported.');
