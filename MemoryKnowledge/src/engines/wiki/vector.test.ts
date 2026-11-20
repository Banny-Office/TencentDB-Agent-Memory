import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWikiSourceManager } from './manager.js';
import { embed, normalize, vectorConfig, fuse, configId, caseOriginal } from './vector-shared.js';
import { wikiOperations } from '../../wiki-operations.js';

const clean:Array<()=>unknown>=[];
afterEach(async()=>{for(const fn of clean.splice(0).reverse())await fn();});
async function fixture(mode?:'case'|'bm25') {
  const original={...process.env};clean.push(()=>{process.env=original;});
  let failing=false,delay=0;
  const requests:any[]=[];
  const server:Server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push({url:req.url,...body});
    if(!body.input[0].text.trim()){res.writeHead(400);res.end('{}');return;}
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    if(failing){res.writeHead(503);res.end('{}');return;}
    const vector=Array(4096).fill(0);
    vector[body.input[0].text.includes('天气')?1:0]=1;
    if(body.input[0].text.includes('_below_threshold_')){vector[0]=0.8499;vector[1]=Math.sqrt(1-vector[0]**2);}
    if(body.input[0].text.includes('_at_threshold_')){vector[0]=0.85;vector[1]=Math.sqrt(1-vector[0]**2);}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{index:0,embedding:vector}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  clean.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as {port:number}).port;
  Object.assign(process.env,{KNOWLEDGE_EMBEDDING_ENABLED:'true',KNOWLEDGE_EMBEDDING_PROVIDER:'tokenhub',KNOWLEDGE_EMBEDDING_BASE_URL:`http://127.0.0.1:${port}/v1`,KNOWLEDGE_EMBEDDING_MODEL:'kinfra-vl-embedding-8b',KNOWLEDGE_EMBEDDING_API_KEY:'test-key',KNOWLEDGE_EMBEDDING_CONCURRENCY:'2',KNOWLEDGE_RETRIEVAL_MODE:'hybrid',KNOWLEDGE_VECTOR_MIN_SIMILARITY:'0.85'});
  delete process.env.KNOWLEDGE_WIKI_RETRIEVAL_POLICIES;
  if(mode)process.env.KNOWLEDGE_WIKI_RETRIEVAL_POLICIES=JSON.stringify({'wiki-test0000':{mode,min_similarity:.85}});
  const root=mkdtempSync(join(tmpdir(),'wiki-vector-'));clean.push(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'asset');mkdirSync(join(path,'wiki'),{recursive:true});
  writeFileSync(join(path,'wiki','account.md'),'# 账号解封条件\n提交申诉审核资料。');
  writeFileSync(join(path,'wiki','weather.md'),'# 天气预报\n晴天和雨天。');
  const manager=createWikiSourceManager(join(root,'state'));
  manager.register({name:'wiki-test0000',path});clean.push(()=>manager.remove('wiki-test0000'));
  return {manager,path,requests,fail:(value:boolean)=>{failing=value;},delay:(value:number)=>{delay=value;}};
}
describe('TokenHub hybrid retrieval',()=>{
  it('filters below 0.85, includes the boundary, and preserves vectors across threshold changes',async()=>{
    const {manager}=await fixture();await manager.reindexVectors('wiki-test0000');
    const below=await manager.searchAsync('wiki-test0000','_below_threshold_',8,{hop:0});
    expect(below.count).toBe(0);expect(below.retrieval?.min_similarity).toBe(.85);
    expect(below.retrieval?.fallback_reason).toBe('below_similarity_threshold');
    const boundary=await manager.searchAsync('wiki-test0000','_at_threshold_',8,{hop:0});
    expect(boundary.results.map(r=>r.path)).toEqual(['wiki/account.md']);
    expect(boundary.retrieval?.mode).toBe('hybrid');
    const cfg=vectorConfig()!;expect(configId(cfg)).toBe(configId({...cfg,minSimilarity:0}));
    expect(()=>vectorConfig({...process.env,KNOWLEDGE_VECTOR_MIN_SIMILARITY:'1.01'})).toThrow();
    expect(()=>vectorConfig({...process.env,KNOWLEDGE_VECTOR_MIN_SIMILARITY:'NaN'})).toThrow();
  });
  it('allows concurrent reads but gives a queued write priority over later reads',async()=>{
    let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});const order:string[]=[];
    const one=wikiOperations.read('rw-test',async()=>{order.push('read1');await hold;});
    const two=wikiOperations.read('rw-test',async()=>{order.push('read2');await hold;});
    await new Promise(resolve=>setTimeout(resolve,0));expect(order).toEqual(['read1','read2']);
    const write=wikiOperations.run('rw-test',async()=>{order.push('write');});
    const last=wikiOperations.read('rw-test',async()=>{order.push('last');});
    release();await Promise.all([one,two,write,last]);expect(order).toEqual(['read1','read2','write','last']);
    await expect(wikiOperations.read('rw-test',async()=>{throw new Error('fail');})).rejects.toThrow('fail');
    await expect(wikiOperations.run('rw-test',async()=>'released')).resolves.toBe('released');
  });
  it('recalls a semantic-only match through the native REST endpoint and preserves explicit BM25',async()=>{
    const {manager,requests}=await fixture();
    const before=manager.search('wiki-test0000','恢复使用权限',1,{hop:0});
    expect(before.count).toBe(0);
    await manager.reindexVectors('wiki-test0000');
    const {Hono}=await import('hono');const {createWikiRoutes}=await import('../../routes/wiki.js');
    const app=new Hono();app.route('/',createWikiRoutes({wikiMgr:manager,wikiService:{getById:(s:string)=>s==='default'?{team_id:'team-test',status:'ready'}:null} as any,publicBaseUrl:''}));
    const request=(body:unknown,service='default',route='/search')=>app.request(route,{method:'POST',headers:{'Content-Type':'application/json','X-Tdai-Service-Id':service},body:JSON.stringify(body)});
    const response=await request({wiki_id:'wiki-test0000',query:'恢复使用权限',limit:1,hop:0});
    const hybrid=(await response.json()).data;
    expect(hybrid.retrieval.mode).toBe('hybrid');
    expect(hybrid.results.map((r:any)=>r.path)).toEqual(['wiki/account.md']);
    expect(await manager.searchAsync('wiki-test0000','恢复使用权限',1,{hop:0,retrieval:'bm25'})).toEqual(before);
    expect(requests.every(r=>r.url==='/v1/embeddings/multimodal'&&r.input.length===1&&r.input[0].type==='text')).toBe(true);
    expect((await request({wiki_id:'wiki-test0000'},'foreign','/vector/status')).status).toBe(404);
  });
  it('falls back exactly to BM25 when the model fails; failed rebuilds do not alter wiki readiness',async()=>{
    const {manager,path,fail}=await fixture();await manager.reindexVectors('wiki-test0000');
    fail(true);
    const baseline=manager.search('wiki-test0000','账号',8);
    const fallback=await manager.searchAsync('wiki-test0000','账号',8);
    expect(fallback.retrieval?.mode).toBe('bm25');
    delete fallback.retrieval;expect(fallback).toEqual(baseline);
    writeFileSync(join(path,'wiki','new.md'),'# 新的知识');await manager.syncAsync('wiki-test0000');
    await expect(manager.reindexVectors('wiki-test0000')).rejects.toThrow('503');
    expect(manager.get('wiki-test0000')?.status).toBe('ready');
    expect((await manager.vectorStatus('wiki-test0000') as any).ready).toBe(false);
  });
  it('excludes deleted pages immediately while the new vector index is building and reuses unchanged vectors',async()=>{
    const {manager,path,requests}=await fixture();await manager.reindexVectors('wiki-test0000');
    const count=requests.length;
    rmSync(join(path,'wiki','account.md'));await manager.syncAsync('wiki-test0000');
    const result=await manager.searchAsync('wiki-test0000','恢复使用权限',8,{hop:0});
    expect(result.results.some(r=>r.path==='wiki/account.md')).toBe(false);
    await manager.reindexVectors('wiki-test0000');
    expect(requests.length-count).toBeLessThanOrEqual(1); // Query only; weather's document vector is reused.
  });
  it('does not block the main event loop while documents are embedded',async()=>{
    const {manager,path,delay}=await fixture();delay(30);
    for(let i=0;i<20;i++)writeFileSync(join(path,'wiki',i+'.md'),'# 独立知识 '+i);
    await manager.syncAsync('wiki-test0000');let ticks=0;const timer=setInterval(()=>ticks++,10);
    try { await manager.reindexVectors('wiki-test0000'); } finally {clearInterval(timer);}
    expect(ticks).toBeGreaterThan(5);
  });
  it('reacquires the read connection when an index update completes during the model request',async()=>{
    const {manager,path,delay}=await fixture();await manager.reindexVectors('wiki-test0000');delay(150);
    const query=manager.searchAsync('wiki-test0000','恢复使用权限',8,{hop:0});
    await new Promise(resolve=>setTimeout(resolve,80));
    rmSync(join(path,'wiki','account.md'));await manager.syncAsync('wiki-test0000');
    const result=await query;
    expect(result.results.some(r=>r.path==='wiki/account.md')).toBe(false);
    expect(result.retrieval?.mode).toBe('bm25');
    await manager.reindexVectors('wiki-test0000');
  });
  it('skips a whitespace-only trailing chunk instead of failing the whole Wiki build',async()=>{
    const {manager,path,requests}=await fixture();
    const title='尾部空白',prefix='# '+title+'\n';
    const content=prefix+'a'.repeat(1800-title.length-1-prefix.length)+'\n';
    writeFileSync(join(path,'wiki','trailing.md'),content);
    await manager.syncAsync('wiki-test0000');await manager.reindexVectors('wiki-test0000');
    expect((await manager.vectorStatus('wiki-test0000') as any).ready).toBe(true);
    expect(requests.every(r=>r.input[0].text.trim().length>0)).toBe(true);
  });
  it('validates provider configuration, vector dimensions and RRF fusion',async()=>{
    expect(()=>normalize([NaN],1)).toThrow();expect(()=>normalize([0],1)).toThrow();
    expect(()=>vectorConfig({KNOWLEDGE_EMBEDDING_ENABLED:'true',KNOWLEDGE_EMBEDDING_PROVIDER:'tokenhub'})).toThrow();
    expect(fuse([{id:'a',score:999},{id:'b',score:2}],[{id:'b',score:.99},{id:'c',score:.9}])[0].id).toBe('b');
    const {fail}=await fixture();fail(true);await expect(embed('测试',vectorConfig()!)).rejects.toThrow('503');
  });
});

