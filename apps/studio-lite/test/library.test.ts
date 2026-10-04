import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { contentSha256, emptyTemplate, extractFragment, openPackage, parseDocument, serializeFragment, templateSha256, writeStudioTemplate, type BlockContent, type BlockProto, type StudioTemplate } from '@hwpx-studio/engine';
import { buildHwpx } from '../../../packages/hwpx-engine/test/helpers.ts';
import { createLibrary } from '../src/library.ts';

const encode=(s:string)=>new TextEncoder().encode(s);
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const base64=(bytes:Uint8Array)=>Buffer.from(bytes).toString('base64');
const SOURCE=encode('{{zero}} {{flag}} {{identifier}} {{flat}} {{nested}}\n[IN_TEMPLATE:choice]\n합성 고정 문구');
const PROTO:BlockProto={schema:'hwpx-studio/block-proto@1',id:'k00000001',version:1,name:'합성 원형',content:{text:'합성 선택 문구'},keys:[]};
const ROW={zero:0,flag:false,identifier:'000123','flat.key':'평면 값',nested:{value:'중첩 값'},empty:'',nullable:null};
const template=(parts:Partial<StudioTemplate>={}):StudioTemplate=>({
  schema:'hwpx-studio/template@2',id:'t00000001',version:1,meta:{name:'합성 템플릿'},source:{kind:'md',sha256:sha(SOURCE)},
  anchors:[{id:'a1',kind:'line',at:{sectionIndex:0,path:[1]},print:{text:'[IN_TEMPLATE:choice]',sha256:sha(encode('[IN_TEMPLATE:choice]'))}}],
  values:[{id:'v1',name:'숫자',format:'money'},{id:'v2',name:'불리언',format:'text'},{id:'v3',name:'문자 번호',format:'text'},{id:'v4',name:'평면 점 키',format:'text'},{id:'v5',name:'중첩 경로',format:'text'}],
  bindings:[{value:'v1',key:'zero'},{value:'v2',key:'flag'},{value:'v3',key:'identifier'},{value:'v4',key:'flat.key'},{value:'v5',path:'nested.value'}],
  places:[{id:'p1',kind:'placeholder',key:'zero',value:'v1'},{id:'p2',kind:'placeholder',key:'flag',value:'v2'},{id:'p3',kind:'placeholder',key:'identifier',value:'v3'},{id:'p4',kind:'placeholder',key:'flat',value:'v4'},{id:'p5',kind:'placeholder',key:'nested',value:'v5'}],
  slots:[{id:'s1',name:'합성 선택 슬롯',anchors:['a1'],parent:null}],
  blocks:[{id:'b1',name:'합성 조건 블록',slot:'s1',content:PROTO.content,proto:{id:PROTO.id,version:1},when:{all:[{path:'v2',op:'eq',value:'false'}]},priority:10},{id:'b2',name:'합성 기본 블록',slot:'s1',content:{text:'합성 기본 문구'}}],
  options:{missing:'error',requireConfirm:false},...parts,
});
const payload=(t=template(),protos:BlockProto[]=[PROTO],blobs:Uint8Array[]=[SOURCE])=>({template:JSON.stringify(t),protos:protos.map(p=>JSON.stringify(p)),blobs:blobs.map(base64)});
const counts=(db:DatabaseSync)=>Object.fromEntries(['studio_blob','studio_proto','studio_template','studio_dataset'].map(table=>[table,Number(db.prepare('SELECT COUNT(*) AS n FROM '+table).get()!.n)]));
const code=(fn:()=>unknown,expected:string,status?:number)=>assert.throws(fn,(error:any)=>error?.code===expected&&(status===undefined||error.status===status));
const memory=(run:(db:DatabaseSync,library:ReturnType<typeof createLibrary>)=>void)=>{
  const db=new DatabaseSync(':memory:');
  try{run(db,createLibrary(db));}finally{db.close();}
};

