# 力源金蝶研发工作台控制服务

控制服务为力源金蝶研发工作台提供企业身份、设备登记、模型与用量、需求和钉钉审批、知识与记忆、开发交付及客户端签名更新。客户端沿用 cc-haha 的 Bun sidecar 和 CLI 处理会话及工具调用。

## 本机运行

准备 Bun 1.4.3、PostgreSQL 16+ 和 Redis 7+。可用本目录的 `compose.dev.yaml` 启动独立测试实例。容器只对本机开放端口，并使用临时数据目录。测试步骤见 [集成测试说明](test/README.md)。

| 环境变量 | 用途 |
| --- | --- |
| `ENTERPRISE_DATABASE_URL` | 控制服务的 PostgreSQL 连接串 |
| `ENTERPRISE_REDIS_URL` | Redis 连接串，用于登录防重放、开发登录节流和同步提示 |
| `ENTERPRISE_HOST` / `ENTERPRISE_PORT` | 监听地址和端口，默认 `127.0.0.1:8787` |
| `ENTERPRISE_ORIGIN` | 控制台对用户公布的源地址。办公环境使用企业 HTTPS 域名，本机验收可用回环 HTTP |
| `ENTERPRISE_LOCAL_LOGIN` | 本机模拟环境设为 `true` 可用密码登录，默认关闭 |

在本目录执行以下命令。用进程环境注入配置，密钥由部署环境单独管理。

```powershell
bun --no-env-file install --frozen-lockfile --ignore-scripts
bun --no-env-file run migrate
bun --no-env-file run start
```

本机密码账号使用 `bun --no-env-file run create-user <组织代码> <组织名> <账号> <显示名> <角色>`，从标准输入提供一次性开发密码。企业 SSO 账号在同一命令的组织代码前加 `--sso`，账号只创建内部身份和角色。按 [企业统一登录说明](src/identity/README.md) 绑定企业身份服务签发的 `sub` 后登录。

`/healthz` 检查数据库和 Redis。`/openapi.json` 描述 REST 接口与请求结构。同步 WebSocket 位于 `/api/v1/sync/ws`，以设备令牌认证，仅通知客户端查询增量事件。PostgreSQL 中的事件游标支持断线重放。

## 与现有 Pi 工作台使用同一内网账号

经部署人员显式启用后，控制台可以通过公司内网固定地址验证原 Pi 工作台账号。原工作台 `/api/me` 必须返回经过身份验证的 `identity`（若返回 `authState.instanceId` 则同时绑定进程实例）。应用身份发生变更或原工作台不可用时，新请求和设备续期会被拒绝。

| 环境变量 | 用途 |
| --- | --- |
| `ENTERPRISE_INTRANET_ORIGIN` | 控制台的固定私有 IPv4 HTTP 源，例如 `http://192.168.254.203:8787` |
| `ENTERPRISE_HOST` 和 `ENTERPRISE_PORT` | 必须与上述地址中的 IP 和端口一致 |
| `ENTERPRISE_PI_AUTH_ORIGIN` | 同一台服务器的 Pi 工作台源，例如 `http://192.168.254.203:8080` |
| `ENTERPRISE_PI_TENANT` | 企业控制服务中的组织代码 |
| `ENTERPRISE_PI_AUTH_ENCRYPTION_KEY` | 32 字节随机数据的 base64url 编码，保存在服务端私有配置中 |

执行数据库迁移后，部署管理员从标准输入提供已验证的原工作台管理员口令，运行以下命令完成首次授权。已存在账户的角色不会因为绑定而被修改。如果组织中已有其他账号，须先建立具有管理员角色的目标账号再绑定。

```bash
bun --no-env-file run src/pi-admin.ts '力源' 'admin' '系统管理员'
```

之后在控制台使用原工作台管理员口令登录。钉钉员工先在同一主机的 Pi 工作台登录，再到控制台选择原工作台钉钉账号。普通员工需由管理员预先建立企业账户，并按其已验证的 Pi `identity.id` 绑定身份。控制台与 Pi 的 HTTP 流量包含登录凭据和会话令牌，只用于明确选定的办公网环境。

已建账号可通过以下命令绑定原工作台身份，命令同样从标准输入读取并校验原管理员口令。登录名和员工身份必须由管理员核对，绑定不会更改该账号的角色。

```bash
bun --no-env-file run src/pi-bind.ts 'employee-login' 'dingtalk:corp-id:user-id'
```

## 绑定桌面设备

登录控制台后选择「生成桌面绑定码」。在桌面客户端「设置 → 通用 → 企业连接」填写控制台地址和绑定码。绑定码有效期为 5 分钟，设备公钥和设备身份由客户端生成。平台管理员可以在控制台撤销某台设备，设备的同步和新的模型调用会立即被拒绝。

## 模型中心

设置 `ENTERPRISE_MODEL_ENCRYPTION_KEY` 为 32 字节随机数据的 base64url 编码，并用 `ENTERPRISE_MODEL_UPSTREAMS` 列出服务器允许连接的 API 基础地址，多个地址用逗号分隔。基础地址包含供应商要求的路径，例如 `/v1`。凭据使用服务端密钥加密存入数据库。变更基础地址或认证方式时重新填写供应商密钥。

