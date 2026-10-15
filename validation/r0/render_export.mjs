import fs from 'node:fs/promises';
import {FileBlob,SpreadsheetFile} from '@oai/artifact-tool';
const wb=await SpreadsheetFile.importXlsx(await FileBlob.load(process.argv[2]));
for(const [i,s] of wb.worksheets.items.entries()){
 const png=await wb.render({sheetName:s.name,range:i===0?'A1:F16':'A1:C5',scale:1,format:'png'});
 await fs.writeFile(`${process.argv[3]}-${i}.png`,new Uint8Array(await png.arrayBuffer()));
}
console.log((await wb.inspect({kind:'region',sheetId:wb.worksheets.getItemAt(0).name,range:'A4:B6',maxChars:500})).ndjson);
