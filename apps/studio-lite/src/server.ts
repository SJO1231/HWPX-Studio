import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { cleanPath, resolveShared, HostError, previewBlock } from '../../../packages/viewer/src/host/index.ts';
import { createQuick } from './quick-api.ts';
import { createWorkbench } from './workbench.ts';
import { createBlockLibrary } from './block-library.ts';
import { plainOf } from './quick-messages.ts';
import { plainOf as blockMessage, KNOWN_CODES } from '../../studio/src/messages.ts';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { analyze, assert, checkProject, checkRecords, confirmFields, md, parseCsv, parseXlsx, schemaFrom, sourceLines } from './core.ts';
import { applyProject, markdownHwpx } from './hwpx.ts';
import { demo, demoSources } from './demo.ts';
import { createG2B, G2BRequestError } from './g2b.ts';
import { createG2B2, G2B2Error, g2b2Body, STUDIO_GENERATE } from './g2b-v2.ts';
import { parseDocument, openPackage } from '@hwpx-studio/engine';

// Preview rejections: engine codes use the shared plain table; app/host codes already carry a plain sentence.
const previewPlain=(e:unknown)=>{const code=(e as {code?:unknown}|null)?.code;return typeof code==='string'&&KNOWN_CODES.includes(code)?blockMessage(code):e instanceof HostError?e.message:'블록 미리보기를 만들지 못했습니다.';};
// 오류가 제 쉬운 말(`plain`)을 가지면 코드 표의 문장보다 그것을 쓴다(같은 코드의 더 좁은 경우, 예: /quick의 Helper 판 불일치)
const pathCode=(e:unknown)=>e instanceof Error && 'code' in e && typeof e.code==='string'?{code:e.code,plain:'plain' in e&&typeof e.plain==='string'?e.plain:plainOf(e.code)}:{};
const ROOT=fileURLToPath(new URL('../',import.meta.url));
export function createApp(database=':memory:') {
  const db=new DatabaseSync(database);
  db.exec('CREATE TABLE IF NOT EXISTS project_revision (id INTEGER PRIMARY KEY, name TEXT NOT NULL, document TEXT NOT NULL, saved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const g2b=createG2B(db);
  const g2b2=createG2B2(db);
  const quick=createQuick();
  const blockLibrary=createBlockLibrary(db);
  const workbench=createWorkbench(blockLibrary);
  const server=createServer(async(req,res)=>{
    const send=(status:number,body:unknown,type='application/json; charset=utf-8',headers:Record<string,string>={})=>{
      const data=body instanceof Uint8Array ? body : type.startsWith('application/json') ? JSON.stringify(body) : String(body);
      res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self'",...headers}); res.end(data);
    };
    let generating=false;
    try {
      const port=(server.address() as any)?.port;
      const origins=[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
      const url=new URL(req.url??'/',origins[0]);
      const path=url.pathname;
      // 생성 창구(2판 계약 8.8.14)는 본문을 읽기 전의 거절(403·405·415·413·JSON 아님)과 내부 예외(500)도 { code, message } 꼴이다(1판·2판을 본문 전에는 가릴 수 없다)
      generating=path==='/api/g2b/generate';
      const refuse=(status:number,message:string)=>send(status,generating?g2b2Body(new G2B2Error(status,'INVALID_REQUEST',message)):{error:message});
      if(!origins.some(o=>o===`http://${req.headers.host}`) || (req.headers.origin && !origins.includes(req.headers.origin))) return refuse(403,'허용되지 않은 출처입니다.');
      if(generating&&req.method!=='POST')return refuse(405,'생성 창구는 POST 요청만 받습니다.');
      if(req.method==='GET') {
        const result=workbench.get(path,url.searchParams)??quick.get(path,url.searchParams);
        if(result)return send(200,result.body,'type' in result && typeof result.type==='string'?result.type:'application/vnd.hancom.hwpx',result.name?{'Content-Disposition':`attachment; filename="document.hwpx"; filename*=UTF-8''${encodeURIComponent(result.name)}`}:{});
        if(path==='/api/block/preview') {
          // version이 있으면 그 판(분기점 후보는 핀한 판을 본다, #7)
          const item=blockLibrary.get(url.searchParams.get('id')),version=url.searchParams.has('version')?Number(url.searchParams.get('version')):item.version;
          const preview=previewBlock({block:item.id},id=>blockLibrary.material(id,version));
          return send(200,{...preview,warnings:preview.warnings.map(w=>({...w,message:blockMessage(w.code)}))});
        }
        if(path==='/api/blocks')return send(200,{blocks:blockLibrary.list(url.searchParams.get('q')??'')});
        if(path==='/api/block/usage'){const use=blockLibrary.usage(url.searchParams.get('id'));return send(200,{...use,openPlacement:workbench.inUse(use.proto)});}
        if(path==='/api/block')return send(200,blockLibrary.get(url.searchParams.get('id')));
        if(path==='/api/health')return send(200,{ok:true});
        if(path==='/api/g2b/profiles')return send(200,{profiles:g2b2.profiles()});
        if(path==='/api/projects')return send(200,db.prepare('SELECT name, MAX(id) AS id, MAX(saved_at) AS saved_at FROM project_revision GROUP BY name ORDER BY id DESC').all());
        if(path==='/api/project') {
          const row=db.prepare('SELECT document FROM project_revision WHERE id=?').get(Number(url.searchParams.get('id'))) as any;
          return row?send(200,JSON.parse(row.document)):send(404,{error:'저장된 프로젝트가 없습니다.'});
        }
        if(path==='/api/demo')return send(200,demo());
        if(path==='/api/demo-sources')return send(200,demoSources);
        const files:Record<string,string>={'/':'web/workbench.html','/workbench':'web/workbench.html','/block-library.js':'web/block-library.js','/workbench.js':'web/workbench.js','/workbench.css':'web/workbench.css','/editor-model.js':'src/editor-model.ts','/input-table.js':'src/input-table.ts','/value-type.js':'src/value-type.ts','/viewer-lines.js':'src/viewer-lines.ts','/range-flag.js':'src/range-flag.ts','/branch-flow.js':'src/branch-flow.ts','/quick':'web/quick.html','/template':'web/index.html','/quick.js':'web/quick.js','/quick.css':'web/quick.css','/app.js':'web/app.js','/style.css':'web/style.css','/rhwp.js':'vendor/rhwp/rhwp.js','/rhwp_bg.wasm':'vendor/rhwp/rhwp_bg.wasm'};
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
      if(!req.headers['content-type']?.startsWith('application/json'))return refuse(415,'JSON 요청만 받습니다.');
      // 한도를 넘은 본문은 버리면서 끝까지 읽은 뒤 413을 보낸다(읽다 끊으면 보내는 쪽이 답장 대신 연결 끊김을 받는다)
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size<=32*1024*1024)chunks.push(chunk);}
      if(size>32*1024*1024)return refuse(413,'요청은 32MB 이내여야 합니다.');
      let input;
      try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(e){if(generating)throw new G2B2Error(400,'INVALID_REQUEST','요청 본문이 JSON이 아닙니다.');throw e;}
      if(path==='/api/block/rename')return send(200,blockLibrary.rename(input?.id,input?.name));
      if(path==='/api/block/delete'){
        // Placements not yet saved to a work file are known only to open workbench sessions.
        if(input?.confirmed===true&&workbench.inUse(blockLibrary.get(input.id).protoId))throw new HostError(400,'BLOCK_IN_USE','사용 중이라 삭제할 수 없습니다: 열린 작업에서 저장 전 배치 중입니다. 그 작업에서 배치를 취소한 뒤 다시 시도하세요.');
        return send(200,blockLibrary.remove(input?.id,input?.confirmed));
      }
      if(path.startsWith('/api/quick/'))return send(200,quick.post(path,input));
      if(path.startsWith('/api/workbench/'))return send(200,workbench.post(path,input));
      if(path==='/api/g2b/profiles') {
        if(!req.headers.origin)return send(403,{error:'생성 프로필은 Studio의 Helper 연결 화면에서 설정하세요.'});
        return send(200,{profile:input&&typeof input==='object'&&'templateId' in input?g2b2.saveProfile(input):g2b.saveProfile(input)});
      }
      if(path==='/api/g2b/profiles/delete') {
        if(!req.headers.origin)return send(403,{error:'생성 프로필은 Studio의 Helper 연결 화면에서 설정하세요.'});
        return send(200,g2b2.deleteProfile(input));
      }
      if(path==='/api/g2b/templates') {
        if(!req.headers.origin)return send(403,{error:'서식은 Studio 화면에서 저장하세요.'});
        return send(200,g2b2.saveTemplate(input));
      }
      if(path==='/api/g2b/generate')return send(200,input?.format===STUDIO_GENERATE?await g2b2.generate(input):await g2b.generate(input));
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
    } catch(e) {if(e instanceof G2B2Error)return send(e.status,g2b2Body(e));
      // 생성 창구의 내부 예외: 메시지에 경로·SQL이 들 수 있어 쉬운 말만 보낸다
      if(generating&&!(e instanceof G2BRequestError))return send(500,g2b2Body(new G2B2Error(500,'GENERATION_FAILED',plainOf('GENERATION_FAILED'))));
      send(e instanceof G2BRequestError || e instanceof HostError?e.status:400,{error:e instanceof Error?e.message:'요청 처리에 실패했습니다.',...(e instanceof G2BRequestError?{status:'error',code:e.code}:pathCode(e)),...(req.url?.split('?')[0]==='/api/block/preview'?{plain:previewPlain(e)}:{})});}
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
