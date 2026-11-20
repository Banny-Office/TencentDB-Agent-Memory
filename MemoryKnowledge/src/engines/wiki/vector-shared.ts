import { createHash } from 'node:crypto';
import type { WikiPage } from './types.js';
import { parse as parseYaml } from 'yaml';

export class CaseRetrievalUnavailable extends Error {
  constructor(public reason:string){super('Case vector retrieval unavailable: '+reason);}
}
export const DEFAULT_CASE_PREFIX='资料文本质检判例：「';
export interface RetrievalPolicy {mode:'bm25'|'hybrid'|'case';minSimilarity:number;casePrefix:string}
export function retrievalPolicy(wikiId:string, requested?:'bm25'|'hybrid', env=process.env):RetrievalPolicy {
  const policies=JSON.parse(env.KNOWLEDGE_WIKI_RETRIEVAL_POLICIES??'{}');
  if(!policies || typeof policies!=='object' || Array.isArray(policies))throw new Error('Invalid Wiki retrieval policies');
  const entry=Object.hasOwn(policies,wikiId)?policies[wikiId]:undefined;
  if(entry && !['bm25','hybrid','case'].includes(entry.mode))throw new Error('Invalid Wiki retrieval policy');
  const mode=entry?.mode??requested??(env.KNOWLEDGE_RETRIEVAL_MODE==='hybrid'?'hybrid':'bm25');
  const minSimilarity=Number(entry?.min_similarity??(mode==='case'?0.85:env.KNOWLEDGE_VECTOR_MIN_SIMILARITY??0));
  if(!Number.isFinite(minSimilarity)||minSimilarity<0||minSimilarity>1)throw new Error('Invalid Wiki similarity threshold');
  const casePrefix=entry?.case_prefix??DEFAULT_CASE_PREFIX;
  if(typeof casePrefix!=='string'||!casePrefix.endsWith('：「')||casePrefix.length>100||casePrefix.includes('\n'))throw new Error('Invalid case original prefix');
  return {mode,minSimilarity,casePrefix};
}
/** Only original case text may enter the strict case index. Never use a truncated title. */
export function caseOriginal(page:WikiPage,prefix=DEFAULT_CASE_PREFIX):string|undefined {
  const fm=page.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(fm){
    const metadata=parseYaml(fm[1],{maxAliasCount:0});
    if(metadata && Object.prototype.hasOwnProperty.call(metadata,'retrieval_text')) {
      return typeof metadata.retrieval_text==='string' ? metadata.retrieval_text.trim()||undefined : undefined;
    }
  }
  const heading=/^## 规则正文[^\n]*\n/m.exec(page.content);
  if(!heading)return;
  const remainder=page.content.slice(heading.index+heading[0].length);
  const next=/^##[ \t]+/m.exec(remainder);
  const statement=(next?remainder.slice(0,next.index):remainder).trim();
  const end='」，质检结论：';
  if(!statement.startsWith(prefix))return;
  const at=statement.lastIndexOf(end);
  if(at<prefix.length)return;
  return statement.slice(prefix.length,at).trim()||undefined;
}

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function revision(pages: WikiPage[]): string {
  return digest(JSON.stringify(pages.map(p => [p.id, digest(p.title + '\n' + p.content)]).sort((a,b) => a[0].localeCompare(b[0]))));
}
export interface VectorConfig {
  baseUrl: string; apiKey: string; model: string; dimension: number; concurrency: number; minSimilarity: number; inputMode:'page'|'case_original'; casePrefix?:string;
}
export function vectorConfig(env = process.env): VectorConfig | undefined {
  if (env.KNOWLEDGE_EMBEDDING_ENABLED !== 'true' || env.KNOWLEDGE_EMBEDDING_PROVIDER !== 'tokenhub') return;
  const cfg = {baseUrl:(env.KNOWLEDGE_EMBEDDING_BASE_URL ?? '').replace(/\/+$/, ''),
    apiKey:env.KNOWLEDGE_EMBEDDING_API_KEY ?? '', model:env.KNOWLEDGE_EMBEDDING_MODEL ?? 'kinfra-vl-embedding-8b',
    dimension:4096, concurrency:Number(env.KNOWLEDGE_EMBEDDING_CONCURRENCY ?? 4),
    minSimilarity:Number(env.KNOWLEDGE_VECTOR_MIN_SIMILARITY ?? 0),inputMode:'page' as const};
  if (!cfg.apiKey || !cfg.baseUrl || cfg.model !== 'kinfra-vl-embedding-8b' ||
      !Number.isInteger(cfg.concurrency) || cfg.concurrency < 1 || cfg.concurrency > 8 ||
      !Number.isFinite(cfg.minSimilarity) || cfg.minSimilarity < 0 || cfg.minSimilarity > 1) throw new Error('Invalid TokenHub embedding configuration');
  const url = new URL(cfg.baseUrl);
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1') throw new Error('Embedding requires HTTPS');
  return cfg;
}
export const configId = (cfg: VectorConfig) => digest(JSON.stringify([cfg.baseUrl,cfg.model,cfg.dimension,cfg.inputMode==='case_original'?'case-original-v1'+(cfg.casePrefix&&cfg.casePrefix!==DEFAULT_CASE_PREFIX?':'+cfg.casePrefix:''):'char1800-mean-v1'])).slice(0,24);
export function wikiVectorConfig(wikiId:string,requested?:'bm25'|'hybrid'):VectorConfig|undefined {
  const policy=retrievalPolicy(wikiId,requested);
  if(policy.mode==='bm25')return;
  const cfg=vectorConfig();
  if(!cfg)return;
  return {...cfg,minSimilarity:policy.minSimilarity,inputMode:policy.mode==='case'?'case_original':'page',casePrefix:policy.casePrefix};
}
export function normalize(vector: number[], dimension: number): number[] {
  if (vector.length !== dimension || vector.some(x => typeof x !== 'number' || !Number.isFinite(x))) throw new Error('Invalid embedding vector');
  const norm = Math.sqrt(vector.reduce((sum,x) => sum+x*x,0));
  if (!norm) throw new Error('Zero embedding vector');
  return vector.map(x => x/norm);
}
export async function embed(text: string, cfg: VectorConfig, timeout = 15000): Promise<number[]> {
  const response = await fetch(cfg.baseUrl + '/embeddings/multimodal', {
    method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.apiKey},
    body:JSON.stringify({model:cfg.model,input:[{type:'text',text}],encoding_format:'float'}),
    signal:AbortSignal.timeout(timeout),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Embedding HTTP '+response.status); }
  const value = await response.json() as {data?:{index:number;embedding:number[]}[]};
  if (value.data?.length !== 1 || value.data[0].index !== 0 || !Array.isArray(value.data[0].embedding)) throw new Error('Invalid embedding response');
  return normalize(value.data[0].embedding,cfg.dimension);
}
export function fuse(lexical:{id:string;score:number}[], dense:{id:string;score:number}[]) {
  if (!dense.length) return lexical;
  const scores = new Map<string,number>();
  for (const list of [lexical,dense]) list.forEach((hit,rank) => scores.set(hit.id,(scores.get(hit.id)??0)+61/(61+rank)));
  return [...scores].map(([id,score]) => ({id,score})).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id));
}
