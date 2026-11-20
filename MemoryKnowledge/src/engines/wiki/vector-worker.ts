import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pLimit from 'p-limit';
import { scanWikiDir } from './index-builder.js';
import { configId, digest, embed, normalize, revision, type VectorConfig } from './vector-shared.js';

interface Job { kind:'build'|'search'|'status'; path:string; cfg:VectorConfig; revision?:string; query?:string; limit?:number }
const job = workerData as Job;
const file = join(job.path,'.hybrid',configId(job.cfg)+'.db');
function currentRevision(): string | undefined {
  const db = new Database(join(job.path,'index.db'),{readonly:true});
  try { return (db.prepare('SELECT revision FROM index_revision WHERE id=1').get() as {revision:string}|undefined)?.revision; }
  finally { db.close(); }
}
function published(db: Database.Database): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key='revision'").get() as {value:string}|undefined)?.value;
}
async function main() {
  if (job.kind !== 'build' && !existsSync(file)) return job.kind==='status' ? {ready:false,reason:'index_missing'} : {hits:[],reason:'index_missing'};
  if (job.kind === 'build') mkdirSync(join(job.path,'.hybrid'),{recursive:true});
  const db = new Database(file,{readonly:job.kind!=='build',timeout:1000});
  try {
    if (job.kind === 'build') {
      db.pragma('journal_mode=WAL');
      db.exec('CREATE TABLE IF NOT EXISTS cache (hash TEXT PRIMARY KEY, vector BLOB NOT NULL); CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      const pages = scanWikiDir(job.path);
      const target = revision(pages);
      if (target !== currentRevision()) throw new Error('Wiki changed during vector snapshot');
      if (published(db) === target) return {ready:true,pages:pages.length,revision:target};
      const slots = pLimit(job.cfg.concurrency);
      const pending = new Map<string,Promise<void>>();
      const mappings = pages.map(page => ({id:page.id,hash:digest(page.title+'\n'+page.content),text:page.title+'\n'+page.content}));
      const lookup = db.prepare('SELECT 1 FROM cache WHERE hash=?');
      const save = db.prepare('INSERT OR REPLACE INTO cache VALUES (?,?)');
      let failure: unknown;
      for (const item of mappings) {
        if (lookup.get(item.hash) || pending.has(item.hash)) continue;
        pending.set(item.hash,slots(async () => {
          if (failure) return;
          try {
            const chars = Array.from(item.text);
            const sum = Array<number>(job.cfg.dimension).fill(0);
            for (let offset=0;offset<chars.length;offset+=1800) {
              let vector: number[] | undefined;
              for (let attempt=0;attempt<3;attempt++) {
                try { vector = await embed(chars.slice(offset,offset+1800).join(''),job.cfg); break; }
                catch (error) { if(attempt===2) throw error; await new Promise(resolve=>setTimeout(resolve,500*(attempt+1))); }
              }
              for(let i=0;i<sum.length;i++) sum[i]+=vector![i];
            }
            const vector = Float32Array.from(normalize(sum,job.cfg.dimension));
            save.run(item.hash,Buffer.from(vector.buffer));
            parentPort!.postMessage({progress:true});
          } catch (error) { failure=error; throw error; }
        }));
      }
      const outcomes = await Promise.allSettled(pending.values());
      const failed = outcomes.find(r=>r.status==='rejected');
      if (failed?.status==='rejected') throw failed.reason;
      if (currentRevision() !== target) throw new Error('Wiki changed during vector build');
      db.transaction(() => {
        db.prepare('DELETE FROM pages').run();
        const insert=db.prepare('INSERT INTO pages VALUES (?,?)');
        for(const item of mappings) {
          if (!lookup.get(item.hash)) throw new Error('Incomplete vector index');
          insert.run(item.id,item.hash);
        }
        db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('revision',target);
      })();
      return {ready:true,pages:pages.length,revision:target};
    }
    const target = published(db);
    if(job.kind==='status') return {ready:target===currentRevision(),revision:target,pages:(db.prepare('SELECT count(*) AS n FROM pages').get() as {n:number}).n,cached:(db.prepare('SELECT count(*) AS n FROM cache').get() as {n:number}).n};
    if (target !== job.revision) return {hits:[],reason:'index_stale'};
    const query = await embed(job.query!,job.cfg,2500);
    return db.transaction(() => {
      if (published(db) !== job.revision) return {hits:[],reason:'index_changed'};
      const hits: {id:string;score:number}[]=[];
      for(const row of db.prepare('SELECT p.id,c.vector FROM pages p JOIN cache c ON c.hash=p.hash').iterate() as Iterable<{id:string;vector:Buffer}>) {
        if (row.vector.length !== job.cfg.dimension*4) throw new Error('Invalid stored vector');
        const vector = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength));
        let score=0;for(let i=0;i<query.length;i++) score+=query[i]*vector[i];
        if(score>0) hits.push({id:row.id,score});
      }
      hits.sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id));
      return {hits:hits.slice(0,job.limit),revision:job.revision};
    })();
  } finally { db.close(); }
}
main().then(result=>parentPort!.postMessage({result})).catch(error=>parentPort!.postMessage({error:error instanceof Error ? error.message : 'Vector worker failed'}));
