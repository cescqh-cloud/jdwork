# 需求审查与开发交付

从控制台的「开发交付」进入。信息中心负责人可将当前已通过核对的需求版本分配给有效项目成员。任务保存批准版本和快照校验值。需求改版、审批状态变化或实施人失去项目资格时，原任务保留历史并停止推进。

## 实施流程

1. 在「开发交付」选取待分配需求，再选择项目和实施人。
2. 实施人在已绑定的客户端提交工作树标识、会话标识和 Git 修订，开始开发。
3. 从该设备选择并提交当前授权材料。服务端冻结文件清单、输入校验值和规则版本，客户端重新核对工作树后生效。
4. 同项目内的独立负责人核对报告。阻断项需整改后重检。警告项需明确人工确认。
5. 进入测试，由独立验证人登记实际结果。登记通过须附证据名称及 SHA-256 校验值。失败、跳过、阻塞和未运行分别记录。
6. 需求发起人在「待业务验收」确认交付参考，或填写原因退回整改。整改后重新提交材料并复审。

审批、开发、复审、测试和验收的历史均保留。工作台记录交付参考。正式发版、系统写入及生产变更沿用各自授权流程。

## 文件与检查

材料用工作树中的相对路径和文本提交。每次最多 8 个文件，检查请求最多 12 KiB。服务端保存文件校验值和脱敏文本。检查报告提供规则编号、结论、定位、修复说明、输入校验值和时间。

```markdown
---
id: REQ-2026-0001
title: 示例需求
kind: report
acceptanceCriteria:
  - 测试数据与验收样例的汇总值一致
---
在已授权的测试材料上核对统计口径。
```

编号、标题和验收标准与冻结需求核对。供应商准入材料需要声明 `approvalAmountThreshold`。疑似凭据和敏感字段会遮盖并阻断。可能变更数据或结构的 SQL 需要声明测试环境、影响行数和回滚计划，并由独立审核人核对。当前检查为静态文本筛查。 [Bun YAML](https://bun.sh/docs/runtime/yaml)

相对文件引用与本次提交清单核对。知识引用提供 `documentId`、`revision` 和 `checksum`，只有当前可读且已发布的版本通过。外部链接提示人工核对。引用失效或材料更新后，旧结果不能用于通过测试或验收。

桌面端可手动核验或复查上次选中的材料。开启自动复查后，文件变化会触发核对，同一份材料不会重复提交。每次检查比较提交前后的文件校验值。发现材料变更或 Git 合并冲突时，服务端保留历史报告并标为失效。处于测试或待验收的任务退回开发，修正后需独立复审。整改入口复用同一工作树上的本地整改会话，保留已有草稿。

自动复查仅处理经当前设备签名确认的文件选择，退出或重新绑定后需重新开启。普通核验只发送摘要。重新检查发送此前明确选中的文本，检查规则在服务端运行。网页复审、测试和验收依赖最近 60 秒内的绑定设备核验。客户端离线时服务端只能依据最近一次核验，收到材料变更通知、设备被撤销或核验到期后会拒绝推进。桌面端进入测试前会重新读取文件并在线核验。旧客户端报告仍可查看，推进前须在当前客户端重新选取材料并完成检查。

## 服务接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/deliveries/assignment-options?demandId=...` | 信息中心负责人获取当前批准版本和可分配成员 |
| `POST /api/v1/demands/:id/assign` | 提交 `approvedVersionId`、`expectedDemandRevision`、`projectId`、`assigneeId` |
| `GET /api/v1/deliveries?demandId=...` | 查看授权任务 |
| `GET /api/v1/deliveries/:id` | 任务详情、进度、修订和当前账号的操作权限 |
| `POST /api/v1/deliveries/:id/bind` | 设备提交 `worktreeId`、`sessionId`、40 或 64 位 Git 修订 `gitRevision` |
| `POST /api/v1/deliveries/:id/checks` | 设备提交 `files: [{path,text}]`、签名的 `selectionReceipt` 和可选 `knowledgeRefs`，返回 `{task,run}` |
| `GET /api/v1/deliveries/:id/checks/:runId` | 同项目成员查看规则结果、失效标记及独立复审结论 |
| `POST /api/v1/deliveries/:id/materials` | 绑定设备提交 `runId` 和 `checksum`，发现文件缺失或读取冲突时可传空摘要，返回任务最新状态 |
| `POST /api/v1/deliveries/:id/reviews` | 独立复审者提交 `runId`、`decision`、`note`，有警告时附 `acknowledgeWarnings` |
| `POST /api/v1/deliveries/:id/transition` | 按当前权限推进阶段 |

任务变更提交强 ETag，例如 `If-Match: "3"`。旧修订返回 409。检查可用 UUID 格式的 `Idempotency-Key` 重试。阶段动作包括 `start`、`start_testing`、`record_test`、`return_for_rework` 和 `accept`。 `record_test` 包含 `outcome`、`note` 及可选 `evidence: [{label,sha256}]`。验收包含 `deliveryRef` 和 `note`。

工作树和会话标识保留为引用。审批发起人可看业务进度与验收页。检查报告、文件定位及会话信息限当前项目成员。业务事件用于刷新状态。

## 本机验证

使用隔离 PostgreSQL 和合成审批、用户及项目数据。

```powershell
bun --no-env-file test test/delivery.test.ts test/delivery.integration.test.ts
```
