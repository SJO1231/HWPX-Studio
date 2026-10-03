import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { analyze, boundData, checkProject, confirmFields, normalize, parseCondition, parseCsv, parseXlsx, renderTemplate, schemaFrom, sourceLines } from '../src/core.ts';
import { applyProject, markdownHwpx, nativeHwpx } from '../src/hwpx.ts';
import { demo, demoSources } from '../src/demo.ts';
import { createApp } from '../src/server.ts';
import { openPackage, parseDocument, listFields, readArchive, readEntry, validateDocument, compileDocument, walkParagraphs, compareToBaseline } from '@hwpx-studio/engine';
import { initSync, HwpDocument } from '../vendor/rhwp/rhwp.js';
import JSZip from 'jszip';
import type { Project, Field, Source } from '../src/model.ts';

const text=(bytes:Uint8Array)=>parseDocument(openPackage(bytes)).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText)).join('\n');
const fixture=(name:string)=>readFileSync(new URL(`../samples/${name}`,import.meta.url));
const source=(name:string,b:Uint8Array)=>({id:name,name,kind:'hwpx' as const,content:Buffer.from(b).toString('base64')});
function baseNative(bytes:Uint8Array):Project {const p=demo();p.mode='hwpx';p.sources=[source('master.hwpx',bytes)];p.blocks=[];p.ranges=[];p.markdown='';return p;}
const artifact=(name='')=>fileURLToPath(new URL('../artifacts/'+name,import.meta.url));
mkdirSync(artifact(),{recursive:true});

test('조건, 수동 선택, 누락값, Markdown 값의 구조 주입 방지',()=>{
  const p=demo();
  assert.equal(renderTemplate(p,p.records[0]).selections.qualification.id,'direct');
  assert.equal(renderTemplate(p,p.records[1]).selections.qualification.id,'sme');
  assert.equal(renderTemplate(p,p.records[0],{qualification:'general'}).selections.qualification.id,'general');
  assert.throws(()=>renderTemplate(p,{}),/필수 데이터/);
  assert.throws(()=>parseCondition('run()'),/조건 예/);
  assert.throws(()=>parseCondition('__proto__=true'),/조건 예/);
  p.markdown='{{값}}';const r=renderTemplate(p,{값:'# 제목\n![이미지](file:///secret)'});
  assert(!r.html.includes('<h1>'));assert(!r.html.includes('<img'));
  assert.equal(normalize('금 120,000,000원'),'120000000');assert.equal(normalize('00123'),'00123');
});

test('다문서 비교 → 미확정 후보 → Grid 수정/확정 → DB 매핑 → Schema',()=>{
  const p=demo();p.sources=demoSources;p.blocks=[];
  p.records=[{사업명:'서버 구매',예정금액:120000000,계약방법:'제한경쟁',납품장소:'본관 전산실'},{사업명:'모니터 구매',예정금액:35000000,계약방법:'일반경쟁',납품장소:'본관 회의실'}];
  p.fields=analyze(p.sources,p.records);
  assert(p.fields.length>=5);assert(p.fields.every(f=>!f.approved));
  assert.equal(p.fields.find(f=>f.name==='계약금액')?.column,'예정금액');
  assert.equal(p.fields.find(f=>f.name==='참가자격')?.kind,'block');
  assert.equal(confirmFields(p).markdown,demoSources[0].content);
  p.fields.forEach(f=>f.approved=true);
  const confirmed=confirmFields(p);assert(confirmed.markdown.includes('{{사업명}}'));assert(confirmed.markdown.includes('[IN_TEMPLATE:참가자격]'));
  assert.equal(boundData(confirmed,p.records[0]).계약금액,'120,000,000원');
  const derived=schemaFrom(confirmed);assert.equal(derived.records[0].예정금액,120000000);assert.equal(derived.schema.properties.예정금액.type,'number');
  assert.equal(renderTemplate(confirmed,p.records[1]).selections.참가자격.alias,'문서 1');
  const invalid={...confirmed,records:[{값:{nested:1}}]};assert.throws(()=>checkProject(invalid),/단일 값/);
});

test('CSV와 XLSX 입력: 쉼표/줄바꿈/불리언/중복 열/수식 캐시',async()=>{
  assert.deepEqual(parseCsv('이름,금액,중소기업\r\n"A,B","120,000",true\r\n"C\nD",3,false'),[{이름:'A,B',금액:'120,000',중소기업:true},{이름:'C\nD',금액:'3',중소기업:false}]);
  assert.throws(()=>parseCsv('a,a\n1,2'),/중복/);assert.throws(()=>parseCsv('a,b\n1'),/열 개수/);
  const z=new JSZip();z.file('xl/worksheets/sheet1.xml','<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>사업명</t></is></c><c r="B1" t="inlineStr"><is><t>금액</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>서버</t></is></c><c r="B2"><v>120000000</v></c></row></sheetData></worksheet>');
  assert.deepEqual(parseXlsx(await z.generateAsync({type:'uint8array'})),[{사업명:'서버',금액:'120000000'}]);
});

test('Markdown → 실제 HWPX 재파싱·표·목록·RHWP 읽기 전용 렌더',async()=>{
  const r=await applyProject(demo(),0);const b=Buffer.from(r.output,'base64');
  assert(text(b).includes('전산장비 구매'));assert(text(b).includes('직접생산'));assert(text(b).includes('120,000,000원'));assert(!text(b).includes('{{'));
  assert.equal(validateDocument(b).errors.length,0);
  initSync({module:readFileSync(new URL('../vendor/rhwp/rhwp_bg.wasm',import.meta.url))});
  const d=new HwpDocument(b);try{assert(d.pageCount()>0);assert(d.renderPageSvg(0).includes('<svg'));writeFileSync(artifact('markdown.svg'),d.renderPageSvg(0));}finally{d.free();}
  writeFileSync(artifact('markdown.hwpx'),b);
});

test('한컴 저장 누름틀 → 확정 → 채움 → Unwrap; 본문 밖 ZIP 바이트 보존',async()=>{
  const original=fixture('field-states.hwpx');const p=baseNative(original);p.records=[{성명:'홍길동 & <담당>',소속:'문서연구소'}];
  p.fields=analyze(p.sources,p.records);p.fields.forEach(f=>f.approved=true);
  const r=await applyProject(p,0);const b=Buffer.from(r.output,'base64');
  assert.equal(listFields(parseDocument(openPackage(b))).length,0);
  assert.equal(text(b).split('홍길동 & <담당>').length-1,2);assert(text(b).includes('문서연구소'));
  const before=readArchive(original),after=readArchive(b);
  for(const entry of before.entries){
    if(entry.name==='Contents/section0.xml'||entry.name==='Preview/PrvText.txt')continue;
    const next=after.entries.find(e=>e.name===entry.name)!;
    assert.deepEqual(b.subarray(next.localStart,next.localEnd),original.subarray(entry.localStart,entry.localEnd),entry.name);
  }
  assert.equal(validateDocument(b).errors.length,0);writeFileSync(artifact('native-fields.hwpx'),b);
});

