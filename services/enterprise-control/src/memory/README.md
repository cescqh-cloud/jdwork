# 记忆中心与企业知识库

控制台提供 [记忆中心](/console/memories) 和 [企业知识库](/console/knowledge)。记忆保存可复用的短事实。知识登记保存来源、正文和引用版本，发布后才可检索。

## 范围和发布

| 范围 | 可见账号 | 发布权限 |
| --- | --- | --- |
| `user_private` | 记忆所有者 | 所有者 |
| `project_private` | 当前有效项目的成员 | 同项目的项目负责人、信息中心负责人或管理员 |
| `team_shared` | 当前同部门成员 | 同部门的信息中心负责人或管理员 |
| `enterprise_reference` | 当前租户的成员 | 可维护该条知识的 Web 管理员 |

候选只对作者和当前范围内的审核者可见。共享记忆修改后回到候选，审核通过后重新进入检索和同步。个人记忆启用后的修改直接生效。只有作者能看到候选关联的本地会话和消息标识。

Web 管理员可在已授权的企业、项目和部门范围登记知识。项目负责人、信息中心负责人和管理员可维护本人所属项目的知识。一次登记的正文最多 3500 字，可以按文档章节录入。编辑已发布知识会撤回旧内容，发布新修订后才重新可见。来源可以是名称和 HTTPS 链接。服务端根据正文生成校验值，链接作为出处展示。

在「企业知识库」选择项目和信息等级，再多选 UTF-8 Markdown 或 TXT 文件。每批最多 8 份，每份正文最多 3500 字，上传请求限 96 KiB。导入结果为待发布，项目成员在发布后可检索。原文件名、格式、行数、原始字节的 SHA-256 和导入时间跟随知识修订。项目范围固定，编辑来源名称也会保留原文件信息。

同一项目内重复导入同名、同内容、同信息等级的资料会复用已有条目。同名内容或信息等级不同、格式不支持或出现无效文件时，整批退回。请在维护页核对原条目及修订后再提交。

## 客户端接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/memories/scopes` | 当前用户可选的 `projects: [{id,name}]` 与 `department: {id,name}\|null` |
| `POST /api/v1/memories/candidates` | 创建候选。提交 `scope`、`body`、相应的 `projectId` 或 `departmentId`，可附 `sourceRef`、`expiresAt` 和 `classification` |
| `GET /api/v1/memories/candidates` | 列出自己的候选及有权审核的共享候选 |
| `GET /api/v1/memories/:id` | 查看当前授权的记忆 |
| `PATCH /api/v1/memories/:id` | 修改正文、来源标识、信息等级或到期时间 |
| `POST /api/v1/memories/:id/publish` | 启用个人候选或审核发布共享候选 |
| `DELETE /api/v1/memories/:id` | 删除当前记录并同步墓碑 |
| `POST /api/v1/memories/search` | 检索当前授权的已生效记忆 |
| `GET /api/v1/memories/changes?cursor=0` | 拉取授权记忆及知识摘要的同步变更 |
| `POST /api/v1/knowledge/search` | 检索当前授权的已发布知识 |
| `GET /api/v1/knowledge/:id?revision=3` | 打开指定版本的引用。授权仍有效且引用过期时返回 410 |
| `GET /api/v1/admin/knowledge` | Web 管理员和项目发布者列出有权维护的知识 |
| `POST /api/v1/admin/knowledge` | Web 管理员手工登记有权维护的知识 |
| `POST /api/v1/admin/knowledge/import` | 有发布权限的项目成员上传 `multipart/form-data`，包含 `projectId`、可选 `classification` 和多项 `files`。返回 `items: [{created, document}]` |
| `GET/PATCH/DELETE /api/v1/admin/knowledge/:id` | 查看草稿、编辑或删除 |
| `POST /api/v1/admin/knowledge/:id/publish` | 发布知识草稿 |

单条记录返回 `ETag`。修改、发布、删除时以同值传 `If-Match`。过期修订返回 409，响应附有 `current` 和 `submitted`，便于保留本次修改。创建候选可提交 UUID 格式的 `Idempotency-Key`。

桌面端遇到个人记忆的编辑冲突时，会重新读取当前授权的云端正文，与本机编辑稿并排显示。用户可选一份作为底稿并手工修订，提交时使用已核对的云端修订号。再次冲突时保留本机原稿和手工稿，待用户核对新修订后再保存。比较内容保留在当前页面。收到删除或权限撤销后清除。

检索参数为 `query`，可附 `scope`、项目或部门 ID 及 `limit`。服务端先确定授权记录，再用 PostgreSQL 全文匹配和中文术语子串排序。结果包含 `strategy`、`matchedTerms` 和相关度 `score`，记忆另有最近审核时间。知识返回来源、摘要和含修订与 SHA-256 的 `citation`。`indexRevision` 表示当前可检索的发布修订，分词和排序在查询时计算。模型调用可以由服务端额外限定信息等级及所选模型的项目范围。 [PostgreSQL 全文检索](https://www.postgresql.org/docs/16/textsearch-controls.html)

## 增量同步与缓存

每台客户端按控制台地址、租户和账号分别保存 `cursor`。新设备从 0 开始读取，按页处理到 `hasMore=false`。同账号其他设备独立重放，不会消耗彼此的变更。按 `sequence` 应用事件。重新授权可以用原修订生成更新的 `upsert`。

只有已进入授权同步集合的记录会向该账号生成墓碑。每条 `tombstone` 只给资源类型、编号、原缓存修订、原因和时间。项目移除或停用、部门调动、记录删除或撤回会在数据库事务内生成相应事件。到期记录立即退出检索，首次后续同步持久化到期墓碑。

收到墓碑应清除对应缓存。缓存有效期取同步响应的 `cacheExpiresAt` 与记录 `expiresAt` 中较早者。在成功应用完整一轮变更后更新缓存租约。鉴权失败、切换组织或账号时清理相应的企业缓存。搜索结果只供当次使用。公开模型调用仍须通过所选模型及数据分类的授权。

当前通过显式提交产生候选。保存前应脱敏并只提交需要保留的事实，服务端会拦截常见凭据和个人敏感字段。软删除清除当前正文，修订审计和墓碑保留在控制服务。

## 本机验证

使用 [集成测试说明](../../test/README.md) 中的隔离 PostgreSQL。记忆集成测试覆盖 SQL 权限、表单、搜索、修订冲突、真实墓碑和历史重放，以及批量导入、重试去重、整批回滚和草稿发布。

```powershell
bun --no-env-file test test/memory.integration.test.ts
```