const casePage=(text:string,label='高风险')=>'---\ntype: source\ntitle: 截断标题\n---\n# 共同模板 天气 账号\n[[weather]]\n## 规则正文\n\n资料文本质检判例：「'+text+'」，质检结论：'+label+'。共同模板 天气 账号\n\n## 完整知识记录\n```json\n'+JSON.stringify({type:'case',statement:'这里不是向量来源'})+'\n```\n';
describe('strict per-Wiki case retrieval',()=>{
  it('extracts intact originals or the designated field, excluding structural pages and conclusions',()=>{
    const page=(content:string)=>({content} as any);
    expect(caseOriginal(page(casePage('越域情深²⁰²⁶₇₇₅₃')))).toBe('越域情深²⁰²⁶₇₇₅₃');
    expect(caseOriginal(page(casePage('内含」，质检结论：的原文')))).toBe('内含」，质检结论：的原文');
    expect(caseOriginal(page('---\nretrieval_text: "  指定原文²⁰²⁶  "\n---\n标签与结论'))).toBe('指定原文²⁰²⁶');
    expect(caseOriginal(page('---\nretrieval_text: ""\n---\n'+casePage('不会回退')))).toBeUndefined();
    expect(caseOriginal(page('# Index\n判例'))).toBeUndefined();
    expect(caseOriginal(page(casePage('原文').replace('## 规则正文','## 其他正文')))).toBeUndefined();
    expect(caseOriginal(page(casePage('长'.repeat(100)+'\n多行「原文」')))).toBe('长'.repeat(100)+'\n多行「原文」');
  });
  it('filters final results per cosine without lexical or graph fallback and reuses original vectors after conclusion edits',async()=>{
    const {manager,path,requests}=await fixture('case');
    writeFileSync(join(path,'wiki','case.md'),casePage('日结1109516670'));
    writeFileSync(join(path,'wiki','weather-case.md'),casePage('天气晴天'));
    await manager.syncAsync('wiki-test0000');await manager.reindexVectors('wiki-test0000');
    expect(requests.map(r=>r.input[0].text)).toEqual(expect.arrayContaining(['日结1109516670','天气晴天']));
    expect(requests.every(r=>!r.input[0].text.includes('质检结论'))).toBe(true);
    const result=await manager.searchAsync('wiki-test0000','账号 _at_threshold_',8,{retrieval:'bm25',hop:5,minScore:0});
    expect(result.retrieval?.mode).toBe('case_vector');
    expect(result.results.map(r=>r.path)).toEqual(['wiki/case.md']);
    expect(result.results[0].similarity).toBeCloseTo(.85,6);
    expect(result.results[0].score).toBe(result.results[0].similarity);
    expect(result.results[0].related).toEqual([]);expect(result.links).toEqual([]);
    const miss=await manager.searchAsync('wiki-test0000','账号 _below_threshold_',8,{hop:5});
    expect(miss.count).toBe(0);expect(miss.retrieval?.empty_reason).toBe('below_similarity_threshold');
    expect(miss.retrieval?.fallback_reason).toBeUndefined();
    const status=await manager.vectorStatus('wiki-test0000') as any;
    expect(status.pages).toBe(2);expect(status.excluded_pages).toBe(2);expect(status.input_mode).toBe('case_original');
    const count=requests.length;
    writeFileSync(join(path,'wiki','case.md'),casePage('日结1109516670','正常'));
    await manager.syncAsync('wiki-test0000');await manager.reindexVectors('wiki-test0000');
    expect(requests.length).toBe(count);
    expect(configId({...vectorConfig()!,inputMode:'case_original'})).not.toBe(configId(vectorConfig()!));
  });
  it('distinguishes service failure from an empty business miss in both HTTP entry points',async()=>{
    const {manager,path,fail}=await fixture('case');
    writeFileSync(join(path,'wiki','case.md'),casePage('原文'));await manager.syncAsync('wiki-test0000');await manager.reindexVectors('wiki-test0000');
    const {Hono}=await import('hono');const {createWikiRoutes}=await import('../../routes/wiki.js');
    const {createToolsRoutes}=await import('../../routes/tools.js');
    const wikiService={getById:()=>({wiki_id:'wiki-test0000',team_id:'team-test',status:'ready'})} as any;
    const app=new Hono();app.route('/wiki',createWikiRoutes({wikiMgr:manager,wikiService,publicBaseUrl:''}));
    app.route('/tools',createToolsRoutes({wikiMgr:manager,wikiService,cgService:{} as any,instancePool:{} as any}));
    fail(true);
    for(const [route,body] of [['/wiki/search',{wiki_id:'wiki-test0000',query:'原文'}],['/tools/call',{knowledge_id:'wiki-test0000',tool_name:'search',params:{query:'原文'}}]] as const){
      const response=await app.request(route,{method:'POST',headers:{'Content-Type':'application/json','X-Tdai-Service-Id':'default'},body:JSON.stringify(body)});
      expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).toContain('case_vector_unavailable');
    }
  });
  it('keeps formal knowledge on unchanged BM25 without starting embeddings',async()=>{
    const {manager,requests}=await fixture('bm25');await manager.reindexVectors('wiki-test0000');
    expect(await manager.searchAsync('wiki-test0000','账号',8)).toEqual(manager.search('wiki-test0000','账号',8));
    expect(await manager.searchAsync('wiki-test0000','账号',8,{retrieval:'hybrid'})).toEqual(manager.search('wiki-test0000','账号',8));
    expect(requests).toHaveLength(0);
    expect(await manager.vectorStatus('wiki-test0000')).toEqual({enabled:false,ready:false,retrieval_mode:'bm25'});
  });
});
