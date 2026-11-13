# 工作台浏览器的文档读取

在原生桌面工作区的浏览器中打开网页，加载完成后点击地址栏旁的文档图标「读取当前网页」。结果面板显示正文、来源和实际引擎。回退时会显示原因，关闭面板会回到原来的网页。正文以纯文本显示，可以手动选取复制。

默认由 Chromium 读取当前标签页。截图、选元素、网页交互和已登录的 ERP 页面沿用 Chromium。网页正文读取只在用户点击后执行，已登录页面的文字留在工作台结果面板。

## 启用可选 Lightpanda

Windows 使用已安装的 WSL2 Linux 发行版，在其中准备从官方来源取得并校验的 Lightpanda。Linux 和 macOS 使用本机 Lightpanda。由管理桌面启动环境的人员设置下列环境变量后重启工作台。示例中的地址和路径需按实际安装替换。工作台安装包与企业控制服务分别管理，Lightpanda 由本机独立安装。 [官方安装包](https://github.com/lightpanda-io/browser/releases/tag/1.0.2) · [官方 MCP 说明](https://lightpanda.io/docs/quickstarts/mcp) · [Lightpanda 许可证](https://github.com/lightpanda-io/browser/blob/main/LICENSE)

```powershell
$env:LIYUAN_LIGHTPANDA_WSL_DISTRO = 'Ubuntu'
$env:LIYUAN_LIGHTPANDA_BINARY = '/opt/lightpanda/lightpanda'
$env:LIYUAN_LIGHTPANDA_DOCUMENTS = '["https://docs.example.com/manual"]'
```

配置最多接受 64 条精确的公开 HTTPS 文档地址。含查询参数或锚点的地址、内网地址和已知登录/ERP 路径走 Chromium。发现 Cookie、站点存储、活动 Service Worker 或密码控件的页面也走 Chromium。

工作台为选中的公开文档单独做一次匿名 GET。连接使用经校验的公网地址并验证网站证书，遇到重定向、页面要求登录或动态生成正文时回退。工作台从响应中重建静态 HTML，仅把结构与文字传给每次独立启动的本机 MCP。Chromium 会话、Cookie 和站点存储留在原浏览器。MCP 用固定的 `markdown` 工具读取这份去掉脚本、表单和外链资源的静态副本，超时或失败时从当前 Chromium 页面提取可见文字。 [Lightpanda Markdown 工具](https://lightpanda.io/docs/reference/browser-tools#markdown)

匿名 HTML 响应上限为 512 KiB，重建的静态副本上限为 96 KiB，正文结果上限为 12,000 UTF-8 字节。主动导航、切换标签和关闭标签会中止当前读取。需要浏览图片、PDF、登录后操作或页面截图时使用原生浏览器入口。
