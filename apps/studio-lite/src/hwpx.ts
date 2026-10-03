import { markdownToHwpx } from 'kordoc';
import {
  openPackage, parseDocument, walkParagraphs, generate, emptyTemplate, readTemplate, extractFragment,
  makeLineAnchor, makeWordAnchor, collectFields, applyPlan, subElements, validateDocument, compareToBaseline,
  readArchive, readEntry, rewriteArchive, walkElements,
} from '@hwpx-studio/engine';
import { assert, boundData, selectBlocks, renderTemplate, sourceLines, id, checkProject } from './core.ts';
import type { Project, Block } from './model.ts';

const docOf = (bytes: Uint8Array) => parseDocument(openPackage(bytes));
const textOf = (bytes: Uint8Array) => docOf(bytes).sections.flatMap(s=>[...walkParagraphs(s.paragraphs)].map(p=>p.logicalText.replace(/\uFFFC/g,'')));

function checked(result: ReturnType<typeof generate>) {
  if (!result.ok || result.dryRun) throw new Error(result.report.issues.filter(i=>i.severity==='error').map(i=>`${i.code}: ${i.message}`).join('\n') || 'HWPX 생성이 중단되었습니다.');
  assert(result.report.plan.skipped.length===0, '일부 Field가 서식 경계를 가로질러 채워지지 않았습니다. 범위를 나누어 다시 확정하세요.');
  return result;
}

