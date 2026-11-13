# 金蝶星瀚查询与写操作审批

「金蝶只读查询」调用已登记的星瀚开放接口。已授权成员可测试连接、查询接口已发布的元数据，或按完整编号查询单据。返回内容受接口登记的字段限制。控制服务保存操作人、项目、环境、查询项、时间和结果条数。

## 登记测试环境

由金蝶应用管理员先在测试环境发布并授权所需的 **GET** 查询，核对接口路径、参数、返回结构和读权限。`ENTERPRISE_ERP_ENVIRONMENTS` 由部署人员在服务端填写，以下为配置示意，路径和字段均需换成该环境实际发布的契约。

```json
[
  {
    "tenant": "liyuan",
    "id": "xh-uat",
    "name": "星瀚 UAT",
    "kind": "kingdee-xh",
    "mode": "test",
    "origin": "https://erp-uat.example.com",
    "credentialRef": "ERP_XH_UAT",
    "scopes": [{
      "projectId": "00000000-0000-4000-8000-000000000001",
      "roles": ["developer", "it_lead"],
      "writeReviewRoles": ["it_lead"]
    }],
    "queries": [
      {"id": "health", "label": "接口连通性", "kind": "connection", "path": "/kapi/example/health"},
      {
        "id": "receipt", "label": "采购收货单", "kind": "document", "path": "/kapi/example/receipts",
        "numberParameter": "number", "numberColumn": "number", "rowPath": ["rows"],
        "columns": [{"key": "number", "title": "单据编号"}, {"key": "status", "title": "状态"}]
      }
    ]
  }
]
```

在同一服务的凭据配置中，按上面的前缀填写 `ERP_XH_UAT_CLIENT_ID`、`ERP_XH_UAT_CLIENT_SECRET`、`ERP_XH_UAT_USERNAME`、`ERP_XH_UAT_ACCOUNT_ID` 和 `ERP_XH_UAT_GATEWAY_IDENTITY`。应用身份和账号仅由服务端使用。适配器按当前契约调用星瀚 OAuth2，再使用网关身份和访问令牌调用查询。已配置的查询必须成功返回 `status: true`，表格数据放在 `data` 下的 `rowPath`。访问令牌只在进程内短期缓存，遇到 401 会刷新并重查一次。 [金蝶开放平台接口调用](https://vip.kingdee.com/knowledge/specialDetail/272110040385964032?category=523054365351886592&id=543448746756000256&lang=zh-CN&productLineId=40&type=Knowledge)

测试和生产使用分别登记的环境与应用身份。Web 控制台和设备调用都要求当前租户、项目成员身份及允许的角色。环境只接受已登记的 HTTPS 源，本机隔离验收可使用回环 HTTP。当前适配器只支持星瀚开放接口契约，数据库直连和星空接口尚未接入。

## 桌面助手查询

部署前应用迁移 `0013`。在模型中心选择支持工具调用的企业模型，勾选「允许查询授权的金蝶测试接口」。给允许在对话里使用的测试或沙箱查询增加 `"allowAssistant": true`。两项默认关闭。请选用允许出现在该企业模型对话中的测试数据及字段。

在桌面选择该模型后，可询问「在星瀚测试环境查采购收货单 CGSH-…」。助手先获取已授权的项目和查询入口，再按完整单号读取。结果附测试环境、查询时间和审计编号，每次最多十行。模型、会话、设备和项目权限由服务端核验，查询完成时会复查授权。

## 写操作申请

为项目配置 `writeReviewRoles` 后，从对应项目的「ERP 写操作审批」提交单据编号、变更和原因。申请冻结变更及环境标识，重复提交同一申请只保留一份。申请人以外、当前项目授权的独立审批人可通过或驳回。需求批准状态与此流程独立。审批通过后，实际金蝶写入由获授权人员处理。

服务端正式运行只开放 ERP 查询。执行校验接口对未独立审批的申请拒绝并写入审计。隔离测试在回环沙箱中模拟执行超时、保留待人工核实的结果，并验证重复操作和服务重启均不触发第二次执行。

## 验收

使用本机 PostgreSQL 和 Redis 运行 `bun --no-env-file test test/erp.integration.test.ts test/erp-assistant.integration.test.ts test/erp-approval.integration.test.ts`。连接、查询、权限撤销和沙箱均由模拟环境验证。星瀚 UAT 的实际接口、应用权限和字段映射需用已授权的测试实例核对。
