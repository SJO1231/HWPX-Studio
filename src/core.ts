import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import {
  parseDocument, openPackage, walkParagraphs, collectFields, makeWordAnchor,
  evaluateCondition, readArchive, readEntry, parseXmlBytes, walkElements, attrValue,
} from '../vendor/hwpx-engine/index.ts';
import type { Source, Field, Project, Block, Target } from './model.ts';

export const md = new MarkdownIt({ html: false, linkify: false, breaks: true });
// Images in templates are outside the text MVP; do not load URLs or local paths.
md.disable('image');
export const id = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export const keyOK = (s: string) => /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,79}$/u.test(s) && !s.split('.').some(x => ['__proto__','prototype','constructor'].includes(x));
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function checkProject(p: any): asserts p is Project {
  assert(object(p) && p.version === 1 && ['markdown','hwpx'].includes(p.mode as string), '프로젝트 형식이 올바르지 않습니다.');
  assert(typeof p.name === 'string' && p.name.length <= 120 && typeof p.markdown === 'string' && p.markdown.length < 200000, '제목 또는 Markdown 길이를 확인하세요.');
  for (const [k, max] of [['sources',20],['fields',500],['blocks',100],['ranges',100],['records',5000]] as const)
    assert(Array.isArray(p[k]) && (p[k] as any[]).length <= max, `${k}: 최대 ${max}개입니다.`);
  for (const s of p.sources as Source[]) assert(object(s) && typeof s.id === 'string' && typeof s.name === 'string' && ['md','hwpx'].includes(s.kind) && typeof s.content === 'string' && s.content.length < 16000000, '문서 입력을 확인하세요.');
  for (const f of p.fields as Field[]) assert(object(f) && typeof f.id === 'string' && keyOK(f.name) && (!f.column || keyOK(f.column)) && ['field','block','fixed'].includes(f.kind) && ['text','money'].includes(f.format) && typeof f.approved === 'boolean' && Array.isArray(f.targets) && Array.isArray(f.values), 'Field 이름/열/형식을 확인하세요.');
  for (const b of p.blocks as Block[]) {
    assert(object(b) && typeof b.id === 'string' && keyOK(b.group) && typeof b.alias === 'string' && b.alias.length < 120 && typeof b.content === 'string' && b.content.length < 100000 && ['markdown','hwpx_fragment'].includes(b.engine_type) && Number.isFinite(b.priority), 'Block 정의를 확인하세요.');
    parseCondition(b.condition);
  }
  for(const r of p.ranges as any[]) assert(object(r) && typeof r.id==='string' && typeof r.sourceId==='string' && keyOK(r.group as string) && Number.isInteger(r.from) && Number.isInteger(r.to) && Number(r.from)>=1 && Number(r.to)>=Number(r.from),'Anchor+ 정의를 확인하세요.');
  assert(new Set((p.sources as Source[]).map(s => s.id)).size === (p.sources as Source[]).length, '문서 ID가 중복되었습니다.');
  assert(new Set((p.blocks as Block[]).map(b => b.id)).size === (p.blocks as Block[]).length, 'Block ID가 중복되었습니다.');
  assert(p.selectedBlocks===undefined || (object(p.selectedBlocks) && Object.entries(p.selectedBlocks).every(([k,v])=>keyOK(k)&&typeof v==='string')),'저장된 Block 선택을 확인하세요.');
  checkRecords(p.records);
}

export function checkRecords(rows: any): asserts rows is Record<string, unknown>[] {
  assert(Array.isArray(rows) && rows.length <= 5000 && rows.every(object), '데이터는 JSON 객체 배열이어야 합니다(최대 5,000행).');
  for (const r of rows) for (const [k,v] of Object.entries(r)) {
    assert(keyOK(k), `지원하지 않는 열 이름: ${k}`);
    assert(v === null || ['string','boolean','number'].includes(typeof v), `${k}: MVP는 단일 값 열만 지원합니다.`);
    assert(typeof v!=='number' || Number.isFinite(v), `${k}: 유한한 숫자만 입력하세요.`);
    assert(String(v).length < 50000, '데이터 값이 너무 깁니다.');
  }
}

export function normalize(value: unknown): string {
  const s = String(value ?? '').normalize('NFKC').trim();
  // Identifiers with leading zeroes stay identifiers; only currency/numeric syntax is normalized.
  const n = s.replace(/^금\s*/, '').replace(/원(?:정)?$/, '').replace(/[,\s₩]/g, '');
  return /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(n) ? String(Number(n)) : s.replace(/\s+/g,' ').toLowerCase();
}

