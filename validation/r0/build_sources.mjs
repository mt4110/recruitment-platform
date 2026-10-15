// R0 fixture inputs. These are library outputs, never Excel/Sheets evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import {Workbook, SpreadsheetFile} from '@oai/artifact-tool';
const out = path.resolve(process.argv[2]);
await fs.mkdir(out, {recursive:true});
for (const [name,title] of [['resume','履歴書'],['career-history','職務経歴書']]) {
  const wb=Workbook.create(), sheet=wb.worksheets.add(title), detail=wb.worksheets.add('補足');
  for(const s of [sheet,detail]) {
    s.showGridLines=false;
    s.getRange('A1:F18').format.font={name:'Arial',size:11};
    s.getRange('A1:F18').format.columnWidth=17;
    s.getRange('A1:F18').format.rowHeight=24;
  }
  sheet.mergeCells('A2:F2');sheet.getRange('A2').values=[[`${title}（架空データ）`]];
  sheet.getRange('A2').format.font={name:'Arial',size:15,bold:true};
  sheet.getRange('A4:B4').values=[['氏名','架空 花子']];
  sheet.getRange('A5:B5').values=[['生年月日',Math.round((Date.UTC(1994,3,1)-Date.UTC(1899,11,30))/86400000)]];
  sheet.getRange('B5').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('A6').values=[['確認年齢']];
  sheet.getRange('B6').formulas=[['=YEAR(DATE(2026,10,15))-YEAR(B5)']];
  sheet.getRange('A8').values=[['経歴概要']];sheet.mergeCells('A9:F12');
  sheet.getRange('A9').values=[['架空株式会社で業務システムの開発、運用改善、利用者向けの説明資料を担当。日本語の長い文章、結合セル、写真相当の画像、日付と内部数式、複数シートの受付を確認するための架空資料です。']];
  sheet.getRange('A9:F12').format.wrapText=true;
  sheet.getRange('A14:B15').values=[['期間','所属・役割'],['2020年〜2026年','架空株式会社 開発担当']];
  sheet.getRange('A14:B14').format.fill='#E7EDF4';
  sheet.images.add({dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',anchor:{from:{row:3,col:4},extent:{widthPx:90,heightPx:110}}});
  detail.getRange('A2:B4').values=[['項目','内容'],['利用データ','すべて架空。実在する求職者情報なし。'],['言語','日本語']];
  detail.getRange('B2:B4').format.columnWidth=44;
  wb.recalculate();
  const inspected=await wb.inspect({kind:'region',sheetId:title,range:'A4:B6',maxChars:600,tableMaxRows:3,tableMaxCols:2});
  console.log(name,inspected.ndjson);
  for(const s of [sheet,detail]) {
    const png=await wb.render({sheetName:s.name,range:s===sheet?'A1:F16':'A1:C5',scale:1,format:'png'});
    await fs.writeFile(path.join(out,`${name}-${s===sheet?'main':'detail'}.png`),new Uint8Array(await png.arrayBuffer()));
  }
  const file=await SpreadsheetFile.exportXlsx(wb);await file.save(path.join(out,`${name}-source.xlsx`));
}