test('원본 Anchor+ 범위 → 타 문서 병합 표 Fragment → 재매핑·채움·렌더',async()=>{
  const original=await markdownHwpx('# 구매 안내\n\n사업명: {{사업명}}\n\n교체 첫 문단\n\n교체 마지막 문단\n\n문서 끝');
  const compiled=compileDocument(original);assert(compiled.ok);assert('output' in compiled);
  const p=baseNative(compiled.output);p.records=[{사업명:'레이아웃 보전 시험'}];p.fields=analyze(p.sources,p.records);p.fields.forEach(f=>f.approved=true);
  p.sources.push(source('donor.hwpx',fixture('tables-merged.hwpx')));
  p.ranges=[{id:'slot',group:'table',sourceId:p.sources[0].id,from:3,to:4}];
  p.blocks=[{id:'table',group:'table',alias:'병합 표',engine_type:'hwpx_fragment',condition:'',priority:0,content:'병합 표',sourceId:'donor.hwpx',from:2,to:2}];
  const r=await applyProject(p,0);const b=Buffer.from(r.output,'base64');
  assert(!text(b).includes('교체 첫 문단'));assert(!text(b).includes('교체 마지막 문단'));assert(text(b).includes('문서 끝'));assert(text(b).includes('레이아웃 보전 시험'));
  assert.equal(validateDocument(b).errors.length,0);assert.equal(listFields(parseDocument(openPackage(b))).length,0);
  assert(new TextDecoder().decode(readEntry(readArchive(b),b,'Contents/section0.xml')).includes('rowSpan="2"'));
  initSync({module:readFileSync(new URL('../vendor/rhwp/rhwp_bg.wasm',import.meta.url))});
  const d=new HwpDocument(b);try{assert(d.renderPageSvg(0).includes('<svg'));writeFileSync(artifact('native-fragment.svg'),d.renderPageSvg(0));}finally{d.free();}
  writeFileSync(artifact('native-fragment.hwpx'),b);
  p.ranges.push({...p.ranges[0],id:'overlap'});await assert.rejects(()=>applyProject(p,0),/겹칩니다/);
});

test('Markdown Block을 원본 HWPX Anchor+에 삽입',async()=>{
  const p=baseNative(await markdownHwpx('# 제목\n\n교체 문단\n\n끝'));
  p.records=[{사업명:'서버'}];p.ranges=[{id:'slot',group:'q',sourceId:p.sources[0].id,from:2,to:2}];
  p.blocks=[{id:'q',group:'q',alias:'안내',engine_type:'markdown',condition:'',priority:0,content:'{{사업명}} 납품\n\n- 확인 사항'}];
  const r=await nativeHwpx(p,p.records[0],{});assert(text(r.bytes).includes('서버 납품'));assert(!text(r.bytes).includes('STUDIO_FRAGMENT_BOUNDARY'));
});

test('원본 placeholder와 Fragment 동시 적용: 확정 전 자동 주입 금지, 확정 후 한 번만 치환',async()=>{
  const p=baseNative(await markdownHwpx('# 제목\n\n사업명: {{사업명}}\n\n교체 문단'));
  p.records=[{사업명:'서버'}];p.ranges=[{id:'slot',group:'q',sourceId:p.sources[0].id,from:3,to:3}];
  p.blocks=[{id:'q',group:'q',alias:'안내',engine_type:'markdown',condition:'',priority:0,content:'납품 안내'}];
  p.fields=analyze(p.sources,p.records);
  await assert.rejects(()=>applyProject(p,0),/DATA_MISSING/);
  p.fields.forEach(f=>f.approved=true);
  const r=await applyProject(p,0);assert(text(Buffer.from(r.output,'base64')).includes('사업명: 서버'));
  assert(!text(Buffer.from(r.output,'base64')).includes('{{'));
});

test('공백 Field 이름: Master·Fragment·별칭을 채우고 미확정 값은 거부',async()=>{
  const p=baseNative(await markdownHwpx('# {{기관}}\n\n{{담당자 이름}} / {{담당자 이름}}\n\n교체 자리'));
  p.sources.push(source('donor',await markdownHwpx('# 조각\n\n연락: {{담당자 이름}}')));
  p.records=[{기관:'시험 기관',담당자:'홍길동 & <확인>'}];p.fields=analyze(p.sources,p.records);
  const person=p.fields.find(f=>f.name==='담당자 이름')!;person.name='담당자';person.column='담당자';
  await assert.rejects(()=>applyProject(p,0),/DATA_MISSING/);
  p.fields.forEach(f=>f.approved=true);
  const plain=await applyProject(p,0);assert.equal(text(Buffer.from(plain.output,'base64')).split('홍길동 & <확인>').length-1,2);
  p.ranges=[{id:'slot',group:'q',sourceId:p.sources[0].id,from:3,to:3}];
  p.blocks=[{id:'q',group:'q',alias:'연락',engine_type:'hwpx_fragment',condition:'',priority:0,content:'',sourceId:'donor',from:2,to:2}];
  const result=await applyProject(p,0),b=Buffer.from(result.output,'base64');
  assert.equal(text(b).split('홍길동 & <확인>').length-1,3);assert(text(b).includes('시험 기관'));assert(!text(b).includes('{{'));
  person.approved=false;await assert.rejects(()=>applyProject(p,0),/DATA_MISSING/);
  const unsupported=baseNative(await markdownHwpx('{{구매/제조}}'));unsupported.fields=[];unsupported.records=[{}];
  await assert.rejects(()=>applyProject(unsupported,0),/DATA_MISSING/);
});

test('Fragment 삽입으로 순번이 바뀐 반복 누름틀도 모두 채운다',async()=>{
  const original=fixture('field-states.hwpx'),p=baseNative(original);
  p.sources.push(source('donor',original));p.records=[{성명:'새 담당자',소속:'시험기관'}];
  p.fields=analyze(p.sources,p.records);p.fields.forEach(f=>f.approved=true);
  p.ranges=[{id:'slot',group:'q',sourceId:p.sources[0].id,from:2,to:2}];
  p.blocks=[{id:'q',group:'q',alias:'성명',engine_type:'hwpx_fragment',condition:'',priority:0,content:'',sourceId:'donor',from:3,to:3}];
  const r=await applyProject(p,0),b=Buffer.from(r.output,'base64');
  assert.equal(text(b).split('새 담당자').length-1,3);assert(!text(b).includes('이름을 입력'));
  assert.equal(listFields(parseDocument(openPackage(b))).length,0);
});