export function parseCondition(input: string): any {
  assert(typeof input === 'string' && input.length <= 1000, '조건은 1,000자 이내로 입력하세요.');
  if (!input.trim()) return undefined;
  // ponytail: AND-only rule table; add a structured rule editor when nested OR is needed.
  const parts = input.split(/\s+AND\s+/i);
  const all = parts.map(part => {
    const m = /^\s*([\p{L}\p{N}_ .-]+?)\s*(>=|<=|!=|==|=|>|<)\s*(.*?)\s*$/u.exec(part);
    assert(m && keyOK(m[1]) && m[3], '조건 예: 중소기업=true AND 직접생산=true');
    let value: unknown = m[3];
    if (/^(true|false|null|-?\d+(?:\.\d+)?)$/.test(m[3]) || m[3].startsWith('"')) {
      try { value = JSON.parse(m[3]); } catch { throw new Error('조건의 문자열은 큰따옴표를 닫아주세요.'); }
    }
    assert(value === null || ['string','number','boolean'].includes(typeof value), '조건 값은 단일 값이어야 합니다.');
    return { path: m[1].trim(), op: ({'=':'eq','==':'eq','!=':'ne','>':'gt','<':'lt','>=':'ge','<=':'le'} as any)[m[2]], value };
  });
  return {all};
}

export function sourceLines(source: Source) {
  if (source.kind === 'md') return source.content.replace(/\r\n/g,'\n').split('\n').map((text,line) => ({line,text,section:0,path:[line]}));
  const doc = parseDocument(openPackage(Buffer.from(source.content,'base64')));
  let line = 0;
  return doc.sections.flatMap(s => [...walkParagraphs(s.paragraphs)].map(p => ({line:line++,text:p.logicalText,section:s.index,path:p.path})));
}

