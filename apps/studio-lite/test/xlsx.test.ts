import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { importXlsx, listXlsxSheets, parseXlsx } from '../src/core.ts';
import { createApp } from '../src/server.ts';

const escapeXml=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const inline=(ref:string,value:string)=>`<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
const worksheet=(rows:string)=>`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
const oneValue=(value:string)=>worksheet(`<row r="1">${inline('A1','항목')}</row><row r="2">${inline('A2',value)}</row>`);
interface Sheet { name:string; file:string; xml:string; }
async function workbook(sheets:Sheet[],options:{shared?:string;target?:string;external?:boolean}={}) {
  const z=new JSZip();
  z.file('xl/workbook.xml',`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${escapeXml(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`);
  z.file('xl/_rels/workbook.xml.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${escapeXml(i===0&&options.target!==undefined?options.target:'worksheets/'+s.file)}"${i===0&&options.external?' TargetMode="External"':''}/>`).join('')}</Relationships>`);
  for(const s of sheets)z.file('xl/worksheets/'+s.file,s.xml);
  if(options.shared!==undefined)z.file('xl/sharedStrings.xml',`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${options.shared}</sst>`);
  return z.generateAsync({type:'uint8array'});
}
const simple=(xml:string)=>workbook([{name:'자료',file:'sheet1.xml',xml}]);
const dataWorkbook=()=>workbook([
  {name:'안내',file:'sheet9.xml',xml:oneValue('안내 문구')},
  {name:'자료 1',file:'sheet7.xml',xml:oneValue('둘째 자료')},
  {name:'자료 2',file:'sheet2.xml',xml:oneValue('셋째 자료')},
]);

test('XLSX 가져오기: 표시 순서대로 목록을 만들고 둘째 시트를 기본 선택, 셋째 시트 직접 선택',async()=>{
  const bytes=await dataWorkbook(),snapshot=Buffer.from(bytes);
  const sheets=[{index:0,name:'안내'},{index:1,name:'자료 1'},{index:2,name:'자료 2'}];
  assert.deepEqual(listXlsxSheets(bytes),sheets);
  assert.deepEqual(importXlsx(bytes),{sheets,selectedSheet:1,records:[{항목:'둘째 자료'}],warnings:[]});
  assert.deepEqual(importXlsx(bytes,2),{sheets,selectedSheet:2,records:[{항목:'셋째 자료'}],warnings:[]});
  assert.deepEqual(Buffer.from(bytes),snapshot,'가져오기 중 원본 바이트 변경');
});

test('XLSX 가져오기: 첫 안내 시트와 범위 밖·비정수 선택을 거부',async()=>{
  const bytes=await dataWorkbook();
  for(const index of [0,-1,3,1.5,NaN,Infinity,'2',null])assert.throws(()=>importXlsx(bytes,index as number));
});

test('XLSX 가져오기: 한 시트 파일은 첫 시트를 유지',async()=>{
  const bytes=await simple(oneValue('단일 자료'));
  assert.deepEqual(importXlsx(bytes),{sheets:[{index:0,name:'자료'}],selectedSheet:0,records:[{항목:'단일 자료'}],warnings:[]});
  assert.deepEqual(importXlsx(bytes,0).records,[{항목:'단일 자료'}]);
});

test('XLSX 가져오기: 숫자·수식 캐시·false·앞자리 0·빈값·점 키·명시 문자열 보존',async()=>{
  const headers=['수량','금액','계산값','활성','식별자','공유 식별자','빈값','점.키','명시문자'];
  const xml=worksheet(`<row r="1">${headers.map((h,i)=>inline(String.fromCharCode(65+i)+'1',h)).join('')}</row><row r="2"><c r="A2"><v>0</v></c><c r="B2"><v>120000000</v></c><c r="C2"><f>1+2</f><v>3</v></c><c r="D2" t="b"><v>0</v></c>${inline('E2','00123')}<c r="F2" t="s"><v>0</v></c><c r="G2"/>${inline('H2','00007')}${inline('I2','false')}</row>`);
  const bytes=await workbook([{name:'자료',file:'sheet1.xml',xml}],{shared:'<si><t>000045</t></si>'});
  assert.deepEqual(importXlsx(bytes).records,[{수량:0,금액:120000000,계산값:3,활성:false,식별자:'00123','공유 식별자':'000045',빈값:'','점.키':'00007',명시문자:'false'}]);
});

test('XLSX 가져오기: 이름 없는 열만 제외하고 경고, 오른쪽 이름 있는 열·빈 셀 유지',async()=>{
  const xml=worksheet(`<row r="1">${inline('A1','항목')}${inline('B1','')}${inline('C1','금액')}${inline('D1','빈값')}</row><row r="2">${inline('A2','보존')}<c r="B2"><v>100</v></c><c r="C2"><v>0</v></c></row>`);
  const result=importXlsx(await simple(xml));
  assert.deepEqual(result.records,[{항목:'보존',금액:0,빈값:''}]);
  assert(result.warnings.length>0);assert(result.warnings.some(w=>w.includes('B')));
});

for(const [name,cells] of [
  ['캐시 없는 수식','<c r="A2"><f>1+2</f></c>'],
  ['오류 셀','<c r="A2" t="e"><v>#VALUE!</v></c>'],
  ['공유 문자열 참조 없음','<c r="A2" t="s"><v>9</v></c>'],
  ['잘못된 공유 문자열 번호','<c r="A2" t="s"><v>1.5</v></c>'],
  ['무한 숫자','<c r="A2"><v>1e309</v></c>'],
  ['NaN 숫자','<c r="A2"><v>NaN</v></c>'],
  ['안전 범위 밖 정수','<c r="A2"><v>9007199254740992</v></c>'],
] as const)test(`XLSX 가져오기 거부: ${name}`,async()=>{
  const bytes=await simple(worksheet(`<row r="1">${inline('A1','값')}</row><row r="2">${cells}</row>`));
  assert.throws(()=>importXlsx(bytes));
});

test('XLSX 가져오기 거부: 중복된 이름 있는 열',async()=>{
  const bytes=await simple(worksheet(`<row r="1">${inline('A1','값')}${inline('B1','값')}</row><row r="2">${inline('A2','첫값')}${inline('B2','둘째값')}</row>`));
  assert.throws(()=>importXlsx(bytes),/중복/);
});

for(const [name,options] of [
  ['외부 시트',{target:'https://example.invalid/sheet.xml',external:true}],
  ['폴더 밖 상대 경로',{target:'../../outside.xml'}],
  ['연결된 시트 없음',{target:'worksheets/missing.xml'}],
] as const)test(`XLSX 가져오기 거부: ${name}`,async()=>{
  const bytes=await workbook([{name:'자료',file:'sheet1.xml',xml:oneValue('안전 자료')}],options);
  assert.throws(()=>listXlsxSheets(bytes));assert.throws(()=>importXlsx(bytes));
});

test('기존 parseXlsx: 첫 시트·숫자 문자열·엄격한 헤더 밖 거부 기준 유지',async()=>{
  assert.deepEqual(parseXlsx(await dataWorkbook()),[{항목:'안내 문구'}]);
  const normal=worksheet(`<row r="1">${inline('A1','금액')}</row><row r="2"><c r="A2"><v>0</v></c></row>`);
  assert.deepEqual(parseXlsx(await simple(normal)),[{금액:'0'}]);
  const outside=worksheet(`<row r="1">${inline('A1','값')}</row><row r="2">${inline('A2','첫값')}${inline('B2','헤더 없음')}</row>`);
  const outsideBytes=await simple(outside);assert.throws(()=>parseXlsx(outsideBytes),/헤더/);
});

test('HTTP XLSX 가져오기: 시트 선택·타입·경고를 응답하고 안내 시트는 거부',async()=>{
  const server=createApp();
  const base=await new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${(server.address() as any).port}`)));
  const bytes=await dataWorkbook();
  const post=(content:Uint8Array,sheetIndex?:number)=>fetch(base+'/api/import-data',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({name:'synthetic.xlsx',content:Buffer.from(content).toString('base64'),...(sheetIndex===undefined?{}:{sheetIndex})})});
  try {
    const first=await post(bytes);assert.equal(first.status,200);assert.deepEqual(await first.json(),importXlsx(bytes));
    const third=await post(bytes,2);assert.equal(third.status,200);assert.deepEqual(await third.json(),importXlsx(bytes,2));
    const guide=await post(bytes,0);assert.equal(guide.status,400);assert(!Object.hasOwn(await guide.json() as object,'records'));
    const typed=await simple(worksheet(`<row r="1">${inline('A1','금액')}${inline('B1','')}${inline('C1','활성')}</row><row r="2"><c r="A2"><v>0</v></c>${inline('B2','제외')}<c r="C2" t="b"><v>0</v></c></row>`));
    const result=await post(typed);assert.equal(result.status,200);const body=await result.json() as any;
    assert.deepEqual(body.records,[{금액:0,활성:false}]);assert(body.warnings.some((w:string)=>w.includes('B')));assert.equal(body.selectedSheet,0);
  }finally {await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));}
});