test('보관함: 임시 SQLite 재시작 후 템플릿·원형 재사용·데이터 판과 미리보기 복원, 기존 저장 자료 보존',()=>{
  const directory=mkdtempSync(join(resolve(tmpdir()),'hwpx-library-'));
  let db:DatabaseSync|undefined;
  try{
    const file=join(directory,'synthetic.sqlite');db=new DatabaseSync(file);
    db.exec('CREATE TABLE project_revision(id INTEGER PRIMARY KEY, document TEXT NOT NULL)');
    const legacy=JSON.stringify({version:1,name:'합성 기존 자료',records:[ROW]});
    db.prepare('INSERT INTO project_revision VALUES(?,?)').run(1,legacy);
    let library=createLibrary(db);const first=template(),second=template({id:'t00000002',meta:{name:'합성 두 번째 템플릿'}});
    library.save(payload(first));library.save(payload(second,[],[]));
    const content=JSON.stringify([ROW,{...ROW,zero:7,flag:true,identifier:'000007'}],null,2);
    const data1=library.saveDataset({content,name:'합성 데이터'});
    const content2=JSON.stringify([{...ROW,zero:12,identifier:'000012'}]);
    const data2=library.saveDataset({content:content2,name:'합성 데이터',id:data1.id,version:data1.version});
    assert.equal(data2.id,data1.id);assert.equal(data2.version,2);
    assert.equal(library.dataset(data1.id,1).document,content);assert.equal(library.dataset(data1.id,2).document,content2);
    const raw=library.dataset(data1.id,1).records[0]!;assert('dataset' in raw);assert.deepEqual(raw.dataset.data,ROW);
    assert.equal(typeof raw.dataset.data.zero,'number');assert.equal(typeof raw.dataset.data.flag,'boolean');
    const before=library.preview(first.id,1,data1.id,1,0);
    assert.deepEqual(before.values.map(v=>v.text),['0원','false','000123','평면 값','중첩 값']);
    assert.equal(before.slots[0]?.block,'b1');assert.equal(before.slots[0]?.state,'default');
    assert.equal(library.preview(first.id,1,data1.id,1,1).slots[0]?.block,'b2');
    assert.deepEqual(library.source(first.id,1),SOURCE);assert.equal(counts(db).studio_proto,1);
    assert.equal(db.prepare('SELECT document FROM project_revision WHERE id=1').get()!.document,legacy);
    db.close();db=undefined;db=new DatabaseSync(file);library=createLibrary(db);
    assert.equal(library.templates().length,2);assert.equal(library.datasets().length,2);
    assert.equal(writeStudioTemplate(library.template(first.id,1)),writeStudioTemplate(first));
    assert.deepEqual(library.preview(first.id,1,data1.id,1,0),before);
    assert.deepEqual(library.preview(second.id,1,data1.id,1,0),before);
    assert.equal(library.dataset(data1.id,1).document,content);assert.equal(library.dataset(data2.id,2).document,content2);
    assert.deepEqual(library.source(first.id,1),SOURCE);
    assert.equal(db.prepare('SELECT document FROM project_revision WHERE id=1').get()!.document,legacy);
  }finally{
    db?.close();assert.equal(dirname(directory),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});
  }
});

test('보관함: 실제 합성 HWPX와 원시 조각을 두 템플릿에서 재사용하고 바이트 불변',()=>memory((db,library)=>{
  const source=buildHwpx(['<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>합성 조각 문단</hp:t></hp:run></hp:p>']);
  const before=Buffer.from(source);const fragment=encode(serializeFragment(extractFragment(parseDocument(openPackage(source)),{sectionIndex:0,parentPath:[],from:0,to:0})));
  const proto={...PROTO,content:{fragment:sha(fragment)}};
  const first=template({source:{kind:'hwpx',sha256:sha(source)},blocks:template().blocks.map(b=>b.id==='b1'?{...b,content:proto.content}:b)});
  library.save(payload(first,[proto],[source,fragment]));
  const second={...first,id:'t00000002'};library.save(payload(second,[],[]));
  assert.equal(counts(db).studio_proto,1);assert.equal(counts(db).studio_blob,2);
  assert.deepEqual(library.source(first.id,1),source);assert.deepEqual(library.source(second.id,1),source);
  assert.deepEqual(library.blob(sha(fragment)),fragment);assert.deepEqual(Buffer.from(source),before);
  assert.deepEqual(library.template(first.id,1).blocks[0]?.content,proto.content);
}));

