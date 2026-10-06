import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { cleanPath, resolveShared, HostError, previewBlock } from '../../../packages/viewer/src/host/index.ts';
import { createQuick } from './quick-api.ts';
import { createWorkbench } from './workbench.ts';
import { createBlockLibrary } from './block-library.ts';
import { plainOf } from './quick-messages.ts';
import { plainOf as blockMessage } from '../../studio/src/messages.ts';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { analyze, assert, checkProject, checkRecords, confirmFields, md, parseCsv, parseXlsx, schemaFrom, sourceLines } from './core.ts';
import { applyProject, markdownHwpx } from './hwpx.ts';
import { demo, demoSources } from './demo.ts';
import { createG2B, G2BRequestError } from './g2b.ts';
import { parseDocument, openPackage } from '@hwpx-studio/engine';

const pathCode=(e:unknown)=>e instanceof Error && 'code' in e && typeof e.code==='string'?{code:e.code,plain:plainOf(e.code)}:{};
const ROOT=fileURLToPath(new URL('../',import.meta.url));
export function createApp(database=':memory:') {
  const db=new DatabaseSync(database);
  db.exec('CREATE TABLE IF NOT EXISTS project_revision (id INTEGER PRIMARY KEY, name TEXT NOT NULL, document TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const g2b=createG2B(db);
  const quick=createQuick();
  const blockLibrary=createBlockLibrary(db);
  const workbench=createWorkbench(blockLibrary);
  const server=createServer(async(req,res)=>{
    const send=(status:number,body:unknown,type='application/json; charset=utf-8',headers:Record<string,string>={})=>{
      const data=body instanceof Uint8Array ? body : type.startsWith('application/json') ? JSON.stringify(body) : String(body);
      res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'",...headers}); res.end(data);
    };
    try {
      const port=(server.address() as any)?.port;
      const origins=[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
      if(!origins.some(o=>o===`http://${req.headers.host}`) || (req.headers.origin && !origins.includes(req.headers.origin))) return send(403,{error:'허용되지 않은 출처입니다.'});
      const url=new URL(req.url??'/',origins[0]);
      const path=url.pathname;
      if(req.method==='GET') {
        const result=workbench.get(path,url.searchParams)??quick.get(path,url.searchParams);
        if(result)return send(200,result.body,'type' in result && typeof result.type==='string'?result.type:'application/vnd.hancom.hwpx',result.name?{'Content-Disposition':`attachment; filename="document.hwpx"; filename*=UTF-8''${encodeURIComponent(result.name)}`}:{});
        if(path==='/api/block/preview') {
          const item=blockLibrary.get(url.searchParams.get('id'));
          const preview=previewBlock({block:item.id},id=>blockLibrary.material(id,item.version));
          return send(200,{...preview,warnings:preview.warnings.map(w=>({...w,message:blockMessage(w.code)}))});
        }
        if(path==='/api/blocks')return send(200,{blocks:blockLibrary.list(url.searchParams.get('q')??'')});
        if(path==='/api/block/usage')return send(200,blockLibrary.usage(url.searchParams.get('id')));
        if(path==='/api/block')return send(200,blockLibrary.get(url.searchParams.get('id')));
        if(path==='/api/health')return send(200,{ok:true});
        if(path==='/api/g2b/profiles')return send(200,{profiles:g2b.profiles()});
        if(path==='/api/projects')return send(200,db.prepare('SELECT name, MAX(id) AS id, MAX(saved_at) AS saved_at FROM project_revision GROUP BY name ORDER BY id DESC').all());
        if(path==='/api/project') {
          const row=db.prepare('SELECT document FROM project_revision WHERE id=?').get(Number(url.searchParams.get('id'))) as any;
          return row?send(200,JSON.parse(row.document)):send(404,{error:'저장된 프로젝트가 없습니다.'});
        }
        if(path==='/api/demo')return send(200,demo());
        if(path==='/api/demo-sources')return send(200,demoSources);
        const files:Record<string,string>={'/':'web/workbench.html','/workbench':'web/workbench.html','/block-library.js':'web/block-library.js','/workbench.js':'web/workbench.js','/workbench.css':'web/workbench.css','/editor-model.js':'src/editor-model.ts','/viewer-lines.js':'src/viewer-lines.ts','/quick':'web/quick.html','/template':'web/index.html','/quick.js':'web/quick.js','/quick.css':'web/quick.css','/app.js':'web/app.js','/style.css':'web/style.css','/rhwp.js':'vendor/rhwp/rhwp.js','/rhwp_bg.wasm':'vendor/rhwp/rhwp_bg.wasm'};
        const shared=cleanPath(path);
        const sharedFile=shared===undefined?undefined:resolveShared(shared);
        if(sharedFile){
          const bytes=readFileSync(sharedFile.file);
          const body=sharedFile.strip?stripTypeScriptTypes(bytes.toString('utf8'),{mode:'strip'}).replace(/(from\s*)"@rhwp\/core"/g,'$1"/vendor/rhwp/rhwp.js"'):bytes;
          return send(200,body,sharedFile.type);
        }
        if(files[path]) {
          const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm'};
          const file=files[path];
          return send(200,file.endsWith('.ts')?stripTypeScriptTypes(readFileSync(resolve(ROOT,file),'utf8'),{mode:'strip'}):readFileSync(resolve(ROOT,file)),file.endsWith('.ts')?types['.js']:types[extname(file)]);
        }
        return send(404,{error:'없는 경로입니다.'});
      }
      if(req.method!=='POST' || !path.startsWith('/api/')) return send(405,{error:'지원하지 않는 요청입니다.'});
      if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'JSON 요청만 받습니다.'});
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>32*1024*1024)return send(413,{error:'요청은 32MB 이내여야 합니다.'});chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(path==='/api/block/rename')return send(200,blockLibrary.rename(input?.id,input?.name));
      if(path==='/api/block/delete')return send(200,blockLibrary.remove(input?.id,input?.confirmed));
      if(path.startsWith('/api/quick/'))return send(200,quick.post(path,input));
      if(path.startsWith('/api/workbench/'))return send(200,workbench.post(path,input));
      if(path==='/api/g2b/profiles') {
        if(!req.headers.origin)return send(403,{error:'생성 프로필은 Studio의 Helper 연결 화면에서 설정하세요.'});
        return send(200,{profile:g2b.saveProfile(input)});
      }
      if(path==='/api/g2b/generate')return send(200,await g2b.generate(input));
      if(path==='/api/import-data') {
        assert(typeof input.content==='string' && typeof input.name==='string','파일 형식을 확인하세요.');
        const records=/\.xlsx$/i.test(input.name)?parseXlsx(Buffer.from(input.content,'base64')):/\.csv$/i.test(input.name)?parseCsv(input.content):JSON.parse(input.content);
        checkRecords(records);return send(200,{records});
      }
      if(path==='/api/demo-native') {
        const sources=[];
        for(const s of demoSources){const b=await markdownHwpx(s.content);sources.push({...s,name:s.name.replace('.md','.hwpx'),kind:'hwpx',content:Buffer.from(b).toString('base64')});}
        return send(200,sources);
      }
      checkProject(input.project);
      const p=input.project;
      if(path==='/api/analyze')return send(200,{fields:analyze(p.sources,p.records),documents:p.sources.map((s:any)=>({id:s.id,name:s.name,lines:sourceLines(s),paragraphs:s.kind==='hwpx'?parseDocument(openPackage(Buffer.from(s.content,'base64'))).sections[0].paragraphs.map((p:any,i:number)=>({number:i+1,text:p.logicalText.replace(/\uFFFC/g,'[표/객체]')})):[]}))});
      if(path==='/api/confirm')return send(200,confirmFields(p));
      if(path==='/api/schema')return send(200,schemaFrom(p));
      if(path==='/api/markdown')return send(200,{html:md.render(p.markdown)});
      if(path==='/api/apply') {
        assert(input.selected===undefined || (input.selected && typeof input.selected==='object' && !Array.isArray(input.selected) && Object.values(input.selected).every(v=>typeof v==='string')),'Block 선택을 확인하세요.');
        return send(200,await applyProject(p,input.index,input.selected??{}));
      }
      if(path==='/api/save') {
        const result=db.prepare('INSERT INTO project_revision (name,document) VALUES (?,?)').run(p.name,JSON.stringify(p));
        return send(200,{id:Number(result.lastInsertRowid),saved:true});
      }
      send(404,{error:'없는 API입니다.'});
    } catch(e) {send(e instanceof G2BRequestError || e instanceof HostError?e.status:400,{error:e instanceof Error?e.message:'요청 처리에 실패했습니다.',...(e instanceof G2BRequestError?{status:'error',code:e.code}:pathCode(e))});}
  });
  server.on('close',()=>db.close());
  return server;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  mkdirSync(resolve(ROOT,'data'),{recursive:true});
  const port=Number(process.env.PORT??4318);
  const server=createApp(resolve(ROOT,'data/studio.sqlite'));
  server.listen(port,'127.0.0.1',()=>console.log(`HWPX Studio lite: http://127.0.0.1:${port}`));
  server.on('error',e=>{console.error(e.message);process.exitCode=1;});
}
