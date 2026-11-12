// Shared by REST and tools. A request changing a Wiki holds its gate until its
// index is committed. Other Wikis never wait for this gate. Reads of the same
// Wiki wait rather than observe new bodies with the previous index.
class WikiOperations {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
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