test('공고서 표: 라벨 뒤 빈칸 대신 오른쪽 실제 값 셀을 탐지·매핑·교체',async()=>{
  assert.equal(analyze([{id:'blank',name:'blank',kind:'md',content:'수요기관:   '}],[]).length,0);
  const p=baseNative(await markdownHwpx('| 항목 | 값 |\n| --- | --- |\n| 수요기관: | 원래기관 |\n| 금액: | 120,000,000원 |'));
  p.fields=analyze(p.sources,[{기관:'원래기관',예정금액:120000000}]).filter(f=>['수요기관','금액'].includes(f.name));
  assert.equal(p.fields.length,2);assert.equal(p.fields[0].column,'기관');assert.equal(p.fields[1].column,'예정금액');
  for(const f of p.fields){assert.equal(sourceLines(p.sources[0])[f.targets[0].line].text,f.values[0]);f.approved=true;}
  p.records=[{기관:'새기관',예정금액:0}];const r=await applyProject(p,0),lines=sourceLines(source('result',Buffer.from(r.output,'base64'))).map(l=>l.text);
  for(const expected of ['수요기관:','새기관','금액:','0원'])assert(lines.includes(expected),expected);
  assert(!lines.includes('원래기관'));assert(!lines.includes('120,000,000원'));
});

test('로컬 HTTP: 저장/재시작 후 복원, 출처 제한, 오류는 결과 파일 없이 반환',async()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'studio-lite-'));const db=resolve(dir,'test.sqlite');
  let server=createApp(db);
  const listen=()=>new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${(server.address() as any).port}`)));
  const close=()=>new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));
  try{
    let base=await listen();const post=(path:string,value:any,origin=base)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(value)});
    assert.equal((await fetch(base)).status,200);
    assert.equal((await post('/api/save',{project:demo()},'https://evil.example')).status,403);
    const saved=await (await post('/api/save',{project:demo()})).json() as any;assert(saved.saved);
    await close();server=createApp(db);base=await listen();
    const restored=await (await fetch(`${base}/api/project?id=${saved.id}`)).json() as any;assert.equal(restored.records[0].사업명,'전산장비 구매');
    const invalid=demo();invalid.markdown='{{없는값}}';const fail=await post('/api/apply',{project:invalid,index:0});assert.equal(fail.status,400);assert(!('output' in (await fail.json() as any)));
    assert.equal((await fetch(`${base}/../package.json`)).status,404);
  }finally{if(server.listening)await close();rmSync(dir,{recursive:true,force:true});}
});

// Fixed inputs and independent expected values: a passing case must inspect generated bytes.
const complexEvidence: {name:string;bytes:number;pages:number;warnings:string[]}[]=[];
after(()=>{if(complexEvidence.length)writeFileSync(artifact('complex-results.json'),JSON.stringify({generatedAt:new Date().toISOString(),outputs:complexEvidence},null,2));});
function inspectOutput(name:string,bytes:Uint8Array,save=false) {
  const report=validateDocument(bytes);assert.equal(report.errors.length,0,JSON.stringify(report.errors));
  assert.equal(listFields(parseDocument(openPackage(bytes))).length,0);
  initSync({module:readFileSync(new URL('../vendor/rhwp/rhwp_bg.wasm',import.meta.url))});
  const d=new HwpDocument(bytes);let pages=0;
  try {pages=d.pageCount();assert(pages>0);for(let i=0;i<pages;i++){const svg=d.renderPageSvg(i);assert(svg.includes('<svg'));if(save&&(i===0||i===pages-1))writeFileSync(artifact(`${name}-page-${i+1}.svg`),svg);}} finally {d.free();}
  if(save)writeFileSync(artifact(`${name}.hwpx`),bytes);
  complexEvidence.push({name,bytes:bytes.length,pages,warnings:report.warnings.map(w=>w.code)});
  return pages;
}

test('복합 MD: 24행 × 3그룹, 긴 본문·표·반복값·특수문자·수동 선택·전 페이지 렌더',async()=>{
  const p=demo();p.name='복합 회귀 - Markdown';
  p.records=Array.from({length:24},(_,i)=>({사업명:`RECORD_${String(i).padStart(2,'0')} & <인용>|별표*밑줄_한글😀`,예정금액:i*12345678,식별자:String(i+1).padStart(5,'0'),중소기업:i%3!==0,직접생산:i%2===0}));
  p.markdown='# 복합 구매 공고\n\n사업명: {{사업명}}\n\n금액: {{계약금액}}\n\n번호: {{식별자}}\n\n[IN_TEMPLATE:qualification]\n\n[IN_TEMPLATE:contract]\n\n[IN_TEMPLATE:payment]\n\n| 항목 | 금액 |\n| --- | --- |\n| 총액 | {{계약금액}} |\n'+Array.from({length:15},(_,i)=>`| 항목 ${i+1} | ${i+1}개 |`).join('\n')+'\n\n'+Array.from({length:100},(_,i)=>`## 조항 ${i+1}\n\n장문_${String(i+1).padStart(3,'0')} 납품과 검수 절차를 정하고 계약 조건을 확인합니다. `+'긴 문단의 줄 나눔과 페이지 경계를 점검합니다. '.repeat(3)).join('\n\n');
  p.fields=[{id:'money',name:'계약금액',column:'예정금액',kind:'field',approved:true,format:'money',values:[],targets:[],evidence:'시험 확정',confidence:1}];
  p.blocks=[
    ...p.blocks.filter(b=>b.group==='qualification').map(b=>({...b,content:`선택_${b.id}`})),
    {id:'standard',group:'contract',alias:'계약',engine_type:'markdown',condition:'',priority:0,content:'계약 대상: {{사업명}}'},
    {id:'large',group:'payment',alias:'분할',engine_type:'markdown',condition:'예정금액>=100000000',priority:10,content:'지급_분할'},
    {id:'small',group:'payment',alias:'일시',engine_type:'markdown',condition:'',priority:0,content:'지급_일시'},
  ];
  checkProject(p);const original=JSON.stringify(p);
  for(let i=0;i<p.records.length;i++) {
    const manual=i%5===0;const r=await applyProject(p,i,manual?{qualification:'general'}:{});const b=Buffer.from(r.output,'base64');const value=text(b);
    const expected=manual?'general':i%3!==0&&i%2===0?'direct':i%3!==0?'sme':'general';
    assert(value.includes(`선택_${expected}`));assert(value.includes(i*12345678>=100000000?'지급_분할':'지급_일시'));
    assert.equal(value.split(String(p.records[i].사업명)).length-1,2);assert.equal(value.split(`${(i*12345678).toLocaleString('ko-KR')}원`).length-1,2);
    assert(value.includes(String(p.records[i].식별자)));assert(value.includes('장문_001'));assert(value.includes('장문_100'));assert(!value.includes('{{'));
    assert.deepEqual([...new Set(value.match(/RECORD_\d+/g))],[`RECORD_${String(i).padStart(2,'0')}`]);
    assert(inspectOutput(`complex-md-${i}`,b,i===23)>1);
  }
  assert.equal(JSON.stringify(p),original,'생성 중 원본 프로젝트 변형');
  writeFileSync(artifact('complex-md-project.json'),JSON.stringify(p,null,2));
});