export async function markdownHwpx(text: string) {
  assert(text.length<200000,'Markdown은 200,000자 이내로 입력하세요.');
  assert(!/!\[[^\]]*\]\s*[([]/.test(text) && !/<(?:img|iframe|script|object)\b/i.test(text), '최소 서식형은 이미지/외부 리소스를 지원하지 않습니다. 원본 서식형을 사용하세요.');
  let bytes=new Uint8Array(await markdownToHwpx(text));
  // Kordoc emits tabPrIDRef=0 with an empty tabProperties list. Once another
  // document imports a tab resource this implicit default becomes dangling.
  // Materialize the empty tab prototype observed in samples/tables-merged.hwpx.
  const doc=docOf(bytes);
  const tabs=[...walkElements(doc.header.root)].find(e=>e.local==='tabProperties');
  if(tabs && !(doc.header.resources.tabPr?.length)) {
    const q=tabs.prefix?`${tabs.prefix}:`:'';
    const replacement=`<${q}tabProperties itemCnt="1"><${q}tabPr id="0" autoTabLeft="0" autoTabRight="0"/></${q}tabProperties>`;
    bytes=new Uint8Array(applyPlan(doc.pkg,{edits:[{entry:doc.pkg.headerEntry,start:tabs.start,end:tabs.end,expected:doc.header.text.slice(tabs.start,tabs.end),replacement,reason:'explicit-default-tab'}],additions:[],summary:{},issues:[]}));
  }
  const report=validateDocument(bytes);
  assert(report.errors.length===0, `생성 문서 검증 실패: ${report.errors.map(i=>i.code).join(', ')}`);
  return bytes;
}

async function fragmentOf(p: Project, block: Block) {
  if(block.engine_type==='markdown') {
    const bytes=await markdownHwpx(`STUDIO_FRAGMENT_BOUNDARY\n\n${block.content}`);
    const doc=docOf(bytes);
    return extractFragment(doc,{sectionIndex:0,parentPath:[],from:1,to:doc.sections[0].paragraphs.length-1});
  }
  const source=p.sources.find(s=>s.id===block.sourceId && s.kind==='hwpx');
  assert(source,'Fragment 원본 HWPX를 불러오세요.');
  const doc=docOf(Buffer.from(source.content,'base64'));
  assert(Number.isInteger(block.from) && Number.isInteger(block.to) && block.from!>=1 && block.to!>=block.from! && block.to!<=doc.sections[0].paragraphs.length, 'Fragment의 시작·끝 문단 번호를 확인하세요(첫 구역, 1부터).');
  return extractFragment(doc,{sectionIndex:0,parentPath:[],from:block.from!-1,to:block.to!-1});
}

export function unwrapFields(bytes: Uint8Array, names: Set<string>) {
  const doc=docOf(bytes); const edits:any[]=[];
  for(const f of collectFields(doc).filter(f=>names.has(f.info.name))) {
    assert(f.end && ['simple','empty'].includes(f.info.shape),'복잡한 누름틀은 Unwrap할 수 없습니다.');
    for(const mark of [f.begin,f.end]) {
      const el=mark!.element; const parent=el.parent;
      const range=parent?.local==='ctrl' && subElements(parent).length===1 ? parent : el;
      if(edits.some(e=>e.entry===f.section.entryName && e.start===range.start)) continue;
      edits.push({entry:f.section.entryName,start:range.start,end:range.end,expected:f.section.text.slice(range.start,range.end),replacement:'',reason:'filled-field-unwrap'});
    }
  }
  const out=applyPlan(doc.pkg,{edits,additions:[],summary:{},issues:[]});
  assert(JSON.stringify(textOf(out))===JSON.stringify(textOf(bytes)),'Unwrap 후 문서 텍스트가 변경되었습니다.');
  assert(compareToBaseline(validateDocument(bytes),validateDocument(out)).newErrors.length===0,'Unwrap 검증에 실패했습니다.');
  assert(!collectFields(docOf(out)).some(f=>names.has(f.info.name)),'Unwrap 후 누름틀이 남았습니다.');
  return out;
}

export async function nativeHwpx(p: Project, row: Record<string,unknown>, selected: Record<string,string>) {
  checkProject(p);
  const master=p.sources[0]; assert(master?.kind==='hwpx','첫 번째 문서를 원본 HWPX로 불러오세요.');
  const original=Buffer.from(master.content,'base64'); let bytes:Uint8Array=original;
  const data=boundData(p,row); const {selections,recommendations}=selectBlocks(p,data,selected);
  const doc=docOf(bytes); const structural=emptyTemplate();
  const occupied=new Set<number>();
  const authored=new Set<number>();let shift=0;
  for(const range of [...p.ranges].sort((a,b)=>a.from-b.from)) {
    assert(range.sourceId===master.id,'Anchor+는 현재 Master에 정의해야 합니다.');
    assert(Number.isInteger(range.from) && Number.isInteger(range.to) && range.from>=1 && range.to>=range.from && range.to<=doc.sections[0].paragraphs.length,'Anchor+ 시작·끝 문단 번호를 확인하세요.');
    for(let i=range.from-1;i<range.to;i++){
      assert(!occupied.has(i),'Anchor+ 범위가 겹칩니다.'); occupied.add(i);
      const anchor=makeLineAnchor(doc,`range-${id(range.id+String(i))}`,0,[i])!;
      structural.anchors.push(anchor);
      if(i===range.from-1) {
        const block=selections[range.group];
        const fragment=await fragmentOf(p,block);
        const count=fragment.source.selection.to-fragment.source.selection.from+1;
        if(block.engine_type==='markdown')for(let n=0;n<count;n++)authored.add(range.from-1+shift+n);
        shift+=count-(range.to-range.from+1);
        structural.rules.push({id:anchor.id,do:{type:'inject',anchor:anchor.id,position:'replace',fragment:fragment as any}});
      } else structural.rules.push({id:anchor.id,do:{type:'delete',anchor:anchor.id}});
    }
  }
  const reports:any[]=[];
  if(structural.rules.length){ const r=checked(generate(bytes,structural,{data:{},derived:{}},{mode:'baseline',missing:'keep',allowNothingApplied:true})); bytes=r.output; reports.push(r.report); }
  const fill=emptyTemplate(); const filledNames=new Set<string>(); const current=docOf(bytes);
  const placeholderValues=new Map<string,unknown>();
  for(const f of p.fields.filter(f=>f.approved&&f.kind==='field')) {
    placeholderValues.set(f.name,data[f.name]);
    for(const t of f.targets) {
      const token=t.anchor?.kind==='word' && /^\{\{([^{}]+)\}\}$/.exec(t.anchor.print.text);
      if(token)placeholderValues.set(token[1].trim(),data[f.name]);
    }
  }
  const originalLines=sourceLines(master);
  for(const f of p.fields.filter(f=>f.approved && f.kind==='field')) {
    for(const target of f.targets.filter(t=>t.sourceId===master.id)) {
      const originalLine=originalLines[target.line];
      if(originalLine?.section===0 && occupied.has(originalLine.path[0])) continue;
      assert(target.anchor,'HWPX Field의 원본 Anchor가 없습니다. 문서를 다시 분석하세요.');
      if(target.anchor.kind==='field')continue; // Resolve occurrence after structural changes below.
      const placeholder=target.anchor.kind==='word' && /^\{\{([^{}]+)\}\}$/.exec(target.anchor.print.text);
      if(placeholder)continue;
      const anchor={...target.anchor,id:`fill-${id(f.id+JSON.stringify(target.anchor))}`};
      fill.anchors.push(anchor); fill.rules.push({id:anchor.id,do:{type:'fill',anchor:anchor.id,value:{text:String(data[f.name])}}});
    }
  }
  // Assemble first, then plan every scalar replacement on the unfilled document.
  // Only authored Markdown ranges may read arbitrary DB columns; raw imports require approval.
  for(const section of current.sections)for(const paragraph of walkParagraphs(section.paragraphs)) {
    for(const match of paragraph.logicalText.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const name=match[1].trim();
      const direct=section.index===0 && authored.has(paragraph.path[0]);
      assert(placeholderValues.has(name)||(direct&&Object.hasOwn(data,name)&&data[name]!=null),'DATA_MISSING: 확정된 Field 값이 없습니다: '+name);
      const value=placeholderValues.has(name)?placeholderValues.get(name):data[name];
      const aid=`placeholder-${id(section.index+':'+paragraph.path+':'+match.index)}`;
      const anchor=makeWordAnchor(current,aid,section.index,paragraph.path,match.index,match.index+match[0].length);
      assert(anchor,'Field 위치를 찾을 수 없습니다.');
      fill.anchors.push(anchor);fill.rules.push({id:aid,do:{type:'fill',anchor:aid,value:{text:String(value)}}});
    }
  }
  // Re-enumerate both Master and imported fields: inserting/deleting a Fragment changes occurrences.
  const mapped=new Map<string,string>();
  for(const f of p.fields.filter(f=>f.approved&&f.kind==='field')) {
    mapped.set(f.name,f.name);
    for(const t of f.targets) if(t.anchor?.kind==='field') mapped.set(t.anchor.name,f.name);
  }
  for(const f of collectFields(current)) {
    if(!mapped.has(f.info.name)) continue;
    const aid=`imported-${id(f.info.name+f.info.occurrence)}`;
    fill.anchors.push({id:aid,kind:'field',name:f.info.name,occurrence:f.info.occurrence});
    fill.rules.push({id:aid,do:{type:'fill',anchor:aid,value:{text:String(data[mapped.get(f.info.name)!])}}});
    filledNames.add(f.info.name);
  }
  // No data reaches the implicit scanner: injected scalar text is never interpreted again.
  const result=checked(generate(bytes,readTemplate(fill),{data:{},derived:{}},{mode:'baseline',missing:'keep',allowNothingApplied:true}));
  bytes=unwrapFields(result.output,filledNames); reports.push(result.report);
  const before=validateDocument(original), after=validateDocument(bytes);
  const regression=compareToBaseline(before,after).newErrors;
  assert(regression.length===0,`원본 대비 새로운 HWPX 오류가 있습니다: ${regression.map(i=>`${i.code}: ${i.message}`).join('; ')}`);
  return {bytes,reports,recommendations,rendered:textOf(bytes).join('\n\n'),validation:{errors:after.errors.length,warnings:after.warnings.length,newErrors:0}};
}

export async function applyProject(p: Project, index: number, selected: Record<string,string>={}) {
  checkProject(p);
  assert(Number.isInteger(index) && index>=0 && index<p.records.length,'적용할 데이터 행을 선택하세요.');
  const row=p.records[index];
  let bytes:Uint8Array; let preview:any;
  if(p.mode==='markdown') {
    preview=renderTemplate(p,row,selected); bytes=await markdownHwpx(preview.rendered);
    preview.validation={errors:0,warnings:validateDocument(bytes).warnings.length,newErrors:0};
  } else { const result=await nativeHwpx(p,row,selected); bytes=result.bytes; preview={...result}; delete preview.bytes; }
  // Refresh text preview, preserve all other untouched package entries.
  const zip=readArchive(bytes);
  if(zip.entries.some(e=>e.name==='Preview/PrvText.txt')) bytes=rewriteArchive(bytes,zip,{replace:new Map([['Preview/PrvText.txt',new TextEncoder().encode(textOf(bytes).join('\n'))]])});
  const final=validateDocument(bytes);
  assert(final.errors.length===preview.validation.errors,'저장 직전 검증 결과가 변경되었습니다.');
  return {...preview,output:Buffer.from(bytes).toString('base64'),filename:'document.hwpx',paragraphs:textOf(bytes).length};
}