export function analyze(sources: Source[], records: Record<string, unknown>[]): Field[] {
  assert(sources.length >= 1 && sources.length <= 20, '문서를 1~20개 선택하세요. 비교는 2개 이상에서 수행합니다.');
  const found = new Map<string, Field>();
  const add = (name: string, value: string, source: Source, target: Target, evidence: string, strong=false) => {
    if (!keyOK(name)) return;
    const key = name;
    let f = found.get(key);
    if (!f) { f = {id:`field-${id(key)}`,name,column:'',kind:'field',approved:false,format:/금액|가격|예산/.test(name)?'money':'text',values:sources.map(()=>''),targets:[],evidence,confidence:strong?1:0.65}; found.set(key,f); }
    if (f.targets.some(t => t.sourceId === source.id && t.line === target.line && t.start === target.start)) return;
    f.values[sources.indexOf(source)] = value;
    f.targets.push(target);
    if (strong) { f.confidence=1; f.evidence=evidence; }
  };
  for (const source of sources) {
    const lines = sourceLines(source);
    const doc = source.kind === 'hwpx' ? parseDocument(openPackage(Buffer.from(source.content,'base64'))) : undefined;
    if (doc) for (const field of collectFields(doc)) {
      const f=field.info;
      const line = lines.find(l => l.section === f.sectionIndex && l.path.join('.') === f.path.join('.'));
      const start=field.paragraph.pieces[field.begin.pieceIndex]?.logicalEnd??0;
      const end=field.end ? field.paragraph.pieces[field.end.pieceIndex]?.logicalStart??start : start;
      if (line) add(f.name, f.valueText, source, {sourceId:source.id,line:line.line,start,end,anchor:{id:`anchor-${id(source.id+f.name+f.occurrence)}`,kind:'field',name:f.name,occurrence:f.occurrence}}, `누름틀 ${f.name} / ${f.shape}`,true);
    }
    for (const l of lines) {
      if (doc && [...found.values()].some(f => f.targets.some(t => t.sourceId===source.id && t.line===l.line && t.anchor?.kind==='field'))) continue;
      const matches = [...l.text.matchAll(/\{\{([^{}]+)\}\}/g)];
      const colon = /^\s*(?:[-*]\s+)?([^:：|#]{1,40})[:：]\s*(.+)$/.exec(l.text);
      const values = matches.length ? matches.map(m => ({name:m[1].trim(),value:m[0],start:m.index,end:m.index+m[0].length,strong:true})) : colon?.[2].trim() ? [{name:colon[1].trim(),value:colon[2],start:l.text.length-colon[2].length,end:l.text.length,strong:false}] : [];
      for (const v of values) {
        const anchor = doc ? makeWordAnchor(doc,`anchor-${id(source.id+l.line+v.start)}`,l.section,l.path,v.start,v.end) : undefined;
        add(v.name,v.value,source,{sourceId:source.id,line:l.line,start:v.start,end:v.end,anchor},v.strong?'명시적 {{Field}}':'라벨과 값 위치 일치',v.strong);
      }
    }
    // Existing table layout is kept: label cell followed by a scalar value cell.
    if (doc) for (const sec of doc.sections) for (const p of walkParagraphs(sec.paragraphs)) for (const o of p.objects) {
      if (o.type !== 'tbl' || !('cells' in o)) continue;
      for (const cell of (o as any).cells) {
        const label = cell.subList?.paragraphs.map((x:any)=>x.logicalText).join('').trim().replace(/[:：]\s*$/,'').trim();
        if (!label || label.length > 20 || !keyOK(label)) continue;
        const right = (o as any).cells.find((c:any)=>c.row===cell.row && c.col===cell.col+cell.colSpan);
        if (right?.subList?.paragraphs.length !== 1) continue;
        const rp = right.subList.paragraphs[0];
        if (rp.fieldMarks.length || rp.objects.length || !rp.logicalText.trim()) continue;
        const l = lines.find(x=>x.section===sec.index && x.path.join('.')===rp.path.join('.'));
        if (l) add(label,rp.logicalText,source,{sourceId:source.id,line:l.line,start:0,end:rp.logicalText.length,anchor:makeWordAnchor(doc,`anchor-${id(source.id+l.line)}`,sec.index,rp.path,0,rp.logicalText.length)},'인접 표 셀의 라벨과 값');
      }
    }
  }
  for (const f of found.values()) {
    const varied = new Set(f.values.filter(Boolean)).size>1;
    if (sources.length>1 && !varied && f.confidence<1) f.kind='fixed';
    if (varied && /자격|조건|특약|조항/.test(f.name)) f.kind='block';
    const scored = Object.keys(records[0]??{}).map(column => {
      const samples=f.values.map((value,i)=>({value,row:records[i]})).filter(x=>x.value && x.row && !x.value.startsWith('{{'));
      const exact = samples.filter(x=>normalize(x.value)===normalize(x.row[column])).length;
      return {column,score:samples.length ? exact/samples.length : 0,byName:normalize(column)===normalize(f.name)};
    }).sort((a,b)=>b.score-a.score || Number(b.byName)-Number(a.byName));
    if (scored[0] && (scored[0].score===1 || scored[0].byName)) {
      if (!scored[1] || scored[0].score>scored[1].score || scored[0].byName) {
        f.column=scored[0].column;
        f.evidence+=scored[0].score===1?' · 샘플 순서별 정규화 값 일치':' · 열 이름 일치';
      }
    }
    if(varied) f.evidence+=' · 문서 간 값 변경';
  }
  return [...found.values()];
}

export function confirmFields(p: Project): Project {
  const next = structuredClone(p);
  const source = next.sources[0];
  if (!source) return next;
  const lines = sourceLines(source).map(l=>l.text);
  const edits = new Map<number, {start:number;end:number;text:string}[]>();
  for (const f of next.fields.filter(f=>f.approved && f.kind!=='fixed')) {
    for (const t of f.targets.filter(t=>t.sourceId===source.id)) {
      const text = f.kind==='block' ? `[IN_TEMPLATE:${f.name}]` : `{{${f.name}}}`;
      const group = edits.get(t.line)??[]; group.push({...t,text}); edits.set(t.line,group);
      if (f.kind==='block') {
        for (const [i,value] of f.values.entries()) {
          if (!value || next.blocks.some(b=>b.group===f.name && b.content===value)) continue;
          const other=next.sources[i]; const target=f.targets.find(t=>t.sourceId===other?.id);
          const ln=other && target ? sourceLines(other)[target.line] : undefined;
          next.blocks.push({id:`block-${id(f.id+String(i))}`,group:f.name,alias:`문서 ${i+1}`,engine_type:other?.kind==='hwpx'?'hwpx_fragment':'markdown',condition:'',priority:0,content:value,sourceId:other?.id,from:ln?.path.length===1?ln.path[0]+1:undefined,to:ln?.path.length===1?ln.path[0]+1:undefined});
        }
        if (source.kind==='hwpx') {
          const ln=sourceLines(source)[t.line];
          assert(ln?.section===0 && ln.path.length===1, 'Block 후보는 현재 첫 구역의 본문 문단에서만 확정할 수 있습니다. 표 안 값은 Field로 선택하세요.');
          if (!next.ranges.some(r=>r.group===f.name)) next.ranges.push({id:`range-${f.id}`,group:f.name,sourceId:source.id,from:ln.path[0]+1,to:ln.path[0]+1});
        }
      }
    }
  }
  for (const [line,items] of edits) {
    items.sort((a,b)=>b.start-a.start); let last=Infinity;
    for(const e of items){ assert(e.end<=last,'확정한 Field 범위가 겹칩니다. 중복 후보를 해제하세요.'); lines[line]=lines[line].slice(0,e.start)+e.text+lines[line].slice(e.end); last=e.start; }
  }
  next.markdown=lines.join('\n').replace(/\uFFFC/g,'');
  return next;
}

export function boundData(p: Project, row: Record<string, unknown>) {
  const data={...row};
  for(const f of p.fields.filter(f=>f.approved && f.kind==='field')) {
    const col=f.column || f.name;
    assert(Object.hasOwn(row,col) && row[col]!==null, `데이터 열 '${col}' 값이 없습니다. Grid의 DB Mapping을 확인하세요.`);
    data[f.name]=f.format==='money' ? `${moneyValue(row[col],col).toLocaleString('ko-KR')}원` : row[col];
  }
  return data;
}

function moneyValue(value: unknown, column: string) {
  const normalized=normalize(value);const number=Number(normalized);
  assert((typeof value==='string'||typeof value==='number') && normalized!=='' && Number.isFinite(number) && Math.abs(number)<=Number.MAX_SAFE_INTEGER, `${column}: 유효한 금액을 입력하세요.`);
  return number;
}

export function selectBlocks(p: Project, row: Record<string, unknown>, selected: Record<string,string>={}) {
  const selections: Record<string,Block>={}; const recommendations: {group:string;alias:string;reason:string}[]=[];
  const conditionData={...row};
  for(const f of p.fields.filter(f=>f.approved&&f.kind==='field'&&f.format==='money')) conditionData[f.name]=moneyValue(row[f.name],f.name);
  const groups=[...new Set(p.mode==='markdown' ? [...p.markdown.matchAll(/\[IN_TEMPLATE:([^\]]+)\]/g)].map(m=>m[1]) : p.ranges.map(r=>r.group))];
  for (const group of groups) {
    const candidates=p.blocks.filter(b=>b.group===group).sort((a,b)=>b.priority-a.priority);
    const matched=candidates.find(b=>b.condition.trim() && evaluateCondition(parseCondition(b.condition),{data:conditionData,derived:{}}));
    const fallback=candidates.find(b=>!b.condition.trim());
    const manual=selected[group] ? candidates.find(b=>b.id===selected[group]) : undefined;
    assert(!selected[group] || manual, `${group}: 선택한 Block이 없습니다.`);
    const choice=manual??matched??fallback;
    assert(choice, `${group}: 적용할 Block을 직접 선택하거나 기본 Block을 추가하세요.`);
    selections[group]=choice;
    recommendations.push({group,alias:choice.alias,reason:manual?'사용자 선택':matched?`조건 일치: ${matched.condition}`:'조건 없는 기본 Block'});
  }
  return {selections,recommendations};
}

export function renderTemplate(p: Project, row: Record<string, unknown>, selected: Record<string,string>={}) {
  const data=boundData(p,row);
  const {selections,recommendations}=selectBlocks(p,data,selected);
  const template=p.markdown.replace(/\[IN_TEMPLATE:([^\]]+)\]/g,(_,group)=>selections[group]?.content??`[IN_TEMPLATE:${group}]`);
  assert(!/\[IN_TEMPLATE:/.test(template),'Block 안의 중첩 In Template은 MVP에서 지원하지 않습니다.');
  const rendered=template.replace(/\{\{([^{}]+)\}\}/g,(_,key)=> {
    const name=key.trim(); assert(Object.hasOwn(data,name) && data[name]!==null, `필수 데이터 '${name}' 값이 없습니다.`);
    // Escape scalar Markdown syntax; values cannot inject a heading, table or image.
    return String(data[name]).replace(/([\\`*_{}\[\]<>#|!])/g,'\\$1').replace(/\r?\n/g,' ');
  });
  return {template,rendered,html:md.render(rendered),templateHtml:md.render(p.markdown),recommendations,selections,data};
}

export function schemaFrom(p: Project) {
  const fields=p.fields.filter(f=>f.approved && f.kind==='field');
  const properties=Object.fromEntries(fields.map(f=>[f.column||f.name,{type:f.format==='money'?'number':'string',title:f.name}]));
  const records=p.sources.map((s,i)=>Object.fromEntries(fields.map(f=>[f.column||f.name,f.format==='money'?moneyValue(f.values[i],f.name):f.values[i]??''])));
  assert(records.every(r=>Object.values(r).every(v=>typeof v!=='number'||Number.isFinite(v))), '샘플 금액을 숫자로 변환할 수 없습니다. Grid 형식을 확인하세요.');
  return {schema:{$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',properties,required:Object.keys(properties)},records};
}

export function parseCsv(text: string) {
  const rows:string[][]=[]; let row:string[]=[]; let value=''; let quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){ if(quoted && text[i+1]==='"'){value+='"';i++;} else quoted=!quoted; }
    else if(c===',' && !quoted){row.push(value);value='';}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(Boolean))rows.push(row);row=[];value='';}
    else value+=c;
  }
  assert(!quoted,'CSV 따옴표가 닫히지 않았습니다.');
  row.push(value);if(row.some(Boolean))rows.push(row);
  const headers=rows.shift()?.map(x=>x.trim().replace(/^\uFEFF/,''))??[];
  assert(headers.length>0 && new Set(headers).size===headers.length && headers.every(keyOK),'CSV 열 이름이 비었거나 중복되었습니다.');
  assert(rows.every(r=>r.length===headers.length),'CSV 행의 열 개수가 다릅니다.');
  const result=rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,/^(true|false)$/.test(r[i])?r[i]==='true':r[i]])));
  checkRecords(result); return result;
}

export function parseXlsx(bytes: Uint8Array) {
  const zip=readArchive(bytes);
  const read=(name:string)=>parseXmlBytes(readEntry(zip,bytes,name),name).root;
  const texts=(root:any)=>[...walkElements(root)].filter((e:any)=>e.local==='t').map((e:any)=>e.children.map((x:any)=>x.value??'').join('')).join('');
  const shared=zip.entries.some(e=>e.name==='xl/sharedStrings.xml') ? [...walkElements(read('xl/sharedStrings.xml'))].filter(e=>e.local==='si').map(texts) : [];
  const sheets=zip.entries.filter(e=>/^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
  let firstSheet=sheets[0]?.name;
  if(zip.entries.some(e=>e.name==='xl/workbook.xml')) {
    const sheet=[...walkElements(read('xl/workbook.xml'))].find(e=>e.local==='sheet');
    const relation=sheet && [...walkElements(read('xl/_rels/workbook.xml.rels'))].find(e=>e.local==='Relationship'&&attrValue(e,'Id')===attrValue(sheet,'r:id'));
    const target=relation && attrValue(relation,'Target');
    assert(relation && target && attrValue(relation,'TargetMode')!=='External','XLSX 첫 번째 시트 연결을 확인하세요.');
    firstSheet=posix.resolve('/xl',target).slice(1);
    assert(firstSheet.startsWith('xl/worksheets/') && zip.entries.some(e=>e.name===firstSheet),'XLSX 시트 경로를 확인하세요.');
  }
  assert(firstSheet,'XLSX 첫 번째 시트가 없습니다.');
  const rows=[...walkElements(read(firstSheet))].filter(e=>e.local==='row').map(r=> {
    const out:string[]=[];
    for(const c of [...walkElements(r)].filter(e=>e.local==='c')){
      const letters=attrValue(c,'r')?.match(/^[A-Z]+/)?.[0]??'';
      const col=[...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;
      assert(col>=0 && col<200, 'XLSX는 최대 200열을 지원합니다.');
      const v=[...walkElements(c)].find(e=>e.local==='v'); const raw=v?.children.map((x:any)=>x.value??'').join('')??'';
      assert(![...walkElements(c)].some(e=>e.local==='f') || v,'캐시 값이 없는 수식이 있습니다. Excel에서 계산 후 저장하세요.');
      const type=attrValue(c,'t');
      assert(type!=='e','XLSX에 오류 셀이 있습니다. Excel에서 수정 후 저장하세요.');
      assert(type!=='s' || (/^\d+$/.test(raw)&&shared[Number(raw)]!==undefined),'XLSX 공유 문자열 참조가 올바르지 않습니다.');
      out[col]=type==='s' ? shared[Number(raw)] : type==='inlineStr'?texts(c):type==='b'?(raw==='1'?'true':'false'):raw;
    } return out;
  }).filter(r=>r.some(v=>v!==''));
  const width=rows[0]?.length??0;
  assert(rows.every(r=>!r.slice(width).some(v=>v!=='')),'XLSX 헤더가 없는 열에 데이터가 있습니다. 열 이름을 추가하세요.');
  return parseCsv(rows.map(r=>Array.from({length:width},(_,i)=>`"${(r[i]??'').replaceAll('"','""')}"`).join(',')).join('\n'));
}
