type Rect = {x:number;y:number;w:number;h:number};
export type ViewerLine = Rect & {number:number};
type Node = {type?:string;bbox?:Rect;children?:Node[]};
const valid=(r:Rect|undefined):r is Rect=>!!r&&[r.x,r.y,r.w,r.h].every(Number.isFinite)&&r.w>0&&r.h>0;

/** Render-tree TextLine boxes include wrapping and empty lines; paragraph/run IDs are not line numbers. */
export function viewerLines(tree:Node,offset=0):ViewerLine[]{
  const lines:ViewerLine[]=[];
  const walk=(node:Node,scope:Rect|undefined,depth:number):void=>{
    if(!node||depth>64)return;
    const r=node.bbox;
    if(valid(r)&&['Page','Body','Column','Cell','TextBox','Header','Footer','FootnoteArea'].includes(node.type??''))scope=r;
    if(node.type==='TextLine'&&valid(r)&&scope){
      const y=Math.max(scope.y,r.y),bottom=Math.min(scope.y+scope.h,r.y+r.h);
      if(bottom>y)lines.push({x:scope.x,y,w:scope.w,h:bottom-y,number:offset+lines.length+1});
    }
    if(Array.isArray(node.children))for(const child of node.children)walk(child,scope,depth+1);
  };
  walk(tree,undefined,0);
  return lines;
}

/** A cell/text box wins over a surrounding body line at the same height. */
export function lineAt(lines:ViewerLine[],x:number,y:number):ViewerLine|undefined{
  let hit:ViewerLine|undefined;
  for(const line of lines)if(x>=line.x&&x<line.x+line.w&&y>=line.y&&y<line.y+line.h&&(!hit||line.w<hit.w||(line.w===hit.w&&Math.abs(y-line.y-line.h/2)<Math.abs(y-hit.y-hit.h/2))))hit=line;
  return hit;
}
