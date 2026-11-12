// Shared by synchronous startup and isolated runtime indexing. Keep ranking,
// tokenization, snippets and graph construction identical in both paths.
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type DatabaseType from "better-sqlite3";
import type { WikiPage } from "./types.js";
import { slugify } from "./ingest-v2/slug.js";
export const HIDDEN_TYPES = new Set(["query"]);

function extractFrontmatter(content: string): { title: string; type: string; sources: string[]; description: string } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const sources: string[] = [];
  const sourcesBlockMatch = fm.match(/^sources:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (sourcesBlockMatch) {
    for (const line of sourcesBlockMatch[1].split("\n")) {
      const itemMatch = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/);
      if (itemMatch) sources.push(itemMatch[1]);
    }
  } else {
    const inlineMatch = fm.match(/^sources:\s*\[([^\]]*)\]/m);
    if (inlineMatch) {
      for (const item of inlineMatch[1].split(",")) {
        const trimmed = item.trim().replace(/^["']|["']$/g, "");
        if (trimmed) sources.push(trimmed);
      }
    }
  }
  let title = titleMatch ? titleMatch[1].trim() : "";
  if (!title) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    title = headingMatch ? headingMatch[1].trim() : "";
  }
  return {
    title,
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "other",
    sources,
    description: descMatch ? descMatch[1].trim() : "",
  };
}

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

