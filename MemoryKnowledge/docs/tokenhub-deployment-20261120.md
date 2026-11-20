# TokenHub 混合检索上线记录（2026-11-20）

- 服务：`http://172.19.40.22:8424`，Panel 仍为 `8125`；Router、MemoryCore、Proxy 没有修改。
- 运行代码：`1a6b58d`，镜像 `sha256:40ce5da2e8cdbb188fc240e61cf4ef096777ea49da685c9ca82618b2b68889ea`。
- 最终切换：北京时间 12:47:05–12:47:13。校验了 68 个运行源码文件与 Git 一致。
- 模型：复用 DKE 配置的 TokenHub `kinfra-vl-embedding-8b`，4096 维，使用多模态接口处理纯文本。密钥不进入仓库。
- 本机和生产依赖镜像 14 项测试、typecheck 通过。独立生产数据副本 61 项旧检索/正文一致性检查通过；批量写入期间 166 次查询、读取、健康检查采样无错误。
- 原生 search 与 tools/call 在生产环境已实际返回 `retrieval.mode=hybrid`。8 并发真实查询验证通过；未执行人工标注审核集验收，不代表最终审核准确率已验证提高。
- 首次索引异步生成；是否真正参与语义召回应以每次响应的 `retrieval.mode` 和 `/v3/wiki/vector/status` 的 `ready` 为准。不可只看配置已开启。
- 发现并修复了文档切块后仅剩换行导致 TokenHub 返回 400 的问题，并添加回归测试。
- 线上 17,656 个受保护正文/材料文件哈希在切换前后一致。向量及全文派生索引独立保存，没有改写正文。
- 稳定旧版回滚容器：`tdai-memory-hub-before-tokenhub-20261120`，已停止并禁用自动重启。回滚时必须先停止新容器，不能同时运行两个写入同一数据卷的服务。
- 私有部署配置、元数据库备份及验证报告保存在服务器 `/Users/momo/apps/memoryhub-tokenhub-fixed-20261120`。上一轮构建和副本验证记录在 `/Users/momo/apps/memoryhub-tokenhub-20261120`。文件包含运行配置，不公开上传。

接入和故障回退说明见 [tokenhub-hybrid-retrieval.md](tokenhub-hybrid-retrieval.md)。
