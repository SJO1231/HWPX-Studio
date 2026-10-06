import assert from 'node:assert/strict';
import {test} from 'node:test';
import {viewerLines,lineAt} from '../src/viewer-lines.ts';

test('hover spans whole rendered lines, wraps, blank lines, cells, nested cells and subsequent pages',()=>{
  const box=(type:string,x:number,y:number,w:number,h:number,children:any[]=[])=>({type,bbox:{x,y,w,h},children});
  const line=(y:number)=>box('TextLine',45,y,15,10); // glyph width is deliberately tiny
  const tree=box('Page',0,0,200,200,[box('Column',20,10,160,180,[
    line(10),line(20),box('TextLine',45,30,100,10),
    box('Cell',20,50,70,40,[line(50),line(60),box('Cell',30,75,30,10,[line(75)])]),
    box('Cell',90,50,90,40,[line(50),line(60)]),
    box('TextLine',0,100,NaN,10),box('TextLine',0,110,10,0),
  ])]);
  const lines=viewerLines(tree);
  assert.equal(lines.length,8);
  for(const [y,n] of [[15,1],[25,2],[35,3]])for(const x of [20,80,179.9])assert.equal(lineAt(lines,x!,y!)?.number,n);
  for(const x of [20,50,89.9])assert.equal(lineAt(lines,x,55)?.number,4);
  for(const x of [90,130,179.9])assert.equal(lineAt(lines,x,55)?.number,7);
  assert.equal(lineAt(lines,50,65)?.number,5);
  assert.equal(lineAt(lines,50,80)?.number,6);
  for(const [x,y] of [[19,15],[180,15],[50,45],[100,95]])assert.equal(lineAt(lines,x!,y!),undefined);
  const overlapping=viewerLines(box('Page',0,0,200,200,[line(10),line(14)]));
  assert.equal(lineAt(overlapping,80,15)?.number,1);
  assert.equal(lineAt(overlapping,80,19)?.number,2);
  const next=viewerLines(tree,lines.length);
  assert.equal(lineAt(next,179,15)?.number,9);
  assert.deepEqual(viewerLines(tree),lines); // zoom/re-render must not change numbering
});