test('한컴 합성 원본: 혼합 서식은 출력 차단, 머리말/꼬리말 주입과 불변 ZIP 항목 보존',async()=>{
  for(const [file,hash] of [
    ['ph-mixed.hwpx','d9ba286a103802e9d1bbcd203b4cfc51b23f5807f144f2dd78ac7d46c2c9f6c6'],
    ['header-footer.hwpx','efbe43f78f0f1cab72eba7bdc4fa4e628441ddcdbc6ea383e63d00e058ec4378'],
  ]) {
    const original=fixture(file);assert.equal(createHash('sha256').update(original).digest('hex'),hash);
    const p=baseNative(original);p.records=[{'project.name':'복합 서버 & 장비','company.name':'회사 <A>','manager.name':'담당 가나다','manager.phone':'010-0000-0000','doc.title':'검증 제목','doc.owner':'검증 기관'}];
    p.fields=analyze(p.sources,p.records);p.fields.forEach(f=>f.approved=true);
    // The reused Core's default mixedFormat=skip protects original run formatting.
    // This fixture deliberately changes charPr inside {{project.name}}; do not flatten it to pass.
    if(file==='ph-mixed.hwpx') {await assert.rejects(()=>applyProject(p,0),/서식 경계/);assert.equal(createHash('sha256').update(fixture(file)).digest('hex'),hash);continue;}
    const r=await applyProject(p,0);const b=Buffer.from(r.output,'base64');const content=text(b);
    for(const f of p.fields)assert(content.includes(String(p.records[0][f.name])),f.name);
    assert(!content.includes('{{'));const before=readArchive(original),after=readArchive(b);
    for(const e of before.entries)if(e.name!=='Contents/section0.xml'&&e.name!=='Preview/PrvText.txt') {
      const next=after.entries.find(x=>x.name===e.name)!;assert.deepEqual(b.subarray(next.localStart,next.localEnd),original.subarray(e.localStart,e.localEnd),e.name);
    }
    inspectOutput(`complex-${file.slice(0,-5)}`,b,true);
  }
});

test('복합 원본: 3개 Anchor+ · 중첩 표 · 그림/누름틀 표 · Markdown Block 동시 삽입',async()=>{
  const p=baseNative(await markdownHwpx('# 복합 원본\n\n사업명: {{사업명}}\n\n중첩 표 자리\n\n보존 문단 A\n\n그림 표 자리\n\nMD 자리\n\n문서 끝'));
  p.records=[{사업명:'원본 복합 주입 & <A>',이름:'그림 표 담당자'}];
  for(const [file,hash] of [
    ['tables-nested.hwpx','520c8a707cc345cb6a95485dad861b602d2b88a0b8cb54d4e356965cdcc961b0'],
    ['tables-rich.hwpx','3059e345b53ec7d7a48476394ff0a19a3857cf95c80d0c5f1b5a7e4d0b767745'],
  ]) {const b=fixture(file);assert.equal(createHash('sha256').update(b).digest('hex'),hash);p.sources.push(source(file,b));}
  p.fields=analyze(p.sources,p.records).filter(f=>['사업명','이름'].includes(f.name));p.fields.forEach(f=>f.approved=true);
  p.ranges=[{id:'n',group:'nested',sourceId:p.sources[0].id,from:3,to:3},{id:'r',group:'rich',sourceId:p.sources[0].id,from:5,to:5},{id:'m',group:'md',sourceId:p.sources[0].id,from:6,to:6}];
  p.blocks=[
    {id:'n',group:'nested',alias:'중첩 표',engine_type:'hwpx_fragment',condition:'',priority:0,content:'',sourceId:'tables-nested.hwpx',from:2,to:2},
    {id:'r',group:'rich',alias:'그림 표',engine_type:'hwpx_fragment',condition:'',priority:0,content:'',sourceId:'tables-rich.hwpx',from:2,to:2},
    {id:'m',group:'md',alias:'절차',engine_type:'markdown',condition:'',priority:0,content:'## 확인 절차\n\n- {{사업명}} 검수\n- {{이름}} 확인'},
  ];
  const original=JSON.stringify(p);const r=await applyProject(p,0);const b=Buffer.from(r.output,'base64');const value=text(b);
  assert.equal(value.split('원본 복합 주입 & <A>').length-1,2);assert.equal(value.split('그림 표 담당자').length-1,2);
  assert(value.includes('보존 문단 A'));assert(value.includes('문서 끝'));assert(!value.includes('자리'));assert(!value.includes('{{'));
  const xml=new TextDecoder().decode(readEntry(readArchive(b),b,'Contents/section0.xml'));
  assert.equal((xml.match(/<hp:tbl\b/g)??[]).length,3);assert.equal((xml.match(/<hp:pic\b/g)??[]).length,1);
  const donor=fixture('tables-rich.hwpx');const picture=readArchive(donor).entries.find(e=>e.name.startsWith('BinData/'))!;
  const payload=readEntry(readArchive(donor),donor,picture.name);
  assert(readArchive(b).entries.filter(e=>e.name.startsWith('BinData/')).some(e=>Buffer.from(readEntry(readArchive(b),b,e.name)).equals(Buffer.from(payload))),'그림 원본 바이트 보존');
  assert.equal(JSON.stringify(p),original);inspectOutput('complex-native',b,true);
  writeFileSync(artifact('complex-native-project.json'),JSON.stringify(p,null,2));
});

test('3문서 비교: 문단 재배열·같은 값 열의 모호성·매핑 수정 후 각 행 생성',async()=>{
  let p=demo();p.blocks=[];p.records=[0,1,2].map(i=>({제목:`공고-${i}`,예정금액:(i+1)*1000000,다른금액:(i+1)*1000000,장소:`납품-${i}`}));
  p.sources=p.records.map((r,i)=>({id:`doc-${i}`,name:`doc-${i}.md`,kind:'md' as const,content:(i===1?[`납품장소: ${r.장소}`,`사업명: ${r.제목}`,`금액: ${Number(r.예정금액).toLocaleString('ko-KR')}원`]:[`사업명: ${r.제목}`,`금액: ${Number(r.예정금액).toLocaleString('ko-KR')}원`,`납품장소: ${r.장소}`]).join('\n')}));
  p.fields=analyze(p.sources,p.records);assert.equal(p.fields.find(f=>f.name==='금액')!.column,'','동점인 금액 열은 자동 확정 금지');
  p.fields.forEach(f=>{f.approved=true;if(f.name==='금액')f.column='예정금액';});p=confirmFields(p);
  assert.equal(schemaFrom(p).records[2].예정금액,3000000);
  for(let i=0;i<3;i++){const r=await applyProject(p,i);const b=Buffer.from(r.output,'base64');for(const expected of [`공고-${i}`,`납품-${i}`,`${i+1},000,000원`])assert(text(b).includes(expected));inspectOutput(`complex-comparison-${i}`,b);}
});