test('보관함: 같은 판은 멱등 저장, 다른 내용 덮어쓰기 409, 새 판은 원본 판과 독립',()=>memory((db,library)=>{
  library.save(payload());const before=counts(db);library.save(payload());assert.deepEqual(counts(db),before);
  code(()=>library.save(payload(template({meta:{name:'변경된 합성 이름'}}))),'LIBRARY_REVISION',409);
  code(()=>library.save(payload(template(),[{...PROTO,name:'변경된 원형 이름'}])),'LIBRARY_REVISION',409);
  assert.deepEqual(counts(db),before);assert.equal(library.template('t00000001',1).meta?.name,'합성 템플릿');
  library.save(payload(template({version:2,meta:{name:'새 합성 판'}}),[],[]));
  assert.equal(library.template('t00000001',2).version,2);assert.equal(library.template('t00000001',1).meta?.name,'합성 템플릿');
  const p2={...PROTO,version:2,previous:{version:1,content:contentSha256(PROTO.content)},content:{text:'새 합성 원형'}};
  const t2=template({id:'t00000002',blocks:template().blocks.map(b=>b.id==='b1'?{...b,proto:{id:PROTO.id,version:2},content:p2.content}:b)});
  library.save(payload(t2,[p2],[]));assert.equal(counts(db).studio_proto,2);
  assert.deepEqual(library.template('t00000001',1).blocks[0]?.content,PROTO.content);
}));

for(const table of ['studio_blob','studio_proto','studio_template'])test('보관함: '+table+' 삽입 중 실패는 원본·원형·템플릿 전체 취소',()=>memory((db,library)=>{
  const before=counts(db);
  db.exec(`CREATE TRIGGER injected_failure AFTER INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'SYNTHETIC_WRITE_FAILURE'); END;`);
  assert.throws(()=>library.save(payload()),/SYNTHETIC_WRITE_FAILURE/);
  assert.deepEqual(counts(db),before);
  db.exec('DROP TRIGGER injected_failure');assert.doesNotThrow(()=>library.save(payload()));
}));

test('보관함: 미지원 판·중복 ID·깨진 참조·누락/오류 원본 해시는 저장 거부와 일괄 취소',()=>memory((db,library)=>{
  const variants:[Record<string,unknown>,string][]=[
    [{...template(),schema:'hwpx-studio/template@99'},'TPL_VERSION'],
    [{...template(),values:[...template().values,template().values[0]!]},'TPL_ID'],
    [{...template(),bindings:[{value:'missing',key:'zero'}]},'TPL_REF'],
    [{...template(),source:{kind:'md'}},'TPL_FIELD'],
    [{...template(),source:{kind:'md',sha256:'0'.repeat(64)}},'LIBRARY_REFERENCE'],
    [{...template(),blocks:template().blocks.map(b=>b.id==='b1'?{...b,proto:{id:'k00000099',version:1}}:b)},'TPL_PROTO_MISMATCH'],
  ];
  for(const [raw,expected] of variants){const before=counts(db);code(()=>library.save({...payload(),template:JSON.stringify(raw)}),expected);assert.deepEqual(counts(db),before);}
  code(()=>library.save({...payload(),template:JSON.stringify(emptyTemplate())}),'LIBRARY_INPUT',400);
  assert.deepEqual(counts(db),{studio_blob:0,studio_proto:0,studio_template:0,studio_dataset:0});
}));

