import { Worker } from 'node:worker_threads';
import pLimit from 'p-limit';
import { configId, type VectorConfig } from './vector-shared.js';

const buildSlots=pLimit(1), querySlots=pLimit(4);
const builds=new Map<string,Promise<unknown>>();
const retryAfter=new Map<string,number>();
function run(job: {kind:'build'|'search'|'status';path:string;cfg:VectorConfig;revision?:string;query?:string;limit?:number}, timeout:number):Promise<any> {
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? '../../../dist/vector-worker.mjs' : './vector-worker.mjs',import.meta.url),{workerData:job});
    let result:unknown, failure:Error|undefined;
    let timer:ReturnType<typeof setTimeout>;
    const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{failure=new Error('Vector worker timed out');void worker.terminate();},timeout);};
    arm();
    worker.on('message',value=>{if(value.progress){arm();return;}if(value.error)failure=new Error(value.error);else result=value.result;});
    worker.on('error',error=>{failure=error instanceof Error ? error : new Error(String(error));});
    worker.on('exit',code=>{clearTimeout(timer);if(failure||code!==0||result===undefined)reject(failure??new Error('Vector worker exited'));else resolve(result);});
  });
}
export function scheduleVectors(path:string, force=false, cfg:VectorConfig|undefined=undefined):Promise<unknown> {
  if(!cfg) return Promise.resolve(undefined);
  const key=path+":"+configId(cfg);
  if(builds.has(key)) return builds.get(key)!;
  if(!force && (retryAfter.get(key)??0)>Date.now()) return Promise.resolve(undefined);
  const job=buildSlots(()=>run({kind:'build',path,cfg},120000));
  builds.set(key,job);
  void job.then(result=>{retryAfter.delete(key);console.info('[wiki-vector] index ready',JSON.stringify({path,pages:result.pages,revision:result.revision}));},error=>{
    retryAfter.set(key,Date.now()+60000);console.warn('[wiki-vector] build deferred',JSON.stringify({path,error:error.message}));
    if(error.message.startsWith('Wiki changed')) setTimeout(()=>{void scheduleVectors(path,true,cfg);},1000).unref();
  }).finally(()=>builds.delete(key));
  // Callers may await explicit jobs; background callers cannot create unhandled rejections.
  void job.catch(()=>{});
  return job;
}
export async function vectorHits(path:string,revision:string,query:string,limit:number,cfg:VectorConfig|undefined):Promise<{hits:{id:string;score:number}[];reason?:string}> {
  if(!cfg)return {hits:[],reason:'disabled'};
  if(querySlots.pendingCount>=8)return {hits:[],reason:'busy'};
  const deadline=Date.now()+5000;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const work=querySlots(()=> Date.now()>=deadline ? Promise.resolve({hits:[],reason:'busy'}) : run({kind:'search',path,cfg,revision,query,limit},deadline-Date.now()));
    const result=await Promise.race([work,new Promise<{hits:[];reason:string}>(resolve=>{timer=setTimeout(()=>resolve({hits:[],reason:'timeout'}),5000);})]);
    if(['index_missing','index_stale','index_changed'].includes(result.reason)) void scheduleVectors(path,false,cfg);
    if(!result.reason && !result.hits.length)result.reason='below_similarity_threshold';
    return result;
  } catch { return {hits:[],reason:'vector_unavailable'}; }
  finally {clearTimeout(timer);}
}
export async function vectorStatus(path:string,cfg:VectorConfig|undefined) {
  if(!cfg)return {enabled:false,ready:false};
  return {...await run({kind:'status',path,cfg},5000),enabled:true,model:cfg.model,min_similarity:cfg.minSimilarity,input_mode:cfg.inputMode,building:builds.has(path+":"+configId(cfg))};
}
