# 企业统一登录

工作台控制服务使用 OIDC 授权码和 S256 PKCE。用户在身份服务登录后，控制服务按组织、签发方和员工的 `sub` 标识查找已预授权的内部账号。角色以工作台账号当前的配置为准。 [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation) · [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636.html#section-4)

## 身份服务配置

在企业身份服务注册机密 Web 应用，回调地址填写 `ENTERPRISE_ORIGIN` 加 `/console/sso/callback` 的完整地址。身份服务须支持 `openid`、授权码、S256 PKCE 和 RS256 签名。

| 服务端变量 | 值 |
| --- | --- |
| `ENTERPRISE_OIDC_ISSUER` | 身份服务元数据的 `issuer` 原值，保留结尾斜杠 |
| `ENTERPRISE_OIDC_AUTHORIZATION_URL` | 身份服务的 `authorization_endpoint` |
| `ENTERPRISE_OIDC_TOKEN_URL` | 身份服务的 `token_endpoint` |
| `ENTERPRISE_OIDC_JWKS_URL` | 身份服务的 `jwks_uri` |
| `ENTERPRISE_OIDC_CLIENT_ID` | 注册应用的客户端 ID |
| `ENTERPRISE_OIDC_CLIENT_SECRET` | 由服务端密钥管理注入的客户端密钥 |
| `ENTERPRISE_OIDC_TOKEN_AUTH_METHOD` | 可选。默认为 `client_secret_basic`，也支持 `client_secret_post` |

身份服务地址均使用 HTTPS，服务端使用正常的 TLS 证书校验。省略全部 OIDC 变量时，统一登录入口关闭。配置上线前，请将控制台源设为企业 HTTPS 域名，并确认身份服务中登记的回调地址完全一致。

## 账号预授权

管理员先开通工作台内部账号，并从身份服务获取该应用识别的准确 `sub`。服务端管理员在 `services/enterprise-control` 目录使用与工作台相同的服务配置执行数据库迁移和绑定。

```powershell
bun --no-env-file run migrate
bun --no-env-file run src/identity/bind.ts 'example-tenant' 'existing-login' 'example-employee-sub'
```

首次绑定写入审计日志。重复提交同一绑定可以安全重试。如果该身份已在此组织绑定到其他账号，命令会拒绝覆盖。已禁用的组织或账号无法使用绑定登录。

员工在控制台输入组织代码后选择企业统一登录，进入控制台后可生成桌面绑定码。

## 本地验证

离线用例模拟身份服务，检查签名、受众、签发方、有效期、随机挑战、浏览器绑定和签名密钥轮换。使用 `test/README.md` 的本机测试实例可同时验证 PostgreSQL 账号绑定和 Redis 一次性状态。

```powershell
bun --no-env-file test test/identity.test.ts test/identity.integration.test.ts
```
