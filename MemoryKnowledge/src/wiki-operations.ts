// Shared by REST and tools. A request changing a Wiki holds its gate until its
// index is committed. Other Wikis never wait for this gate. Reads of the same
// Wiki wait rather than observe new bodies with the previous index.
class WikiOperations {
  private tails = new Map<string, Promise<void>>();
  private readers = new Map<string, Set<Promise<void>>>();
  async read<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous=this.tails.get(key)??Promise.resolve();
    let release!:()=>void;
    const done=new Promise<void>(resolve=>{release=resolve;});
    const readers=this.readers.get(key)??new Set<Promise<void>>();
    this.readers.set(key,readers);readers.add(done);
    await previous;
    try{return await operation();}
    finally{release();readers.delete(done);if(!readers.size&&this.readers.get(key)===readers)this.readers.delete(key);}
  }
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // Snapshot preceding readers. Readers arriving later wait behind this writer.
    const previous = Promise.all([this.tails.get(key)??Promise.resolve(),...(this.readers.get(key)??[])]).then(()=>{});
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => done);
    this.tails.set(key, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
export const wikiOperations = new WikiOperations();
export const wikiOperationKey = (serviceId: string, wikiId: string) => JSON.stringify([serviceId, wikiId]);
