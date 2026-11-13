# 力源金蝶研发工作台 (Liyuan Research Workbench V2)

本项目为力源企业研发定制的 AI 研发工作台，面向力源研发工程师、金蝶星瀚开发人员及测试人员，提供大模型辅助研发、企业知识库检索、金蝶星瀚单据只读查询、需求草稿与研发交付能力。

---

## 核心架构与目录分工

| 目录路径 | 模块名称 | 说明 |
| :--- | :--- | :--- |
| **`desktop/`** | **客户端桌面工程** | 基于 Electron + React + Vite + TailwindCSS 构建的跨平台桌面应用。 |
| **`desktop/src/`** | **前端界面与状态** | 包含页面路由、企业连接设置（免绑定码直连）、企业记忆与知识库展示。 |
| **`desktop/electron/`** | **Electron 主进程** | 包含系统托盘、本地硬件密钥存储（Ed25519）以及企业通信桥接（`enterpriseBridge`）。 |
| **`services/enterprise-control/`** | **企业内网控制台服务** | 基于 Bun + Hono + PostgreSQL 构建的企业服务端，提供内网挑战签发、知识库切块同步、需求审批与更新分发。 |
| **`src/shared/`** | **前后端共享模型** | TypeScript 协议定义（`enterpriseModels.ts`、`enterpriseErp.ts`、`piContext.ts`）。 |

---

## 快速上手开发

### 1. 本地环境要求
- **Bun** (推荐 >= 1.4.0)
- **Node.js** (推荐 >= 22.0.0 LTS)
- **操作系统**：Windows 10/11 或 macOS (Apple Silicon / Intel)

### 2. 依赖安装
```bash
# 根目录与桌面端依赖安装
bun install
cd desktop && bun install
```

### 3. 本地启动调试
```bash
# 进入桌面工程
cd desktop

# 方式一：单独启动前端热更新开发服务器 (浏览器模式)
bun run dev

# 方式二：启动完整的 Electron 桌面客户端热重载开发
bun run electron:dev
```

### 4. 运行质量与单元测试
在提交代码或合并 PR 之前，请运行测试套件：
```bash
# 运行桌面端测试
cd desktop && bun test

# 运行企业通信桥接单测
bun test electron/services/enterpriseBridge.test.ts
```

---

## 内网环境配置说明

- **力源内网控制服务地址**：`http://192.168.254.203:8081`
- **免绑定码一键直连**：在客户端左下角打开「设置」->「企业连接」，勾选「使用办公网服务器（HTTP）」，直接点击「内网一键直连」即可秒连，无需填写 43 位绑定码。
- **知识库互通**：连接内网后，可在「企业记忆与知识」直接查看 1,187 篇企业星瀚技术资料与团队历史经验。
