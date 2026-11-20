# Wiki 统一混合检索

所有 Wiki 默认 BM25 与向量双路召回，使用 RRF 融合排序。原生 `/v3/wiki/search`、`/v3/tools/call` 的 search 和转发这些 HTTP 接口的 MCP 工具使用同一策略。

| 类型 | 向量输入 | 过滤及降级 |
| --- | --- | --- |
| 普通知识库及新 Wiki | 标题 + 全页 Markdown，每 1800 Unicode 字符分块聚合 | 默认无 0.85 硬门槛；模型或索引不可用时回退 BM25 |
| 资料文本判例库 | “规则正文”中的资料文本判例原文 | 两路候选均逐条要求 cosine ≥ 0.85；无命中返回空；故障 503 |
| 动态文本判例库 | “规则正文”中的动态文本判例原文 | 同上 |

原文位置、每条 similarity、错误处理和完整示例见 [case-retrieval-contract.md](case-retrieval-contract.md)。

## 配置

```dotenv
KNOWLEDGE_EMBEDDING_ENABLED=true
KNOWLEDGE_EMBEDDING_PROVIDER=tokenhub
KNOWLEDGE_EMBEDDING_BASE_URL=https://tokenhub.tencentmaas.com/v1
KNOWLEDGE_EMBEDDING_MODEL=kinfra-vl-embedding-8b
KNOWLEDGE_EMBEDDING_API_KEY=<受保护的环境变量>
KNOWLEDGE_EMBEDDING_CONCURRENCY=4
KNOWLEDGE_RETRIEVAL_MODE=hybrid
KNOWLEDGE_VECTOR_MIN_SIMILARITY=0
KNOWLEDGE_WIKI_RETRIEVAL_POLICIES={"wiki-ctrs7572":{"mode":"case","min_similarity":0.85},"wiki-j2g1em91":{"mode":"case","min_similarity":0.85,"case_prefix":"动态文本质检判例：「"}}
```

`mode: case` 是严格判例混合策略。普通库没有逐库锁定时可通过请求 `retrieval: bm25` 进行对照，不能用此参数绕过判例门槛。显式逐库策略始终优先。

TokenHub 请求为 `/embeddings/multimodal`，每次只提交一个文本，4096 维。整页模式按 1800 字符分块，归一化向量求和后再次归一化；判例模式直接向量化原文。前缀、输入方式、端点、模型、维度参与索引隔离；融合方式变化不需要重新生成已有向量。

## 候选与分数

普通库沿用 BM25 + 向量 RRF 和可选图扩展。判例库先召回 BM25 候选和向量前若干名，并计算所有 BM25 候选的原文相似度，丢掉低于门槛及无原文向量者，再融合两路的合格结果。每路从 0 开始的 rank 贡献 `61 / (61 + rank)`，双路首位的融合分为 2。

`score` 是融合分；判例的 `similarity` 是余弦相似度。请用 similarity 核对 0.85，不要用 score。判例响应为 `retrieval.mode: hybrid, strict_similarity: true`，仍有 `min_similarity: 0.85` 和 `input_mode: case_original`。空结果带 `empty_reason: below_similarity_threshold`，无 BM25 兜底。普通库回退时 `mode: bm25` 且带 `fallback_reason`。

## 生命周期与隔离

向量构建、网络调用和全量相似度计算在 worker 中。全局一个构建，每个构建最多 4 个并发模型请求；普通查询和判例查询各有独立的 4 个 worker 槽位及队列，防止普通库新增向量流量挤占判例查询；每类最多排队 8 个，含排队最多等待 5 秒。只读并行，排队写入优先于后来的读。

页面写入、删除及 ingest 后自动增量更新。全文索引和向量映射核对内容指纹，未变原文复用向量；索引落后时不使用过期映射。判例未就绪返回 503；普通库可降级 BM25。

`POST /v3/wiki/vector/status` 可查看模型、ready、building、页数、revision、retrieval_mode 和判例前缀。配置 hybrid 并不等于实际使用了向量，以 ready 和每次查询响应为准。

验证覆盖候选在向量 top-K 之外仍能参与融合、强关键词命中但低于余弦门槛被排除、0.85 边界、模型失败、索引更新与删除、缓存复用、前缀隔离及查询不阻塞事件循环。真实查询验证不等同于标注集审核精度验收。
