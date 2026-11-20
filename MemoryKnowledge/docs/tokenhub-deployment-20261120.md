# TokenHub 混合检索上线记录（2026-11-20）

- 服务：`http://172.19.40.22:8424`，Panel 仍为 `8125`；Router、MemoryCore、Proxy 没有修改。
- 运行代码：`1a6b58d`，镜像 `sha256:40ce5da2e8cdbb188fc240e61cf4ef096777ea49da685c9ca82618b2b68889ea`。
- 最终切换：北京时间 12:47:05–12:47:13。校验了 68 个运行源码文件与 Git 一致。
- 模型：复用 DKE 配置的 TokenHub `kinfra-vl-embedding-8b`，4096 维，使用多模态接口处理纯文本。密钥不进入仓库。
- 本机和生产依赖镜像 14 项测试、typecheck 通过。独立生产数据副本 61 项旧检索/正文一致性检查通过；批量写入期间 166 次查询、读取、健康检查采样无错误。
- 原生 search 与 tools/call 在生产环境已实际返回 `retrieval.mode=hybrid`。8 并发真实查询验证通过；未执行人工标注审核集验收，不代表最终审核准确率已验证提高。
- 首次索引异步生成；是否真正参与语义召回应以每次响应的 `retrieval.mode` 和 `/v3/wiki/vector/status` 的 `ready` 为准。不可只看配置已开启。
- 上线验收时通用审核标准库 10 页、正式审核库 792 页、资料文本判例库 `wiki-ctrs7572` 3,566 页均 ready；这三个库均已验证原接口默认返回 hybrid 并可读取所命中的正文。客服库与 DKE staging 库继续后台生成首次索引，就绪前回退 BM25。
- 发现并修复了文档切块后仅剩换行导致 TokenHub 返回 400 的问题，并添加回归测试。
- 线上 17,656 个受保护正文/材料文件哈希在切换前后一致。向量及全文派生索引独立保存，没有改写正文。
- 稳定旧版回滚容器：`tdai-memory-hub-before-tokenhub-20261120`，已停止并禁用自动重启。回滚时必须先停止新容器，不能同时运行两个写入同一数据卷的服务。
- 私有部署配置、元数据库备份及验证报告保存在服务器 `/Users/momo/apps/memoryhub-tokenhub-fixed-20261120`。上一轮构建和副本验证记录在 `/Users/momo/apps/memoryhub-tokenhub-20261120`。文件包含运行配置，不公开上传。

接入和故障回退说明见 [tokenhub-hybrid-retrieval.md](tokenhub-hybrid-retrieval.md)。

## 向量阈值调整（13:12）

运行代码更新为 `bc92586`，镜像 `sha256:7ad94d1c9e1d65bc38c312d24a055d16a8a9953af0edce017a2f3747bbc77c91`。设置 `KNOWLEDGE_VECTOR_MIN_SIMILARITY=0.85`：先过滤余弦相似度低于 0.85 的向量候选，再融合 BM25。阈值含等号，不对 BM25 候选及图扩展结果施加该阈值。响应和 vector/status 暴露 `min_similarity`，无合格向量候选时说明 `below_similarity_threshold`。索引版本及缓存无需改变。

15 项测试和 typecheck 通过，包括低于 0.85 被排除、边界 0.85 被保留及阈值变更复用缓存。独立副本验证 4 项 BM25 对照、3 项真实模型混合查询；线上切换后 61 项 BM25/正文对照及正文文件哈希一致。回滚容器为 `tdai-memory-hub-before-threshold085-20261120`；本次私有部署记录保存在 `/Users/momo/apps/memoryhub-threshold085-20261120`。
