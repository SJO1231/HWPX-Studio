import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {detectHeadings,headingRangeOf,openPackage,parseDocument} from '@hwpx-studio/engine';
import {buildHwpx} from '../../../packages/hwpx-engine/test/helpers.ts';
import {textPara,gridTable,tableParagraph} from '../../../packages/hwpx-engine/test/table-helpers.ts';
import {createWorkbench} from '../src/workbench.ts';
import {createBlockLibrary} from '../src/block-library.ts';

test('heading block candidates use engine ranges including tables and never create blocks before approval',()=>{
  const bytes=buildHwpx([textPara('document')+textPara('1. First')+textPara('body')+tableParagraph(gridTable([9000],2,[['가. Cell heading'],['cell body']],{id:'78'}))+textPara('2. Second')+textPara('tail')]);
  const before=Buffer.from(bytes),doc=parseDocument(openPackage(bytes)),db=new DatabaseSync(':memory:');
  try{const library=createBlockLibrary(db),app=createWorkbench(library),opened=app.post('/api/workbench/open',{name:'synthetic.hwpx',content:Buffer.from(bytes).toString('base64')}) as any;
    const heads=detectHeadings(doc);assert(heads.length>=3);assert.equal(opened.blockCandidates.length,heads.length);
    for(const [i,h] of heads.entries()){const range=headingRangeOf(doc,h.at,h.index)!;const id=(n:number)=>`p:${h.at.sectionIndex}:${[...h.at.parentPath,n].join('.')}`;const c=opened.blockCandidates[i];assert.deepEqual(c,{from:id(range.from),to:id(range.to),name:h.text,paragraphCount:range.to-range.from+1});
      const preview=app.post('/api/workbench/block-preview',{session:opened.session,from:c.from,to:c.to}) as any;assert.equal(preview.paragraphCount,c.paragraphCount);}
    assert.deepEqual(library.list(),[]);assert.deepEqual(Buffer.from(bytes),before);
    const txt=app.post('/api/workbench/open',{name:'test.txt',content:Buffer.from('1. text').toString('base64')}) as any;assert.deepEqual(txt.blockCandidates,[]);
  }finally{db.close();}
});
