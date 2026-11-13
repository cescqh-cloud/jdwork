# 客户端版本管理

版本中心在控制台「客户端版本」。当前发布目标是 Windows 完整 NSIS 安装包，支持 x64、arm64、ia32。上传需要保留项目固定的 electron-builder 26.8.1 输出，包括 `latest.yml` 和清单引用的原始 `.exe`。清单需要 `files[0].size` 和 SHA-512。每次按目标架构单独构建，采用不含路径和 URL 的 ASCII 文件名。企业更新当前使用完整包下载，沿用既有 electron-updater 的 SHA-512 和签名校验。 [electron-builder 自动更新](https://www.electron.build/v26/docs/features/auto-update/)

## 配置和签名

| 配置 | 内容 |
| --- | --- |
| `ENTERPRISE_UPDATE_OBJECT_DIRECTORY` | 持久化私有对象目录的绝对路径，位于文件系统私有权限下。Windows 用仅服务账号可写的目录 ACL |
| `ENTERPRISE_UPDATE_SIGNING_KEY` | 用于清单证明的 Ed25519 PKCS#8 私钥。支持 PEM 或 PKCS#8 DER 的 Base64URL 编码 |
| `ENTERPRISE_UPDATE_TRUSTED_SIGNERS` | 允许签署 EXE 的证书 DER SHA-256，逗号分隔。使用证书本体的 SHA-256 |
| `ENTERPRISE_UPDATE_VERIFY_COMMAND` | 非 Windows 服务部署必填，绝对路径指向受信可执行验证程序。程序接受一个安装包路径参数。仅在验证了 PE 的真实 Authenticode 签名、证书链和签名状态后，成功输出 `{"kind":"authenticode","fingerprint":"证书SHA-256","publisher":"发布者"}` |
| `ENTERPRISE_UPDATE_MAX_BYTES` | 安装包上传字节上限，默认 1 GiB，最大 2 GiB。反向代理的请求大小和超时也应相符 |

Windows 部署可使用内置 `Get-AuthenticodeSignature`，要求 `Valid`、嵌入的 Authenticode 签名和受信证书指纹。生产控制台通过 HTTPS 访问。组织身份提供方应对平台管理员配置多因素认证。签名密钥和外部验证器由部署方控制。 [Windows SignTool 验证](https://learn.microsoft.com/windows/win32/seccrypto/signtool)

客户端安装前应使用随构建固定或通过独立可信渠道核验的 Ed25519 SPKI 公钥。响应里的 `publicKey` 和 `/api/v1/updates/key` 只用来比对和排查。`proof.payload` 是待验签的原始 UTF-8 JSON 经 Base64URL 编码。验证签名后核对其中的 release ID、版本、架构、清单 SHA-256 和安装包哈希，再交给原有更新器。私钥更换时，部署方需要协调新旧客户端的公钥信任。

### 构建企业 Windows x64 安装包

在有 Windows 编译工具和组织签名证书的构建机上，准备仅含发布公钥和证书指纹的 JSON 文件。字段为 `publicKey`（Ed25519 SPKI DER 的 Base64URL）、`publisherSha256`（Windows 签名证书 SHA-256 小写十六进制）和 `channel`（`stable`、`canary` 或 `dev`）。发布证明的私钥留在控制服务。构建机需通过公司的代码签名流程配置证书。

在 `desktop` 目录设置 `LIYUAN_DESKTOP_BUILD_UPDATE_TRUST_FILE` 为该 JSON 的路径，设置 `LIYUAN_DESKTOP_RELEASE_VERSION` 和 `LIYUAN_DESKTOP_SIGNER_PUBLISHER`，再在 PowerShell 运行：

```powershell
.\scripts\build-windows-x64.ps1 -Enterprise
```

构建会核对固定在客户端内的公钥和发布者指纹，签名后的安装包也会再核对一次。产物和 `latest.yml` 位于 `desktop/build-artifacts/windows-x64`。首次使用企业签名更新的设备需要安装已内置相应公钥的企业包并绑定控制台。

## 发布和灰度

1. 新建草稿并选稳定、灰度或研发渠道。按设备 ID 固定分桶，可以先限定设备、员工或部门，再设置覆盖比例。研发渠道必须指定目标。
2. 上传构建清单和安装包。服务器核对大小、SHA-512、Windows 文件格式和 Authenticode 签名，将校验后的安装包写入内容寻址的私有目录。安装包和清单一经验证即固定，避免同版本悄悄替换。
3. 在目标架构测试实际安装和启动，并填写验收编号后发布。不同渠道复用同版本时必须使用同一安装包。当前已发布灰度策略固定，可将验收通过的同一个包另行发布到稳定渠道。
4. 已绑定的桌面设备检查自身可用的候选。只有该设备拿到候选且发布仍有效时，才能用设备令牌读取清单和安装包。链接不携带令牌。文件下载支持单段 `Range` 和 `HEAD`。
5. 回报按设备去重。满足最少已完成回报数并达到失败比例时会自动暂停，也可手动暂停。暂停后续请求即时停止提供该版本。需要修复时发布更高版本。

最低版本提示只在设备存在可用候选时可标记为要求更新。已下载但尚未安装的包，应由客户端再次确认发布状态和验签结果后才安装。企业控制服务不可用时，原有本地会话仍由客户端保留。

## 验证

在服务目录设置 `ENTERPRISE_TEST_DATABASE_URL` 指向临时 PostgreSQL。运行 `bun --no-env-file test test/releases.contract.test.ts test/releases.integration.test.ts`。测试使用明确的本机签名夹具，并用项目锁定的 builder 代码生成真实格式的清单。原有 `NsisUpdater` 的检查、下载和 SHA-512 校验使用回环服务，安装入口不执行。Windows 额外核对真实验证器拒绝未签名测试文件。真实公司签名证书和目标版本的安装验收应在发布环境另行完成。