test('금액 경계: 빈 값/비유한 수 거부, 숫자 조건은 표시 형식에 영향받지 않음',async(t)=>{
  const p=demo();p.markdown='{{금액}}\n\n[IN_TEMPLATE:pay]';p.fields=[{id:'amount',name:'금액',column:'금액',kind:'field',approved:true,format:'money',values:[],targets:[],evidence:'시험',confidence:1}];
  p.blocks=[{id:'large',group:'pay',alias:'고액',engine_type:'markdown',condition:'금액>=100000000',priority:1,content:'분할 지급'},{id:'small',group:'pay',alias:'기본',engine_type:'markdown',condition:'',priority:0,content:'일시 지급'}];
  await t.test('빈 금액을 0원으로 바꾸지 않는다',()=>{for(const v of ['', ' ',null,'Infinity',false])assert.throws(()=>boundData(p,{금액:v}),/금액|값이 없/);assert.equal(boundData(p,{금액:0}).금액,'0원');});
  await t.test('JSON 비유한 수를 거부한다',()=>{for(const v of [Infinity,NaN])assert.throws(()=>checkProject({...p,records:[{금액:v}]}),/유한|숫자/);});
  await t.test('금액 포맷 뒤에도 숫자 조건이 적용된다',()=>{for(const v of [0,9,90000000,99999999,100000000,120000000])assert.equal(renderTemplate(p,{금액:v}).selections.pay.id,v>=100000000?'large':'small',String(v));});
});

test('XLSX 경계: 헤더 밖 열/오류 셀/없는 공유문자열/미계산 수식은 데이터 손실 없이 거부',async(t)=>{
  const xlsx=async(cell:string)=>{const z=new JSZip();z.file('xl/worksheets/sheet1.xml',`<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>값</t></is></c></row><row>${cell}</row></sheetData></worksheet>`);return z.generateAsync({type:'uint8array'});};
  for(const [label,cell,pattern] of [
    ['헤더 밖 열','<c r="A2"><v>1</v></c><c r="B2"><v>유실 금지</v></c>',/열|헤더/],
    ['Excel 오류','<c r="A2" t="e"><v>#DIV\/0!</v></c>',/오류/],
    ['없는 공유문자열','<c r="A2" t="s"><v>99</v></c>',/공유|문자열/],
    ['미계산 수식','<c r="A2"><f>1+1</f></c>',/캐시/],
  ] as const)await t.test(label,async()=>{const bytes=await xlsx(cell);assert.throws(()=>parseXlsx(bytes),pattern);});
  await t.test('첫 시트는 파일 번호가 아니라 통합문서의 표시 순서',async()=>{
    const z=new JSZip();z.file('xl/workbook.xml','<workbook xmlns:r="urn:rels"><sheets><sheet name="첫째" sheetId="2" r:id="rId2"/><sheet name="둘째" sheetId="1" r:id="rId1"/></sheets></workbook>');
    z.file('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>');
    for(const i of [1,2])z.file(`xl/worksheets/sheet${i}.xml`,`<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>값</t></is></c></row><row><c r="A2"><v>${i}</v></c></row></sheetData></worksheet>`);
    assert.deepEqual(parseXlsx(await z.generateAsync({type:'uint8array'})),[{값:'2'}]);
  });
  await t.test('100행 CSV: 따옴표·한글·줄바꿈·0·앞자리 0 보존',()=>{
    const rows=Array.from({length:100},(_,i)=>({식별자:String(i).padStart(5,'0'),내용:`한글, "인용"\n행-${i}`,금액:String(i),사용:i%2===0}));
    const csv=['식별자,내용,금액,사용',...rows.map(r=>Object.values(r).map(v=>`"${String(v).replaceAll('"','""')}"`).join(','))].join('\r\n');
    assert.deepEqual(parseCsv(csv),rows);
  });
});

test('실제 HTTP: 복합 입력 오류 8종은 output 없이 거절하고 다음 정상 생성은 성공',async()=>{
  const server=createApp();const base=await new Promise<string>(done=>server.listen(0,'127.0.0.1',()=>done(`http://127.0.0.1:${(server.address() as any).port}`)));
  const post=(p:Project,index=0,selected={})=>fetch(base+'/api/apply',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({project:p,index,selected})});
  try {
    const native=baseNative(await markdownHwpx('# 제목\n\n교체 자리\n\n끝'));native.records=[{사업명:'확인'}];native.fields=[];
    native.ranges=[{id:'r',group:'q',sourceId:native.sources[0].id,from:2,to:2}];native.blocks=[{id:'q',group:'q',alias:'확인',engine_type:'markdown',condition:'',priority:0,content:'정상 블록'}];
    const mutations:[string,(p:Project)=>void][]=[
      ['손상 ZIP',p=>p.sources[0].content=Buffer.from('broken').toString('base64')],
      ['범위 초과',p=>p.ranges[0].to=9999],
      ['범위 중첩',p=>p.ranges.push({...p.ranges[0],id:'overlap'})],
      ['누락된 Fragment 값',p=>p.blocks[0].content='{{없는값}}'],
      ['중복 Block ID',p=>p.blocks.push({...p.blocks[0]})],
      ['중첩 데이터',p=>p.records[0].사업명={nested:true}],
      ['빈 레코드',p=>p.records=[]],
      ['잘못된 조건',p=>p.blocks[0].condition='run()'],
    ];
    for(const [label,mutate] of mutations){const p=structuredClone(native);mutate(p);const res=await post(p);const body=await res.json() as any;assert.equal(res.status,400,label);assert.equal(typeof body.error,'string');assert(!('output' in body),label);}
    const res=await post(native);assert.equal(res.status,200);const body=await res.json() as any;assert(text(Buffer.from(body.output,'base64')).includes('정상 블록'));
    assert.equal((await fetch(base+'/api/health')).status,200);
  } finally {await new Promise<void>((done,fail)=>server.close(e=>e?fail(e):done()));}
});

// Reviewed historical expectations are keyed by content hash, never filename.
const corpusBaseline=JSON.parse(readFileSync(new URL('./notice-baseline.json',import.meta.url),'utf8'));
function corpusExpectations(hashes: string[]) {
  const expected=new Map<string,string>();
  // Recognizing the reference corpus requires its full reviewed coverage, even if files disappeared.
  if(corpusBaseline.documents.some((doc:any)=>hashes.includes(doc.sha256)))hashes=corpusBaseline.documents.map((doc:any)=>doc.sha256);
  for(const doc of corpusBaseline.documents)if(hashes.includes(doc.sha256)&&doc.fill!=='none')for(let i=0;i<3;i++)expected.set(doc.sha256.slice(0,10)+'-fill-'+i,doc.fill);
  const ids=hashes.map(h=>h.slice(0,10));
  for(const item of corpusBaseline.fragments)if(item.name.split('-fragment-').every((id:string)=>ids.includes(id)))expected.set(item.name,item.status);
  return expected;
}
function corpusFailure(stage:string,code:string,expected?:string) {
  return stage==='generate' && expected!==undefined && expected!=='passed' && expected===code?'rejected':'failed';
}
function assertCorpusReport(report:any,expected:Map<string,string>) {
  assert(report.originalsUnchanged,'원본 파일이 변경되었습니다.');
  assert.equal(report.documents.filter((d:any)=>d.status==='analysis_failed').length,0,'분석 실패: report.json 확인');
  assert.equal(report.summary.failed,0,'예상하지 않은 생성/출력/보존/렌더 결함: report.json 확인');
  assert(report.summary.passed>0,'생성 성공 0건: 검증을 통과할 수 없습니다.');
  for(const [name,status] of expected){const found=report.cases.find((c:any)=>c.name===name);assert(found,'기준 시험 누락: '+name);assert(found.status==='passed'||(status!=='passed'&&found.status==='rejected'&&found.code===status),'기존 성공 범위 감소 또는 차단 사유 변경: '+name);}
}

