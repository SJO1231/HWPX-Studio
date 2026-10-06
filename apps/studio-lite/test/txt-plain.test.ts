import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWorkbench} from '../src/workbench.ts';

test('TXT fills only scalar keys once across 50 records, preserving literal ranges and punctuation',()=>{
 const app=createWorkbench(),source='{{#참가자격}}\r\n**바탕 글** '+Array.from({length:30},(_,i)=>'{{v'+i+'}}').join(' / ')+'\r\n{{/참가자격}}';
 const opened=app.post('/api/workbench/open',{name:'plain.txt',content:Buffer.from(source).toString('base64')}) as any;
 const records=Array.from({length:50},(_,n)=>Object.fromEntries(Array.from({length:30},(_,i)=>['v'+i,('긴 값 '+n+':'+i+' ').repeat(60)+'\n\t& < > {{v0}} **문자**'])));

 const work={session:opened.session,index:0,edits:[{id:opened.paragraphs[1].id,text:opened.paragraphs[1].text+' **끝'}],headings:[],blocks:[]};
 for(let index=0;index<50;index++){
   app.post('/api/workbench/data',{session:opened.session,name:'data.json',content:JSON.stringify(records[index])});
   const result=app.post('/api/workbench/generate',work) as any;
   const expected='{{#참가자격}}\r\n**바탕 글** '+Object.values(records[index]!).join(' / ')+' **끝\r\n{{/참가자격}}';
   assert.match(result.notes.join(),/구간 표기 2곳/);assert.equal(result.text,expected);assert.equal(result.filled,30);
   assert.equal((app.post('/api/workbench/generate',work) as any).text,expected);
   assert.equal(Buffer.from(app.get('/api/workbench/result',new URLSearchParams({session:opened.session}))!.body).toString(),expected);
 }
 assert.equal(Buffer.from(app.get('/api/workbench/source',new URLSearchParams({session:opened.session}))!.body).toString(),source);
});

test('TXT defaults to blocking every unresolved scalar; keeping is explicit and persisted',()=>{
 const app=createWorkbench();const opened=app.post('/api/workbench/open',{name:'x.txt',content:Buffer.from('{{ok}} {{missing}} {{invalid name}} {{#x}}{{/x}}').toString('base64')}) as any;
 const work={session:opened.session,index:0,edits:[],headings:[],blocks:[]};
 app.post('/api/workbench/data',{session:opened.session,name:'data.json',content:'{"ok":"{{literal}}"}'});
 assert.throws(()=>app.post('/api/workbench/generate',work),/2곳/);
 const kept=app.post('/api/workbench/generate',{...work,missing:'keep'}) as any;
 assert.equal(kept.unresolved,2);assert.equal(kept.filled,1);assert.match(kept.notes.join(),/구간 표기 2곳/);
 const saved=app.post('/api/workbench/save',{...work,missing:'keep'}) as any;
 const restored=app.post('/api/workbench/restore',{workspace:saved.workspace}) as any;assert.equal(restored.missing,'keep');
 assert.throws(()=>app.post('/api/workbench/generate',work),/2곳/);
 assert.throws(()=>app.get('/api/workbench/result',new URLSearchParams({session:opened.session})),(e:any)=>e.code==='WORKBENCH_RESULT');
});