test('보관함: 원형 이전 판/내용·조각 참조와 조각 JSON을 검증',()=>memory((db,library)=>{
  const previousBad={...PROTO,version:2,previous:{version:1,content:contentSha256(PROTO.content)}};
  code(()=>library.save(payload(template(),[previousBad])),'LIBRARY_REFERENCE',404);
  library.save(payload());const before=counts(db);
  code(()=>library.save(payload(template(),[{...previousBad,previous:{version:1,content:'0'.repeat(64)}}],[])),'LIBRARY_INPUT',400);
  const missingFragment:BlockContent={fragment:'a'.repeat(64)};
  code(()=>library.save(payload(template(),[{...PROTO,id:'k00000002',content:missingFragment}],[])),'LIBRARY_REFERENCE',404);
  const bad=encode('{"schema":"hwpx-studio/fragment@99"}');
  code(()=>library.save(payload(template(),[{...PROTO,id:'k00000002',content:{fragment:sha(bad)}}],[bad])),'FRAG_SCHEMA');
  assert.deepEqual(counts(db),before);
}));

test('보관함: 캐시 문서/원본 해시 변조를 거부하고 다른 유효 JSON의 ID 치환도 거부',()=>{
  memory((db,library)=>{library.save(payload());db.prepare('UPDATE studio_blob SET bytes=? WHERE sha=?').run(Buffer.from('변조된 합성 원본'),sha(SOURCE));code(()=>library.source('t00000001',1),'LIBRARY_INPUT',400);});
  memory((db,library)=>{library.save(payload());db.prepare('UPDATE studio_template SET document=?').run(JSON.stringify(template({meta:{name:'변조된 이름'}})));code(()=>library.template('t00000001',1),'LIBRARY_INPUT',400);});
  memory((db,library)=>{library.save(payload());const changed=template({id:'t00000002'});db.prepare('UPDATE studio_template SET document=?,sha=?').run(writeStudioTemplate(changed),templateSha256(changed));code(()=>library.template('t00000001',1),'LIBRARY_INPUT',400);});
  memory((db,library)=>{library.save(payload());db.prepare('UPDATE studio_proto SET document=?').run(JSON.stringify({...PROTO,id:'k00000002'}));code(()=>library.template('t00000001',1),'LIBRARY_INPUT',400);});
  memory((db,library)=>{library.save(payload());db.prepare('UPDATE studio_proto SET document=?').run(JSON.stringify({...PROTO,version:2}));code(()=>library.template('t00000001',1),'LIBRARY_INPUT',400);});
  memory((db,library)=>{library.save(payload());db.prepare('UPDATE studio_proto SET document=?').run(JSON.stringify({...PROTO,content:{text:'변조된 원형 내용'}}));code(()=>library.template('t00000001',1),'TPL_PROTO_MISMATCH');});
  memory((db,library)=>{const data=library.saveDataset({content:JSON.stringify([ROW]),name:'합성 데이터'});db.prepare('UPDATE studio_dataset SET document=?').run(JSON.stringify([{zero:9}]));code(()=>library.dataset(data.id,1),'LIBRARY_INPUT',400);});
});

test('보관함: 데이터 이전 판 불변과 새 판 증가, 잘못된 데이터/행/참조는 거부',()=>memory((db,library)=>{
  library.save(payload());const content=JSON.stringify([ROW]);const first=library.saveDataset({content,name:'합성 데이터'});
  const second=library.saveDataset({content:JSON.stringify([{...ROW,zero:1}]),name:'합성 데이터',id:first.id,version:1});
  const third=library.saveDataset({content:JSON.stringify([{...ROW,zero:2}]),name:'합성 데이터',id:first.id,version:1});
  assert.equal(second.version,2);assert.equal(third.version,3);assert.equal(library.dataset(first.id,1).document,content);
  for(const row of [-1,0.5,1])code(()=>library.preview('t00000001',1,first.id,1,row),'LIBRARY_INPUT',400);
  code(()=>library.dataset(first.id,99),'LIBRARY_REFERENCE',404);
  code(()=>library.saveDataset({content:'[]',name:'합성 데이터'}),'LIBRARY_INPUT',400);
  code(()=>library.saveDataset({content:'null',name:'합성 데이터'}),'LIBRARY_INPUT',400);
  code(()=>library.saveDataset({content:'{broken',name:'합성 데이터'}),'LIBRARY_INPUT',400);
  const bad=library.saveDataset({content:'[null]',name:'합성 오류 행'});
  code(()=>library.preview('t00000001',1,bad.id,bad.version,0),'DATA_SCHEMA',400);
  assert.equal(library.datasets().length,4);
}));