test('회귀: 코퍼스는 미예상 예외와 성공 범위 감소를 차단하고 지정한 차단만 인정',()=>{
  assert.equal(corpusExpectations([corpusBaseline.documents[0].sha256]).size,106,'참고자료가 일부 빠져도 전체 기준 시험을 요구한다');
  assert.equal(corpusFailure('generate','TypeError','MIXED_FORMAT'),'failed');
  assert.equal(corpusFailure('generate','MIXED_FORMAT'),'failed');
  assert.equal(corpusFailure('generate','MIXED_FORMAT','MIXED_FORMAT'),'rejected');
  assert.equal(corpusFailure('render','MIXED_FORMAT','MIXED_FORMAT'),'failed');
  const report={originalsUnchanged:true,documents:[],summary:{failed:0,passed:1},cases:[{name:'kept',status:'passed'}]};
  assert.throws(()=>assertCorpusReport(report,new Map([['missing','passed']])),/누락/);
  assert.throws(()=>assertCorpusReport({...report,cases:[...report.cases,{name:'lost',status:'rejected',code:'DATA_MISSING'}]},new Map([['lost','passed']])),/성공 범위 감소/);
  assert.throws(()=>assertCorpusReport({...report,summary:{failed:0,passed:0}},new Map()),/성공 0건/);
});

