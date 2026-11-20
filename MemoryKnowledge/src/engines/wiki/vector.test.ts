import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWikiSourceManager } from './manager.js';
import { embed, normalize, vectorConfig, fuse } from './vector-shared.js';

const clean:Array<()=>unknown>=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
async function fixture() {
  const original={...process.env};clean.push(()=>{process.env=original;});
  let failing=false,delay=0;
  const requests:any[]=[];
  const server:Server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push({url:req.url,...body});
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    if(failing){res.writeHead(503);res.end('{}');return;}
    const vector=Array(4096).fill(0);
    vector[body.input[0].text.includes('天气')?1:0]=1;
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{index:0,embedding:vector}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  clean.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as {port:number}).port;
  Object.assign(process.env,{KNOWLEDGE_EMBEDDING_ENABLED:'true',KNOWLEDGE_EMBEDDING_PROVIDER:'tokenhub',KNOWLEDGE_EMBEDDING_BASE_URL:`http://127.0.0.1:${port}/v1`,KNOWLEDGE_EMBEDDING_MODEL:'kinfra-vl-embedding-8b',KNOWLEDGE_EMBEDDING_API_KEY:'test-key',KNOWLEDGE_EMBEDDING_CONCURRENCY:'2',KNOWLEDGE_RETRIEVAL_MODE:'hybrid'});
  const root=mkdtempSync(join(tmpdir(),'wiki-vector-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'asset');mkdirSync(join(path,'wiki'),{recursive:true});
  writeFileSync(join(path,'wiki','account.md'),'# 账号解封条件\n提交申诉审核资料。');
  writeFileSync(join(path,'wiki','weather.md'),'# 天气预报\n晴天和雨天。');
  const manager=createWikiSourceManager(join(root,'state'));
  manager.register({name:'wiki-test',path});clean.push(()=>manager.remove('wiki-test'));
  return {manager,path,requests,fail:(value:boolean)=>{failing=value;},delay:(value:number)=>{delay=value;}};
}
describe('TokenHub hybrid retrieval',()=>{
  it('recalls a semantic-only match through the native REST endpoint and preserves explicit BM25',async()=>{
    const {manager,requests}=await fixture();
    const before=manager.search('wiki-test','恢复使用权限',1,{hop:0});
    expect(before.count).toBe(0);
    await manager.reindexVectors('wiki-test');
    const {Hono}=await import('hono');const {createWikiRoutes}=await import('../../routes/wiki.js');
    const app=new Hono();app.route('/',createWikiRoutes({wikiMgr:manager,wikiService:{getById:(s:string)=>s==='default'?{team_id:'team-test',status:'ready'}:null} as any,publicBaseUrl:''}));
    const request=(body:unknown,service='default',route='/search')=>app.request(route,{method:'POST',headers:{'Content-Type':'application/json','X-Tdai-Service-Id':service},body:JSON.stringify(body)});
    const response=await request({wiki_id:'wiki-test',query:'恢复使用权限',limit:1,hop:0});
    const hybrid=(await response.json()).data;
    expect(hybrid.retrieval.mode).toBe('hybrid');
    expect(hybrid.results.map((r:any)=>r.path)).toEqual(['wiki/account.md']);
    expect(await manager.searchAsync('wiki-test','恢复使用权限',1,{hop:0,retrieval:'bm25'})).toEqual(before);
    expect(requests.every(r=>r.url==='/v1/embeddings/multimodal'&&r.input.length===1&&r.input[0].type==='text')).toBe(true);
    expect((await request({wiki_id:'wiki-test'},'foreign','/vector/status')).status).toBe(404);
  });
  it('falls back exactly to BM25 when the model fails; failed rebuilds do not alter wiki readiness',async()=>{
    const {manager,path,fail}=await fixture();await manager.reindexVectors('wiki-test');
    fail(true);
    const baseline=manager.search('wiki-test','账号',8);
    const fallback=await manager.searchAsync('wiki-test','账号',8);
    expect(fallback.retrieval?.mode).toBe('bm25');
    delete fallback.retrieval;expect(fallback).toEqual(baseline);
    writeFileSync(join(path,'wiki','new.md'),'# 新的知识');await manager.syncAsync('wiki-test');
    await expect(manager.reindexVectors('wiki-test')).rejects.toThrow('503');
    expect(manager.get('wiki-test')?.status).toBe('ready');
    expect((await manager.vectorStatus('wiki-test') as any).ready).toBe(false);
  });
  it('excludes deleted pages immediately while the new vector index is building and reuses unchanged vectors',async()=>{
    const {manager,path,requests}=await fixture();await manager.reindexVectors('wiki-test');
    const count=requests.length;
    rmSync(join(path,'wiki','account.md'));await manager.syncAsync('wiki-test');
    const result=await manager.searchAsync('wiki-test','恢复使用权限',8,{hop:0});
    expect(result.results.some(r=>r.path==='wiki/account.md')).toBe(false);
    await manager.reindexVectors('wiki-test');
    expect(requests.length-count).toBeLessThanOrEqual(1); // Query only; weather's document vector is reused.
  });
  it('does not block the main event loop while documents are embedded',async()=>{
    const {manager,path,delay}=await fixture();delay(30);
    for(let i=0;i<20;i++)writeFileSync(join(path,'wiki',i+'.md'),'# 独立知识 '+i);
    await manager.syncAsync('wiki-test');let ticks=0;const timer=setInterval(()=>ticks++,10);
    try { await manager.reindexVectors('wiki-test'); } finally {clearInterval(timer);}
    expect(ticks).toBeGreaterThan(5);
  });
  it('reacquires the read connection when an index update completes during the model request',async()=>{
    const {manager,path,delay}=await fixture();await manager.reindexVectors('wiki-test');delay(150);
    const query=manager.searchAsync('wiki-test','恢复使用权限',8,{hop:0});
    await new Promise(resolve=>setTimeout(resolve,80));
    rmSync(join(path,'wiki','account.md'));await manager.syncAsync('wiki-test');
    const result=await query;
    expect(result.results.some(r=>r.path==='wiki/account.md')).toBe(false);
    expect(result.retrieval?.mode).toBe('bm25');
    await manager.reindexVectors('wiki-test');
  });
  it('validates provider configuration, vector dimensions and RRF fusion',async()=>{
    expect(()=>normalize([NaN],1)).toThrow();expect(()=>normalize([0],1)).toThrow();
    expect(()=>vectorConfig({KNOWLEDGE_EMBEDDING_ENABLED:'true',KNOWLEDGE_EMBEDDING_PROVIDER:'tokenhub'})).toThrow();
    expect(fuse([{id:'a',score:999},{id:'b',score:2}],[{id:'b',score:.99},{id:'c',score:.9}])[0].id).toBe('b');
    const {fail}=await fixture();fail(true);await expect(embed('测试',vectorConfig()!)).rejects.toThrow('503');
  });
});