test('보관함: 삭제한 앵커·슬롯·블록 ID는 나중 판에서 재사용 거부, 새 ID는 허용',()=>memory((db,library)=>{
  library.save(payload());
  const removed=template({version:2,anchors:[],slots:[],blocks:[]});
  library.save(payload(removed,[],[]));
  const before=counts(db);
  const reused=template({version:3});
  code(()=>library.save(payload(reused,[],[encode('합성 취소 대상 원본')])),'LIBRARY_ID_REUSED',409);
  assert.deepEqual(counts(db),before,'재사용 거부 뒤 원본·원형·템플릿 추가 행이 없다');
  assert.equal(library.template('t00000001',2).anchors.length,0);
  code(()=>library.template('t00000001',3),'LIBRARY_REFERENCE',404);
  const fresh=template({
    version:3,
    anchors:template().anchors.map(anchor=>({...anchor,id:'a2'})),
    slots:[{id:'s2',name:'새 합성 슬롯',anchors:['a2'],parent:null}],
    blocks:template().blocks.map((block,index)=>({...block,id:'b'+String(index+3),slot:'s2'})),
  });
  const reuseOnlyAnchor={...fresh,anchors:template().anchors,slots:fresh.slots.map(slot=>({...slot,anchors:['a1']}))};
  const reuseOnlySlot={...fresh,slots:fresh.slots.map(slot=>({...slot,id:'s1'})),blocks:fresh.blocks.map(block=>({...block,slot:'s1'}))};
  const reuseOnlyBlocks={...fresh,blocks:template().blocks.map(block=>({...block,slot:'s2'}))};
  for(const candidate of [reuseOnlyAnchor,reuseOnlySlot,reuseOnlyBlocks]) {
    code(()=>library.save(payload(candidate,[],[])),'LIBRARY_ID_REUSED',409);
    assert.deepEqual(counts(db),before,'각 종류의 삭제 ID 재사용도 추가 행을 남기지 않는다');
  }
  library.save(payload(fresh,[],[]));
  assert.deepEqual(library.template('t00000001',3).anchors.map(anchor=>anchor.id),['a2']);
  assert.deepEqual(library.template('t00000001',3).blocks.map(block=>block.id),['b3','b4']);
}));

test('보관함: 판 1·3 저장 뒤 중간 판의 삭제가 기존 판 3의 ID 재사용을 만들면 일괄 거부',()=>memory((db,library)=>{
  library.save(payload());
  library.save(payload(template({version:3}),[],[]));
  const before=counts(db);
  const removed=template({version:2,anchors:[],slots:[],blocks:[]});
  code(()=>library.save(payload(removed,[],[encode('합성 역순 취소 대상 원본')])),'LIBRARY_ID_REUSED',409);
  assert.deepEqual(counts(db),before,'중간 판 거부 뒤 모든 테이블의 추가 행이 없다');
  code(()=>library.template('t00000001',2),'LIBRARY_REFERENCE',404);
  assert.deepEqual(library.template('t00000001',3).anchors.map(anchor=>anchor.id),['a1']);
  const continuous=template({version:2,meta:{name:'합성 연속 중간 판'}});
  library.save(payload(continuous,[],[]));
  assert.equal(library.template('t00000001',2).version,2);
  assert.equal(library.template('t00000001',3).version,3);
}));