// Opt-in local corpus campaign. Never writes to the corpus or the user's SQLite.
// Automatic confirmation here is a simulated Grid action, not approval of a real template.
if(process.env.HWPX_CORPUS_DIR) test('참고자료 공고서 시뮬레이션',async()=>{
  const root=resolve(process.env.HWPX_CORPUS_DIR!);
  const out=resolve(process.env.HWPX_CORPUS_OUT_DIR??artifact(),`notice-simulation-${new Date().toISOString().replace(/[:.]/g,'-')}`);mkdirSync(out,{recursive:true});
  const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
  const paths:string[]=[];
  function scan(dir:string){for(const e of readdirSync(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())scan(path);else if(e.isFile()&&/공고서.*\.hwpx$/i.test(e.name))paths.push(path);}}
  scan(root);assert(paths.length>0,'공고서 HWPX가 없습니다.');
  const snapshots=paths.sort().map(path=>({path,hash:sha(readFileSync(path))}));
  const unique=snapshots.filter((x,i)=>snapshots.findIndex(y=>y.hash===x.hash)===i);
  const report:any={started:new Date().toISOString(),root,matched:paths.length,unique:unique.length,duplicates:paths.length-unique.length,files:snapshots.map(x=>({file:relative(root,x.path),sha256:x.hash})),documents:[],cases:[],comparisons:[],originalsUnchanged:false};
  const cases:any[]=report.cases;
  const expectedCases=corpusExpectations(unique.map(x=>x.hash));
  const compact=(name:string)=>name.replace(/\s/g,'');
  const relevant=(f:Field)=>f.confidence===1||/^(수요기관|사업명|공고명|품명|세부품명|사업예산|사업금액|추정가격|계약방법|납품기한|납품장소|수량|수량및단위|입찰공고번호|공고번호)$/.test(compact(f.name));
  const records=(fields:Field[],label:string)=>Array.from({length:3},(_,i)=>Object.fromEntries(fields.map((f,j)=>[f.column,f.format==='money'?[120000000,0,987654321][i]:`SIM_${label}_${i}_${j}${i===2?' 한글 & <검증> '.repeat(8):''}`])));
  const expectedValue=(f:Field,row:Record<string,unknown>)=>f.format==='money'?`${Number(row[f.column]).toLocaleString('ko-KR')}원`:String(row[f.column]);
  const selectedFields=(all:Field[])=>all.filter(relevant).map(f=>({...f,approved:true,kind:'field' as const,column:compact(f.name),format:/예산|금액|가격/.test(compact(f.name))?'money' as const:'text' as const}));
  const clean=(s:string)=>s.replace(/\uFFFC/g,'');
  function expectedLines(s:Source,fields:Field[],row:Record<string,unknown>){
    const lines=sourceLines(s);const edits=new Map<number,{start:number;end:number;value:string}[]>();
    for(const f of fields)for(const target of f.targets.filter(t=>t.sourceId===s.id)){
      const group=edits.get(target.line)??[];group.push({...target,value:expectedValue(f,row)});edits.set(target.line,group);
    }
    return lines.map(line=>{let content=line.text;let last=Infinity;for(const edit of (edits.get(line.line)??[]).sort((a,b)=>b.start-a.start)){assert(edit.end<=last,'SIM_OVERLAPPING_CANDIDATES');content=content.slice(0,edit.start)+edit.value+content.slice(edit.end);last=edit.start;}return{...line,text:clean(content)};});
  }
  function qualification(s:Source){const d=parseDocument(openPackage(Buffer.from(s.content,'base64')));const ps=d.sections[0].paragraphs;
    const start=ps.findIndex(p=>/^\s*\d+\s*[.．]\s*입찰\s*참가\s*자격/.test(clean(p.logicalText)));
    if(start<0)return undefined;let end=start+1;while(end<ps.length&&!/^\s*\d+\s*[.．]\s*\S/.test(clean(ps[end].logicalText)))end++;
    return{from:start+1,to:end};
  }
  const loaded:{source:Source;fields:Field[];meta:any;range:ReturnType<typeof qualification>}[]=[];
  initSync({module:readFileSync(new URL('../vendor/rhwp/rhwp_bg.wasm',import.meta.url))});
  async function runCase(name:string,p:Project,index:number,expected:string[],preserve:boolean) {
    let stage='generate';const result:any={name,document:p.sources[0]?.id,index,status:'pending',stage};cases.push(result);
    try {
      const r=await applyProject(p,index);const bytes=Buffer.from(r.output,'base64');stage='reread';
      const actual=sourceLines(source('result',bytes)).map(l=>clean(l.text));
      if(actual.length!==expected.length||actual.some((x,i)=>x!==expected[i])) {
        result.difference={expectedParagraphs:expected.length,actualParagraphs:actual.length,first:actual.findIndex((x,i)=>x!==expected[i])};
        throw new Error('SIM_TEXT_MISMATCH');
      }
      const before=Buffer.from(p.sources[0].content,'base64');const vb=validateDocument(before),va=validateDocument(bytes);
      assert.equal(compareToBaseline(vb,va).newErrors.length,0,'SIM_NEW_XML_ERRORS');
      if(preserve){stage='preservation';assert.equal(va.census.tables,vb.census.tables,'SIM_TABLE_COUNT');assert.equal(va.census.pictures,vb.census.pictures,'SIM_PICTURE_COUNT');
        const old=readArchive(before),next=readArchive(bytes);for(const e of old.entries)if(!/^Contents\/section\d+\.xml$/.test(e.name)&&e.name!=='Preview/PrvText.txt'){
          const n=next.entries.find(x=>x.name===e.name);assert(n,'SIM_ZIP_MISSING');assert(Buffer.from(bytes.subarray(n.localStart,n.localEnd)).equals(before.subarray(e.localStart,e.localEnd)),'SIM_ZIP_CHANGED');
        }
      }
      stage='render';const d=new HwpDocument(bytes);try{result.pages=d.pageCount();assert(result.pages>0,'SIM_NO_PAGES');for(let i=0;i<result.pages;i++)assert(d.renderPageSvg(i).includes('<svg'),'SIM_RENDER');}finally{d.free();}
      result.fields=p.fields.length;result.targets=p.fields.reduce((n,f)=>n+f.targets.filter(t=>t.sourceId===p.sources[0].id).length,0);
      result.remainingFields=listFields(parseDocument(openPackage(bytes))).length;result.errors=va.errors.length;result.warnings=[...new Set(va.warnings.map(x=>x.code))];result.status='passed';result.stage='complete';
      if(index===0){writeFileSync(join(out,`${name}.hwpx`),bytes);result.output=`${name}.hwpx`;result.expectedMarkers=[...new Set(expected.join('\n').match(/SIM_[\w]+/g)??[])];}
    } catch(e:any) {result.stage=stage;result.code=e.code??(/SIM_[A-Z_]+/.exec(e.message)?.[0])??(/\b[A-Z][A-Z_]{3,}\b/.exec(e.message)?.[0])??(e.message.includes('서식 경계')?'MIXED_FORMAT':e.name);result.message=e.message;result.status=corpusFailure(stage,result.code,expectedCases.get(name));}
  }
  try {
    for(const entry of unique) {
      const id=entry.hash.slice(0,10),bytes=readFileSync(entry.path),s=source(id,bytes);const meta:any={id,file:relative(root,entry.path),sha256:entry.hash,bytes:bytes.length};report.documents.push(meta);
      try {
        const v=validateDocument(bytes);meta.census=v.census;meta.baselineErrors=v.errors.map(e=>e.code);meta.baselineWarnings=[...new Set(v.warnings.map(e=>e.code))];
        const all=analyze([s],[]);assert(all.every(f=>!f.approved));const fields=selectedFields(all);meta.candidates=all.length;meta.selected=fields.length;meta.strong=fields.filter(f=>f.confidence===1).length;
        assert(fields.every(f=>f.confidence===1||f.values[0].trim()),'SIM_BLANK_VALUE_CANDIDATE');
        const range=qualification(s);loaded.push({source:s,fields,meta,range});
        if(!fields.length){meta.status='no_relevant_fields';continue;}
        let p=baseNative(bytes);p.name=`SIM_${id}`;p.sources=[s];p.fields=fields;p.records=records(fields,id);checkProject(p);p=confirmFields(p);
        for(let i=0;i<3;i++)await runCase(`${id}-fill-${i}`,p,i,expectedLines(s,fields,p.records[i]).map(l=>l.text),true);
        meta.status='analyzed';console.log(`CORPUS ${id}: ${cases.filter(c=>c.document===id&&c.status==='passed').length}/3 generated`);
      }catch(e:any){meta.status='analysis_failed';meta.code=e.code??e.name;}
      writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));
    }
    // Three comparable real pairs; explicit simulated ranges from heading to next numbered heading.
    const candidates=loaded.filter(x=>x.range&&x.fields.length&&cases.some(c=>c.document===x.source.id&&c.status==='passed'));
    const pairs=Array.from({length:Math.min(3,Math.floor(candidates.length/2))},(_,i)=>[candidates[2*i],candidates[2*i+1]]);
    const populated=candidates.filter(x=>x.meta.strong===0);if(populated.length>=2)pairs.push(populated.slice(0,2));
    for(const [i,[a,b]] of pairs.entries()) {
      const drafts=analyze([a.source,b.source],[]);
      const comparison:any={master:a.source.id,donor:b.source.id,draftFields:drafts.length,unapproved:drafts.every(f=>!f.approved),variable:drafts.filter(f=>new Set(f.values.filter(Boolean)).size>1).length};report.comparisons.push(comparison);
      // Independently named DB columns, populated from actual document samples.
      const scalar=drafts.filter(f=>relevant(f)&&f.confidence<1&&f.values.every(Boolean));
      const sampleRows=[0,1].map(n=>Object.fromEntries(scalar.map((f,j)=>[`db_${j}`,normalize(f.values[n])])));
      const inferred=analyze([a.source,b.source],sampleRows);
      const unambiguous=scalar.filter(f=>scalar.filter(other=>other.values.every((v,j)=>normalize(v)===normalize(f.values[j]))).length===1);
      for(const f of unambiguous)assert.equal(inferred.find(x=>x.id===f.id)!.column,`db_${scalar.indexOf(f)}`,'SIM_DB_MAPPING');
      comparison.actualValueMapping={columns:scalar.length,unambiguous:unambiguous.length,matched:unambiguous.length};
      const fields=selectedFields(drafts);const p=baseNative(Buffer.from(a.source.content,'base64'));p.sources=[a.source,b.source];p.fields=fields;p.records=records(fields,`pair${i}`);
      p.ranges=[{id:'qualification',group:'qualification',sourceId:a.source.id,...a.range!}];
      p.blocks=[{id:'donor',group:'qualification',alias:'시험 교체',engine_type:'hwpx_fragment',condition:'',priority:0,content:'',sourceId:b.source.id,...b.range!}];
      const master=expectedLines(a.source,fields,p.records[0]),donor=expectedLines(b.source,fields,p.records[0]);
      const expected=[...master.filter(l=>l.section===0&&l.path[0]<a.range!.from-1),...donor.filter(l=>l.section===0&&l.path[0]>=b.range!.from-1&&l.path[0]<b.range!.to),...master.filter(l=>l.section!==0||l.path[0]>=a.range!.to)].map(l=>l.text);
      await runCase(`${a.source.id}-fragment-${b.source.id}`,p,0,expected,false);
    }
  } finally {
    report.originalsUnchanged=snapshots.every(x=>sha(readFileSync(x.path))===x.hash);
    report.finished=new Date().toISOString();report.summary={attempted:cases.length,passed:cases.filter(c=>c.status==='passed').length,rejected:cases.filter(c=>c.status==='rejected').length,failed:cases.filter(c=>c.status==='failed').length,pages:cases.filter(c=>c.status==='passed').reduce((n,c)=>n+c.pages,0)};
    writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));if(!process.env.HWPX_CORPUS_OUT_DIR)writeFileSync(artifact('notice-simulation-latest.txt'),out);
    console.log(JSON.stringify({report:join(out,'report.json'),...report.summary,originalsUnchanged:report.originalsUnchanged}));
  }
  assertCorpusReport(report,expectedCases);
});