平台管理员可以在 `/console/models` 配置供应商、模型能力、角色、项目范围、每日 Token 额度和默认模型。项目模型同时受成员权限和项目数据分类约束。桌面端收到策略变更后刷新菜单。个人模型走原来的本地配置，企业模型通过控制服务取得最长 120 秒的授权后调用。每个新请求重新检查设备、模型、角色和项目权限。

支持 Anthropic Messages、输入 Token 估算和 OpenAI Chat Completions。成功的 JSON 或 SSE 保留供应商的工具、推理与用量字段。供应商的 HTTP 错误保留可安全转发的状态与 `Retry-After`。 [Anthropic 流式协议](https://platform.claude.com/docs/en/build-with-claude/streaming) · [OpenAI Chat 协议](https://developers.openai.com/api/reference/resources/chat)

用量按 UTC 日期、组织、部门、用户、项目、设备、模型及场景归集。每日硬额度按用户和模型计算，请求前先预留该模型配置的上下文窗口与本次输出上限。完整用量到达后按供应商返回值结算。请求取消或未返回完整用量时保留预留值，页面将计入额度与供应商已报告值分别展示。用量记录保存请求状态、归集维度和计量元数据。

## 需求与审批

打开控制台「需求与审批」新建草稿。设置 `ENTERPRISE_DEMAND_PRECHECK_MODEL` 选择一个组织范围内、允许处理内部数据且向相应角色开放的企业模型。预审向模型提供经过筛选的需求字段，结果绑定当前草稿修订。预审和桌面交互使用同一套模型额度。

钉钉 OA 连接使用 `ENTERPRISE_DINGTALK_TENANT`、`ENTERPRISE_DINGTALK_CORP_ID`、`ENTERPRISE_DINGTALK_APP_KEY`、`ENTERPRISE_DINGTALK_APP_SECRET`。需要接收 HTTP 事件时，另配置 `ENTERPRISE_DINGTALK_CALLBACK_TOKEN`、`ENTERPRISE_DINGTALK_CALLBACK_AES_KEY`，以及与企业回调设置一致的 `ENTERPRISE_DINGTALK_CALLBACK_RECEIVER`。平台管理员在「需求与审批 → 钉钉设置」绑定授权模板、员工标识及表单字段。使用钉钉原流程需要自选审批人时，为对应节点配置允许选择的人员。 [钉钉发起审批实例](https://dingtalk.apifox.cn/api-141001751)

使用 Stream 事件时，在钉钉企业应用订阅 `bpms_instance_change` 并为相应模板授权，再设置 `ENTERPRISE_DINGTALK_STREAM=true`。控制服务主动建立钉钉 HTTPS/WSS 连接，内网部署可以省去公网 HTTP 事件回调。只有匹配组织及已登记模板的事件才进入数据库，成功接收后才确认，最终状态由审批实例详情核对。中断时按退避策略重新连线，未核对的实例仍走原有补查。启用后可在服务日志看到连接和重连状态。 [钉钉 Stream SDK 协议](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs/blob/main/src/client.ts) · [审批实例事件](https://dingtalk.apifox.cn/doc-3659374)

工作台送审生成带 SHA-256 的冻结版本。钉钉既有模板也可经授权事件或模板补查进入工作台。通过、驳回和终止均以实例详情核对结果为准。审批通过的版本进入需求池，开发、工具和 ERP 写入有各自的授权流程。

## 企业记忆与知识

记忆按本人、项目或团队授权。本人可管理私人候选，项目或团队共享由对应范围的审核人发布。知识登记来源并发布后才可检索，结果带文档版本和可回查的引用。删除和撤权通过个人增量游标传播，客户端可独立重放。

在模型中心为指定企业模型开启「允许检索授权记忆和知识」后，可通过 `/api/v1/models/context` 查找同时符合当前用户权限、项目和供应商数据分类的片段。未选择项目时，项目知识与项目记忆不参与模型检索。服务端核对当前可读状态后返回片段与引用。

## 开发、金蝶和版本发布

- 「开发交付与验收」分配已核对的需求，管理静态检查、复审、测试证据和业务验收。 [开发交付说明](src/delivery/README.md)
- 「金蝶只读查询」启用后访问授权的星瀚开放接口，写操作申请单独审批。 [金蝶查询与审批配置](src/erp/README.md)
- 「版本发布」管理安装包、签名和灰度。 [Windows 企业版构建与发布](src/releases/README.md)

## 操作审计

平台管理员和审计员可以在「操作审计」按本组织、UTC 日期和业务模块查询操作，或下载最多 1000 条记录的 CSV。默认查最近七个 UTC 日期。日志展示时间、操作、对象与操作人标识，导出本身也会留痕。页面和文件均从固定的审计元数据生成，记忆、模型问答、表单正文、ERP 查询结果和凭据不参与导出。

## 部署边界

通过企业 HTTPS 反向代理提供控制台和客户端 API。反向代理应支持 WebSocket 升级，关闭模型 SSE 路由的响应缓冲。PostgreSQL 持久化账号、策略、用量、需求和审计，Redis 负责短期状态和同步通知。将模型加密密钥与 PostgreSQL 备份一起纳入各自的恢复管理。

此目录的本机开发和验收配置使用隔离的数据库、缓存、身份服务、模型和审批实例。生产接入需要配置公司的身份服务、供应商、钉钉模板权限和回调地址。
