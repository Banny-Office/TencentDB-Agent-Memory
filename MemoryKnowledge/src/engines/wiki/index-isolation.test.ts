import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWikiSourceManager } from "./manager.js";
import { rebuildWikiIndex } from "./index-worker-client.js";
import { wikiOperations } from "../../wiki-operations.js";
import { Hono } from "hono";
import { accessLog } from "../../middleware/response-envelope.js";
import { createWikiRoutes } from "../../routes/wiki.js";
import type { WikiService } from "../../store/wiki-service.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(count = 4) {
  const root = mkdtempSync(join(tmpdir(), "wiki-isolation-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "asset");
  mkdirSync(join(path, "wiki"), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(path, "wiki", `${i}.md`),
    `---\ntitle: 审核规则${i}\ntype: concept\n---\n# 审核规则${i}\n隐私保护与账号交易 rule ${i} [[${(i + 1) % count}]]\n`);
  const manager = createWikiSourceManager(join(root, "state"));
  manager.register({ name: "wiki-test", path });
  cleanup.push(() => manager.remove("wiki-test"));
  return { manager, path };
}

describe("isolated Wiki indexing", () => {
  it("preserves exact ranking, scores, snippets, links and graph across a worker rebuild", async () => {
    const { manager } = fixture();
    const queries = ["隐私", "账号交易", "rule", "不存在", "审核规则"];
    const before = queries.flatMap(q => [0, 1, 2].map(hop => manager.search("wiki-test", q, 8, { hop })));
    const graph = manager.graph("wiki-test");
    await manager.syncAsync("wiki-test");
    const after = queries.flatMap(q => [0, 1, 2].map(hop => manager.search("wiki-test", q, 8, { hop })));
    expect(after).toEqual(before);
    expect(manager.graph("wiki-test")).toEqual(graph);
  });

  it("keeps the event loop and another Wiki responsive during a full rebuild", async () => {
    const { manager, path } = fixture();
    const other = fixture().manager;
    const body = "账号交易 隐私保护 审核标准例外 ".repeat(100);
    for (let i = 4; i < 1800; i++) writeFileSync(join(path, "wiki", `${i}.md`), `# 规则${i}\n${body}`);
    let ticks = 0;
    let maximumGap = 0;
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now(); maximumGap = Math.max(maximumGap, now - previous); previous = now;
      expect(other.search("wiki-test", "隐私", 8).count).toBeGreaterThan(0);
      ticks++;
    }, 20);
    try { await manager.syncAsync("wiki-test"); }
    finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(2);
    expect(maximumGap).toBeLessThan(500);
    expect(manager.get("wiki-test")?.pageCount).toBe(1800);
  }, 30_000);

  it("serializes same-Wiki mutations and lets unrelated Wikis proceed", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const first = wikiOperations.run("same", async () => { order.push("write"); await wait; });
    const read = wikiOperations.run("same", async () => { order.push("read"); });
    await wikiOperations.run("other", async () => { order.push("other"); });
    expect(order).toEqual(["write", "other"]);
    release(); await Promise.all([first, read]);
    expect(order).toEqual(["write", "other", "read"]);
    await expect(wikiOperations.run("same", async () => { throw new Error("failure"); })).rejects.toThrow("failure");
    await expect(wikiOperations.run("same", async () => "released")).resolves.toBe("released");
  });

  it("reports failed index builds and recovers after a successful rebuild", async () => {
    const { manager, path } = fixture();
    rmSync(join(path, "wiki"), { recursive: true });
    await expect(manager.syncAsync("wiki-test")).rejects.toThrow("wiki/ not found");
    expect(manager.get("wiki-test")?.status).toBe("error");
    mkdirSync(join(path, "wiki"));
    writeFileSync(join(path, "wiki", "new.md"), "# 恢复\n隐私保护");
    await manager.syncAsync("wiki-test");
    expect(manager.get("wiki-test")?.status).toBe("ready");
    expect(manager.search("wiki-test", "隐私", 8).count).toBe(1);
  });

  it("rolls back all index tables when source-state publication fails", async () => {
    const { manager, path } = fixture();
    const before = manager.search("wiki-test", "隐私", 8, { hop: 1 });
    writeFileSync(join(path, "wiki", "new.md"), "# transactionaluniquetoken\n新条款");
    await expect(rebuildWikiIndex({ path, processed: [{
      filename: "bad-source", sha256: null as unknown as string, size: 1, ok: true,
    }] })).rejects.toThrow();
    expect(manager.search("wiki-test", "隐私", 8, { hop: 1 })).toEqual(before);
    expect(manager.search("wiki-test", "transactionaluniquetoken", 8).count).toBe(0);
    await manager.syncAsync("wiki-test");
    expect(manager.search("wiki-test", "transactionaluniquetoken", 8).count).toBe(1);
  });

  it("does not ACK a write before indexing; failure returns 503 and blocks stale reads", async () => {
    const { manager, path } = fixture();
    const service = {
      getById: () => ({ wiki_id: "wiki-test", team_id: "team-test", status: "ready" }),
      pageWriteMany: () => { rmSync(join(path, "wiki"), { recursive: true }); return [{ ref: "x.md" }]; },
    } as unknown as WikiService;
    const app = new Hono();
    app.use("*", accessLog());
    app.route("/", createWikiRoutes({ wikiMgr: manager, wikiService: service, publicBaseUrl: "" }));
    const post = (route: string, body: unknown) => app.request(route, {
      method: "POST", headers: { "Content-Type": "application/json", "x-tdai-service-id": "default" }, body: JSON.stringify(body),
    });
    const result = await post("/page/write", { team_id: "team-test", wiki_id: "wiki-test", pages: [{ ref: "x.md", content: "x" }] });
    expect(result.status).toBe(503);
    expect((await result.json()).message).toContain("write may have been applied");
    expect((await post("/page/read", { wiki_id: "wiki-test", refs: ["x.md"] })).status).toBe(503);
  });
});
