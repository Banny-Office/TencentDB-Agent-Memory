# 动态文本判例库恢复记录（2026-11-20）

对象：`wiki-j2g1em91`，Team `team-5x9sbd20oi`。

## 原因

北京时间 15:05:20，唯一源文件 `README.md` 的 LLM 抽取失败，错误为 `AI_NoOutputGeneratedError: No output generated. Check the stream for errors.`，整个库进入 failed。15:08 重试仍失败。此时磁盘只有 172 字节的建库说明和 3 个结构页，没有实际判例页。

当前服务未配置 default LLM binding，使用全局 custom 配置；从服务容器直连该模型地址的诊断请求连接失败。本次恢复没有修复或切换全局模型配置，不能据此宣称原始材料的模型抽取链路已恢复。

## 恢复方法

1. 备份目标库文件及原状态。
2. 将 README 原文完整、逐字保存为 `wiki/sources/library-readme.md`，声明 `sources: ["README.md"]`、`import_method: verbatim`，通过正常 page/write 接口建立索引。
3. 核对页面完整包含原始 README，源 SHA256 与 source 记录一致，且 page_meta 已登记；然后仅将该源登记为已完成原文导入，清除其抽取错误。维护记录保存原 source 行与页面哈希，不是单纯将整库状态强改为 ready。
4. 再调用正常 ingest。未变 README 被增量流程跳过，重建索引后由正常状态机写入 ready、page_count、last_sync_at，产生相应审计和完成回调。

## 验证及边界

北京时间 15:10:58 恢复 ready，版本 3，sync_error=null，page_count=4。实际为 3 个结构页及 1 个说明页，不能理解为 4 条判例。

原生 search 查询“动态文本”可命中说明页，page/read 可完整读取。该新库采用默认 BM25；未自动启用 `wiki-ctrs7572` 的原文向量和 0.85 策略。可以继续通过 page/write 写入 DKE 已加工页面；后续若再次使用原始材料的 LLM 自动抽取，仍依赖上游模型连接可用。

没有修改 Router、其他知识库或运行镜像。私有备份和验证记录位于服务主机 `/Users/momo/apps/memoryhub-wiki-j2g1em91-recovery-20261120`。
