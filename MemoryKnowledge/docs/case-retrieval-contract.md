# BPO 判例检索接入与六项问题说明

## 旧版本的问题

原实现向量化的文本是 `页面标题 + 换行 + 整页 Markdown`，按 Unicode 字符每 1800 字切块，各块向量归一化后求和并再次归一化。不是只向量化标题，也不是只截取前若干字。判例说明、质检结论和快照元数据可能稀释十几个字的判例原文。

原全局 0.85 门槛只过滤向量候选，然后与 BM25 候选做 RRF 排序；BM25 候选和图扩展结果没有逐条过门槛。因此即使进入 hybrid 模式，也可能返回不相似的判例；向量无命中时还会回退 BM25。`score` 是融合分，不是余弦相似度。原来正式库也返回 `min_similarity: 0.85` 是全局配置的结果，这不代表该排序变化已完成业务验证。

## 调整后的范围

| Wiki | 方式 | 不足门槛时 |
| --- | --- | --- |
| 判例库 `wiki-ctrs7572` | 仅原文向量，逐条余弦相似度 ≥ 0.85，按相似度降序 | 返回空，禁止 BM25 和图扩展补齐 |
| 正式审核库 `wiki-zz5wwtdt` | 恢复原 BM25 | 保持原行为 |
| 通用审核、客服、DKE staging 库 | 恢复原 BM25 | 保持原行为 |

正式库恢复 BM25 后，待标注集验证再单独启用混合检索。服务端明确指定的逐库策略优先于请求中的 `retrieval`，调用方不能用 `retrieval: bm25` 绕过判例门槛，也不能用 `retrieval: hybrid` 改变已锁定的正式库排序。判例库忽略图扩展的 `hop`、`decay`、`minScore`；`limit` 是最多返回多少条，不会为了补足数量降低门槛。

## 原文的准确位置：不改页面格式

当前页面从 `## 规则正文` 到下一 `##` 标题之间取正文，匹配开头 `资料文本质检判例：「`，取它与该段末尾 `」，质检结论：` 之间的文本：

```markdown
## 规则正文

资料文本质检判例：「越域情深²⁰²⁶₇₇₅₃」，质检结论：高风险。后面仍可保留说明。
```

向量输入只会是 `越域情深²⁰²⁶₇₇₅₃`。不使用约 60 字后被截断的页面标题，不嵌入质检结论、标签、条件或完整记录。仅去掉原文首尾空白，保留内部换行、标点、Unicode 上下标。原文一次提交给同一模型，不做整页切块平均。

2026-11-20 对线上 3,566 个 Markdown 页面逐页检查：3,563 个判例均可提取，且与各页“完整知识记录”的原文完全一致；最长原文 214 字；只有 `schema.md`、`purpose.md`、`index.md` 三个结构页被排除。

若将来需要指定字段，可在现有 YAML frontmatter 加字符串 `retrieval_text`，正文格式不变：

```yaml
---
type: source
title: 任意展示标题
retrieval_text: "完整、未截断的判例原文"
---
```

`retrieval_text` 一旦存在即优先使用；空值、非字符串不回退到标题或其他正文。没有此字段时仍按上述“规则正文”位置提取。无法提取的页面不会参与判例向量检索，状态接口的 `excluded_pages` 可发现异常增加。当前不需要批量补字段。

## 比较的两个向量和 0.85 的位置

查询原文 `q` 和每个判例原文 `cᵢ` 分别经过 TokenHub `kinfra-vl-embedding-8b` 得到 4096 维向量。两者做 L2 归一化后计算点积，即余弦相似度：

```text
similarityᵢ = dot(E(q), E(cᵢ)) / (norm(E(q)) × norm(E(cᵢ)))
```

逐条去掉 `similarityᵢ < 0.85`，对剩余结果排序后取前 limit 条。每条结果带 `similarity`，在本库 `score` 同样为余弦相似度；不是查询向量与标题、说明或质检结论算相似度。向量存储为 Float32，会有浮点误差，展示接近 1 即可，不应要求字符串恰为 `1`。

## 调用方法与返回契约

入口不变，后台任务无需客户端或终端标识。请求头保留业务服务标识及部署要求的认证。

```bash
curl -sS 'http://172.19.40.22:8424/v3/wiki/search' \
  -H 'Content-Type: application/json' \
  -H 'X-Tdai-Service-Id: default' \
  -d '{"wiki_id":"wiki-ctrs7572","query":"待审核的原文","limit":8}'
```

示意返回（数字仅说明结构，实测值以接口为准）：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "results": [{
      "path": "wiki/sources/某判例.md",
      "title": "原页面标题",
      "snippet": "页面摘要",
      "type": "source",
      "score": 0.92,
      "similarity": 0.92,
      "hop": 0,
      "related": []
    }],
    "links": [],
    "count": 1,
    "retrieval": {
      "mode": "case_vector",
      "model": "kinfra-vl-embedding-8b",
      "revision": "当前页面版本指纹",
      "min_similarity": 0.85,
      "input_mode": "case_original"
    }
  }
}
```

`POST /v3/tools/call` 的 `search` 工具使用相同策略和结果：

```json
{"knowledge_id":"wiki-ctrs7572","tool_name":"search","params":{"query":"待审核的原文","limit":8}}
```

需要完整质检结论时用命中的 `path` 调用 `/v3/wiki/page/read`，正文和材料保持原样。不要把多个判例拼成一条查询；查询应是待审核的原文，避免加入审核提示词和模板。

没有合格判例时 HTTP 200，`results: []`、`count: 0`、`links: []`，`retrieval.empty_reason: below_similarity_threshold`。没有 `fallback_reason`，也没有关键词兜底。调用方应继续自己的审核流程，不把“无相似判例”当作网络错误，也不能把它等同于“内容正常”。

模型不可用、超时、查询过载、向量索引缺失或版本落后时 HTTP 503，message 形如 `case_vector_unavailable: timeout` / `index_stale` / `vector_unavailable`。这是服务失败，不能当作“无相似判例”；由调用方按业务重试或错误处理。判例库首次索引完成前也是不可用，不回退关键词。

`POST /v3/wiki/vector/status`，body `{"wiki_id":"wiki-ctrs7572"}`，可查看 `ready`、`building`、`pages`、`excluded_pages`、`input_mode`、`min_similarity`、`retrieval_mode`。BM25 库返回 `enabled: false, retrieval_mode: bm25`，不会暴露一个正在生效的 0.85 向量门槛。

若 BPO 缓存过旧结果，应清缓存或等原 TTL 过去，再比较新接口响应；MemoryHub 此次没有新增查询结果缓存。检索门槛只保证向量相关性，不代表最终审核精度已通过标注集验收。
