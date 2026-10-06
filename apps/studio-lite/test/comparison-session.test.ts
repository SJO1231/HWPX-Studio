import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWorkbench} from '../src/workbench.ts';

test('twenty comparison reads preserve edited source/data, save/restore, output invalidation and normal eight-session bound',()=>{
  const app=createWorkbench(),file={name:'sample.txt',content:Buffer.from('base {{value}}').toString('base64')};
  const opened=app.post('/api/workbench/open',file) as any;
  app.post('/api/workbench/data',{session:opened.session,name:'data.json',content:'{"value":"kept"}'});
  const work={session:opened.session,index:0,edits:[{id:opened.paragraphs[0].id,text:'edited {{value}}'}],headings:[],blocks:[]};
  for(let i=0;i<20;i++){const comparison=app.post('/api/workbench/compare',{...file,content:Buffer.from('comparison '+i).toString('base64')}) as any;assert.equal(comparison.paragraphs[0].text,'comparison '+i);assert.equal(comparison.session,undefined);}
  assert.throws(()=>app.post('/api/workbench/compare',{...file,content:'!'}));
  assert.equal((app.post('/api/workbench/generate',work) as any).text,'edited kept');
  const saved=app.post('/api/workbench/save',work) as any,restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as any;
  assert.equal(restored.dataInfo.records,1);assert.equal((app.post('/api/workbench/generate',{...work,session:restored.session,edits:restored.edits}) as any).text,'edited kept');
  assert.throws(()=>app.post('/api/workbench/generate',{...work,index:9}));
  assert.throws(()=>app.get('/api/workbench/result',new URLSearchParams({session:opened.session})),(e:any)=>e.code==='WORKBENCH_RESULT');
  for(let i=0;i<8;i++)app.post('/api/workbench/open',file);
  assert.throws(()=>app.post('/api/workbench/save',work),(e:any)=>e.code==='WORKBENCH_SESSION');
});
