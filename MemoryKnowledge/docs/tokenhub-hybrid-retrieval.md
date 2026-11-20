# TokenHub 混合知识检索

Wiki 的原生 `/v3/wiki/search` 和 `/v3/tools/call` search 工具共用混合检索。原请求不需要修改；`results`、`links`、`count` 保持原结构和 limit 语义。原有同步 MCP Wiki 引擎仍使用 BM25。

## 运行配置

```dotenv
KNOWLEDGE_EMBEDDING_ENABLED=true
KNOWLEDGE_EMBEDDING_PROVIDER=tokenhub
KNOWLEDGE_EMBEDDING_BASE_URL=https://tokenhub.tencentmaas.com/v1
KNOWLEDGE_EMBEDDING_MODEL=kinfra-vl-embedding-8b
KNOWLEDGE_EMBEDDING_DIMENSION=4096
KNOWLEDGE_EMBEDDING_API_KEY=<从受保护的环境注入，不提交 Git>
KNOWLEDGE_EMBEDDING_CONCURRENCY=4
KNOWLEDGE_RETRIEVAL_MODE=hybrid
KNOWLEDGE_VECTOR_MIN_SIMILARITY=0.85
```

调用 TokenHub `/embeddings/multimodal`，每次提交一个文本块，返回一个融合向量。不能将多篇文档放在同一 input 中当作独立 batch。按 Unicode 字符每 1800 字切块，各块归一化向量求和后再次归一化为页面向量，与 DKE 的页面聚合方式一致。

## 生命周期及隔离

- 向量构建、模型网络请求和全量向量相似度计算都在独立 worker 中进行。全局只运行一个 Wiki 构建，每个构建最多 4 个模型请求（可配置 1–8）。查询最多 4 个 worker，排队过多时直接回退。
- 同一 Wiki 的只读请求允许并行，写入仍互斥并等待已有读取完成；排队的写入优先于后来的读取，避免批量审核请求被逐条串行处理。向量查询含排队在内最多等待 5 秒。
- BM25 的同一事务发布全文内容指纹。向量构建验证磁盘快照和指纹相同，再原子发布完整页面映射；模型失败保留缓存和旧映射，不改变 Wiki 的 ready/failed 状态。
- 向量索引按服务目录、Wiki、端点、模型、维度、分块版本隔离，位于 Wiki 的 `.hybrid/`。正文内容哈希用于复用未变化页面。删除及更新后，指纹不一致的旧向量不能参与查询。
- 查询仅计算查询向量，先保留余弦相似度 ≥ 0.85 的向量候选，再与 BM25 用 RRF 融合，再沿用原有图扩展、正文路径、摘要和读取方式。
- 模型不可用、超过查询时间预算、向量索引缺失或落后时返回 BM25，客户端不需要处理向量服务错误。状态及日志可以区分回退和真正的混合检索。
- 本次没有引入 reranker，也没有改变审核模型或规则。向量检索不保证最终审核准确率提高，仍须用人工标注案例验证召回和审核结果。

## 验证及诊断

```json
{"wiki_id":"wiki-ctrs7572","query":"待审内容或知识问题","limit":8}
```

默认模式由 `KNOWLEDGE_RETRIEVAL_MODE` 指定。原生 search 请求可临时加 `"retrieval":"bm25"` 或 `"retrieval":"hybrid"` 进行同查询对比。混合模式响应额外包含：

```json
{"retrieval":{"mode":"hybrid","model":"kinfra-vl-embedding-8b","revision":"内容指纹","min_similarity":0.85}}
```

向量阈值可通过 `KNOWLEDGE_VECTOR_MIN_SIMILARITY` 配置为 0–1，默认 0.85（包含边界）。它只作用于向量候选，不对 BM25 候选或图扩展结果做相似度过滤；返回的融合 score 也不是余弦相似度。没有合格向量候选时仍返回 BM25，标记 `fallback_reason=below_similarity_threshold`。阈值变化不改变索引版本，无需重新生成向量。

响应 `retrieval.min_similarity` 和 vector/status 的 `min_similarity` 显示实际阈值。实际回退时 mode 为 `bm25`，带 `fallback_reason`。`POST /v3/wiki/vector/status`，body 为 `{"wiki_id":"..."}`，返回当前模型、ready、building、已发布页数和缓存页数；仍需 `X-Tdai-Service-Id`，先验证 Wiki 归属。ready=false 时不能宣称该库已使用向量。

首次上线会在后台依次索引现有 Wiki，较小库先完成；期间该库查询使用 BM25。页面写入/删除及 ingest 成功后自动增量更新向量。模型配置在重启后生效；`KNOWLEDGE_RETRIEVAL_MODE=bm25` 可回退全文检索，向量文件不影响正文和原始材料。

## 验证范围

自动测试覆盖：无词面重合的语义命中、REST 返回兼容、显式 BM25 对照、租户隔离、模型失败回退、失败不改变库状态、删除不使用旧向量、未变页面缓存复用、主线程响应及协议/维度校验。上线前在独立数据副本核对旧检索结果，使用真实 TokenHub 模型验证查询及向量维度；不将测试资料写入正式 Wiki。

接口参考：https://cloud.tencent.com/document/product/1823/133515