test('회귀: 원본 Fragment 미승인 후보는 DB에 있어도 주입하지 않는다',async()=>{
  const p=baseNative(await markdownHwpx('# 제목\n\n자리'));
  p.sources.push(source('donor',await markdownHwpx('# 조각\n\n담당: {{담당자}}')));
  p.records=[{담당자:'승인 전 비밀'}];p.fields=analyze(p.sources,p.records);
  p.ranges=[{id:'r',group:'q',sourceId:p.sources[0].id,from:2,to:2}];
  p.blocks=[{id:'q',group:'q',alias:'연락',engine_type:'hwpx_fragment',condition:'',priority:0,content:'',sourceId:'donor',from:2,to:2}];
  await assert.rejects(()=>applyProject(p,0),/DATA_MISSING/);
  p.fields[0].approved=true;p.fields[0].name='연락처';p.fields[0].column='담당자';
  assert(text(Buffer.from((await applyProject(p,0)).output,'base64')).includes('승인 전 비밀'));
});

test('회귀: 같은 Field 이름과 ID, 원본 별칭의 충돌은 거부하고 명시적 병합은 허용',async()=>{
  const p=baseNative(await markdownHwpx('첫째: {{첫째}}\n\n둘째: {{둘째}}'));
  p.records=[{첫째:111,둘째:222}];p.fields=analyze(p.sources,p.records);p.fields.forEach(f=>f.approved=true);
  for(const property of ['name','id'] as const){const bad=structuredClone(p);bad.fields[1][property]=bad.fields[0][property];assert.throws(()=>checkProject(bad),/중복|충돌/);assert.throws(()=>confirmFields(bad),/중복|충돌/);await assert.rejects(()=>applyProject(bad,0),/중복|충돌/);}
  const alias=structuredClone(p);alias.fields[0].name='둘째';alias.fields[1].name='다른이름';
  assert.throws(()=>checkProject(alias),/중복|충돌/);
  p.fields[0].targets.push(...p.fields[1].targets);p.fields.splice(1,1);
  const output=text(Buffer.from((await applyProject(p,0)).output,'base64'));
  assert(output.includes('첫째: 111'));assert(output.includes('둘째: 111'));
});

test('회귀: 원본과 Markdown Fragment의 데이터 토큰은 한 번만 치환한다',async()=>{
  for(const engine_type of ['hwpx_fragment','markdown'] as const){
    const p=baseNative(await markdownHwpx('# {{추가값}}\n\n자리\n\n유지 문단'));
    p.sources.push(source('donor',await markdownHwpx('# 조각\n\n{{본문}} / {{본문}}')));
    p.records=[{본문:'{{추가값}} & <문자>',추가값:'별도 실제값'}];p.fields=analyze(p.sources,p.records);p.fields.forEach(f=>f.approved=true);
    p.ranges=[{id:'r',group:'q',sourceId:p.sources[0].id,from:2,to:2}];
    p.blocks=[{id:'q',group:'q',alias:'본문',engine_type,condition:'',priority:0,content:'{{본문}} / {{본문}}',sourceId:'donor',from:2,to:2}];
    const output=text(Buffer.from((await applyProject(p,0)).output,'base64'));
    assert.equal(output.split('{{추가값}} & <문자>').length-1,2,engine_type);assert.equal(output.split('별도 실제값').length-1,1);
  }
});

test('회귀: 점이 있는 평면 열과 금액 별칭 조건은 실제 숫자로 판정한다',()=>{
  const p=demo();p.markdown='{{project.amount}}\n\n[IN_TEMPLATE:pay]';
  p.fields=[{id:'amount',name:'project.amount',column:'raw.amount',kind:'field',approved:true,format:'money',values:[],targets:[],evidence:'시험',confidence:1}];
  p.blocks=[{id:'large',group:'pay',alias:'고액',engine_type:'markdown',condition:'project.amount>=100000000 AND flags.sme=true',priority:1,content:'분할'}, {id:'small',group:'pay',alias:'기본',engine_type:'markdown',condition:'',priority:0,content:'일시'}];
  for(const amount of [0,99999999,100000000,120000000]){const row={'raw.amount':amount,'flags.sme':true,project:'평면 키 공존'};const r=renderTemplate(p,row);assert.equal(r.selections.pay.id,amount>=100000000?'large':'small');assert(r.rendered.includes(`${amount.toLocaleString('ko-KR')}원`));}
});

test('회귀: 손상 공고서만 있는 코퍼스는 실제 테스트 프로세스에서 실패한다',async()=>{
  const {spawnSync}=await import('node:child_process');
  const dir=mkdtempSync(join(tmpdir(),'lite-corrupt-corpus-'));
  try{
    writeFileSync(join(dir,'공고서-손상.hwpx'),'not-a-zip');
    const env:NodeJS.ProcessEnv={...process.env,HWPX_CORPUS_DIR:dir,HWPX_CORPUS_OUT_DIR:join(dir,'reports')};delete env.NODE_TEST_CONTEXT;
    const child=spawnSync(process.execPath,['--test','--test-name-pattern=^참고자료 공고서 시뮬레이션$',fileURLToPath(import.meta.url)],{encoding:'utf8',timeout:60000,env});
    assert.equal(child.error,undefined);assert.notEqual(child.status,0,child.stdout+child.stderr);
    assert.match(child.stdout+child.stderr,/분석 실패|analysis_failed/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('회귀: 여러 Anchor+ 이동 뒤에도 Markdown 작성 범위의 권한이 원본으로 번지지 않는다',async()=>{
  const p=baseNative(await markdownHwpx('# 제목\n\n앞 자리\n\n뒤 자리\n\n끝'));
  p.sources.push(source('raw',await markdownHwpx('# 조각\n\n고정 첫째\n\n고정 둘째')));
  p.records=[{값:'직접 작성 값'}];p.fields=[];
  p.ranges=[{id:'md',group:'md',sourceId:p.sources[0].id,from:3,to:3},{id:'raw',group:'raw',sourceId:p.sources[0].id,from:2,to:2}];
  p.blocks=[{id:'raw',group:'raw',alias:'원본',engine_type:'hwpx_fragment',condition:'',priority:0,content:'',sourceId:'raw',from:2,to:3},{id:'md',group:'md',alias:'작성',engine_type:'markdown',condition:'',priority:0,content:'| 항목 | 값 |\n| --- | --- |\n| 작성 | {{값}} |'}];
  let r=await applyProject(p,0);assert(text(Buffer.from(r.output,'base64')).includes('직접 작성 값'));assert(text(Buffer.from(r.output,'base64')).includes('고정 둘째'));
  p.sources[1]=source('raw',await markdownHwpx('# 조각\n\n고정 첫째\n\n{{값}}'));
  await assert.rejects(()=>applyProject(p,0),/DATA_MISSING/);
});