function resolveEdges(pages: WikiPage[]): Array<{ source: string; target: string }> {
  const visible = pages.filter((p) => !HIDDEN_TYPES.has(p.type));
  const out: Array<{ source: string; target: string }> = [];
  if (visible.length === 0) return out;

  const nodeIds = new Set(visible.map((p) => p.id));
  // title 的 slug → page id 映射：支持 wikilink 以页面标题（而非文件名）引用。
  const titleSlugToId = new Map<string, string>();
  for (const p of visible) {
    const ts = slugify(p.title);
    if (ts && !titleSlugToId.has(ts)) titleSlugToId.set(ts, p.id);
  }

  const seen = new Set<string>();
  for (const page of visible) {
    for (const targetRaw of page.links) {
      const targetId = resolveTarget(targetRaw, nodeIds, titleSlugToId);
      if (!targetId || targetId === page.id) continue;
      const key = `${page.id}\u0000${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source: page.id, target: targetId });
    }
  }
  return out;
}

function resolveTarget(
  raw: string,
  nodeIds: Set<string>,
  titleSlugToId: Map<string, string>,
): string | null {
  if (nodeIds.has(raw)) return raw;

  // wikilink 目标可能是各种花式写法（带 .md 后缀、带斜杠路径、中英混合、大小写不一）。
  // 统一用与文件名同源的 slugify 归一后比对 page id 的 basename（单一事实源，
  // 避免在此重复造一套归一逻辑）。slugify 把 `/`、空格、标点都当段边界，
  // 故 "/v3/wiki/create 接口" 与 "v3-wiki-create-接口" 归一后一致。
  const target = slugify(raw.replace(/\.md$/i, ""));
  if (!target) return null;

  const rawLower = raw.toLowerCase();
  for (const id of nodeIds) {
    if (id.toLowerCase() === rawLower) return id;
    const idBasename = id.split("/").pop() ?? id;
    if (slugify(idBasename) === target) return id;
  }
  // 回退：按页面标题的 slug 命中（wikilink 用页面标题而非文件名引用时）。
  const byTitle = titleSlugToId.get(target);
  if (byTitle) return byTitle;
  return null;
}

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
]);

const SNIPPET_CONTEXT = 80;

/**
 * 预生成页摘要（写入 page_meta.snippet）：优先 frontmatter description，
 * 否则取正文（去 frontmatter/标题）前 SNIPPET_CONTEXT 个字符。
 * 正文不入库，检索时直接返回该静态摘要（消费者主要是 AI，无需按 query 动态高亮）。
 */
function makeSnippet(page: WikiPage): string {
  if (page.description) return page.description;
  const body = page.content
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/^#+\s+.*$/gm, "")
    .trim();
  return [...body].slice(0, SNIPPET_CONTEXT).join("").replace(/\n/g, " ").trim();
}

/**
 * 分词器：中英文混合处理。
 * - 英文：按空格/标点切分，保留完整单词，过滤 stop words
 * - 中文：bigram + 单字
 *
 * 导出供 FTS5 预分词复用（006）与 bm25 评测：写入 FTS5 时把 content/title
 * 经此函数分词后以空格拼接存入，查询时对 query 用同一分词，保证中文逻辑一致。
 */
export function tokenize(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…\[\]【】{}《》<>]+/)
    .filter((t) => t.length > 0);

  const result: string[] = [];
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token);
    const hasLatin = /[a-z]/.test(token);

    if (hasCJK && hasLatin) {
      // 混合 token（如 "l0录入"）：拆分中英文部分分别处理
      const parts = token.split(/(?<=[a-z0-9])(?=[\u4e00-\u9fff])|(?<=[\u4e00-\u9fff])(?=[a-z0-9])/);
      for (const part of parts) {
        if (/[\u4e00-\u9fff]/.test(part) && part.length > 1) {
          const chars = [...part];
          for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
          result.push(part);
        } else if (part.length > 0 && !STOP_WORDS.has(part)) {
          result.push(part);
        }
      }
    } else if (hasCJK && token.length > 1) {
      // 纯中文：bigram
      const chars = [...token];
      for (let i = 0; i < chars.length - 1; i++) result.push(chars[i] + chars[i + 1]);
      result.push(token);
    } else if (!STOP_WORDS.has(token) && token.length > 0) {
      // 纯英文/数字：保留完整 token
      result.push(token);
    }
  }
  return result;
}

export function writeIndex(db: DatabaseType.Database, pages: WikiPage[]): void {
  db.prepare("DELETE FROM wiki_fts").run();
  db.prepare("DELETE FROM page_meta").run();
  db.prepare("DELETE FROM graph_edge").run();

  const insFts = db.prepare("INSERT INTO wiki_fts(page_id, title_tok, content_tok) VALUES (?,?,?)");
  const insMeta = db.prepare(
    "INSERT INTO page_meta(page_id, title, type, rel_path, snippet) VALUES (?,?,?,?,?)",
  );
  const insEdge = db.prepare("INSERT OR IGNORE INTO graph_edge(source_id, target_id) VALUES (?,?)");

  for (const p of pages) {
    // wiki_fts + page_meta 收录所有页（含 hidden 类型，供检索）。
    insFts.run(p.id, tokenize(p.title).join(" "), tokenize(p.content).join(" "));
    insMeta.run(p.id, p.title, p.type, p.relPath, makeSnippet(p));
  }
  // graph_edge 只在 visible 页间。
  for (const e of resolveEdges(pages)) insEdge.run(e.source, e.target);
}

export function scanWikiDir(projectPath: string): WikiPage[] {
  const wikiDir = join(projectPath, "wiki");
  if (!existsSync(wikiDir)) throw new Error(`wiki/ not found: ${wikiDir}`);
  const pages: WikiPage[] = [];
  scanRecursive(wikiDir, wikiDir, pages);
  return pages;
}

function scanRecursive(baseDir: string, dir: string, pages: WikiPage[]) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) { if (entry !== "media") scanRecursive(baseDir, full, pages); }
    else if (entry.endsWith(".md")) {
      try {
        const content = readFileSync(full, "utf-8");
        const rel = full.slice(baseDir.length + 1);
        const id = rel.replace(/\.md$/, "").replace(/\\/g, "/");
        const fm = extractFrontmatter(content);
        pages.push({ id, title: fm.title || basename(entry, ".md").replace(/-/g, " "), type: fm.type, path: full, relPath: `wiki/${rel}`, content, sources: fm.sources, links: extractWikilinks(content), description: fm.description });
      } catch { /* skip */ }
    }
  }
}

