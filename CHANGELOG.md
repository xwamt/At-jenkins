# 更新日志 (Changelog)

所有关键版本的更新记录都将在此文档中记录。

---

## [v0.1.1] - 2026-08-31

### 客户端与安全
- 构建日志优先走 Jenkins `logText/progressiveText`（`X-Text-Size` / `start`），缺失时回退 `/consoleText`，跟随与尾部截断不再每次下载整份日志。
- CSRF Crumb 与 `JSESSIONID` 会话 Cookie 绑定，适用于 **password** 与 **none** 鉴权下的写操作。
- 「在 Jenkins 中打开」仅允许 `http:` / `https:`，拒绝 `file:` / `javascript:` / `vscode:` 等服务端下发的危险 scheme。
- Webview CSP 去掉未使用的 `style-src 'unsafe-inline'`。

### UX 与品牌
- Jobs 树展示 `healthReport` 天气/稳定性（不再用单次 lastBuild 冒充 0%/100%）。
- 触发构建后状态栏跟随 + 完成通知；参数化构建可复用最近一次非密钥参数。
- 新增 `atJenkins.openInJenkins`，以及可配置的分页/轮询/日志尾部设置（`atJenkins.builds.pageSize`、`atJenkins.log.*`、`atJenkins.follow.*`）。
- 修复插件 Logo 资源，重绘为 128×128 标准居中圆角矢量位图，解决扩展列表中图标仅占角落的问题。

### 架构与规划
- 引入完整的 v1/v2 演进规格（`0.2.0` 生产可用加固与 `0.3.0` 运维深度功能）、工程质量契约与分阶段实施计划。

---

## [v0.1.0] - 2026-08-25

**AT Jenkins 首发版本正式发布！🎉**

AT Jenkins 是一款面向 VS Code 与 Cursor 的专业级 Jenkins CI/CD 管理与流水线协同插件，作为 AT Series 开发者套件的一员，为 DevOps 工程师与开发者提供无缝的 IDE 原生任务导航、构建触发与停止、流水线脚本编辑、控制台日志实时跟踪以及 AI Agent MCP 互通能力。

### 🌟 核心特性与功能亮点

#### 1. 多控制器与多鉴权管理 (Multi-Instance & Authentication)
- **多实例统一管理**：支持配置多个 Jenkins Controller，随时切换当前活动控制器并即时刷新任务树。
- **三种鉴权模式**：全面支持无认证 (None)、API Token（推荐）以及账号密码 (Username & Password) 搭配 CSRF Crumb 自动管理。
- **安全凭据存储**：敏感密码及 Token 使用 VS Code 原生 `SecretStorage` 加密存储，不存明文配置。
- **TLS 首次信任 (TOFU)**：HTTPS 自签名证书首次连接弹窗确认并计算 SHA-256 指纹记录，防中间人劫持。
- **只读控制器保护 (`readOnly`)**：支持配置只读控制器，UI 禁用写操作，运行时底层硬拦截触发构建、停止构建及流水线保存。

#### 2. 任务导航与构建历史 (Jobs & Builds Navigation)
- **双栏视图设计**：
  - **Controllers 视图**：展示所有已配置的 Jenkins 控制器列表与连接状态。
  - **Jobs 视图**：树状展示任务层级，完整支持 Folder / 目录递归浏览。
- **任务与状态识别**：智能区分 Pipeline 流水线任务（`WorkflowJob`）与 Freestyle 自由风格任务，通过图标颜色直观反映任务状态（成功/失败/构建中/已终止/不稳定）。
- **增量构建分页**：构建列表支持按页加载（默认 10 条），提供「加载更多构建...」按需展开历史记录。

#### 3. 虚拟文档与流式日志 (Virtual Documents & Logs)
- **流水线脚本编辑 (`at-jenkins:` 协议)**：
  - 可编辑草稿打开控制器存储的 CPS 流水线脚本 (`at-jenkins-draft://{instanceId}/Jenkinsfile?job={jobFullName}`)。
  - 原生 Groovy 语法高亮，支持在编辑器中直接修改并保存（`Cmd+S` / `Ctrl+S`）同步回 Jenkins 服务端。
- **实时构建日志查看**：
  - 虚拟文档打开构建控制台日志 (`at-jenkins://{instanceId}/{buildNumber}/consoleText?job={jobFullName}`)。
  - 对正在运行的构建自动开启 3 秒轮询增量刷新，构建完成后自动停止轮询。
- **输出通道跟踪 (Follow in Output)**：
  - 支持将构建日志实时流式输出到 VS Code Output Channel（`AT Jenkins`），支持进度跟踪与终端式阅读。

#### 4. 安全可控的构建操作 (Safe Build Operations)
- **参数化构建弹窗**：触发构建时，自动解析任务定义的参数列表，交互式引导输入 String、Choice、Boolean、Password。
- **停止构建**：对运行中的构建支持一键终止。
- **二次确认与破坏性操作保护**：所有构建触发、终止与脚本保存操作均强制弹出模态确认对话框；若控制器处于只读模式则直接拒绝执行。

#### 5. AI Agent 与 MCP 支持 (MCP Integration)
- **内置 7 大只读 MCP 工具**（严格只读，UI 可写，MCP 只读）：
  1. `jenkins_list_instances`：列出全部已配置控制器及标志；其它工具需开启后台访问。
  2. `jenkins_list_jobs`：查询任务列表（支持可选 `folderFullName`）。
  3. `jenkins_get_job`：获取指定任务的详细元数据与参数定义。
  4. `jenkins_get_pipeline_script`：获取控制器存储的 Pipeline 流水线脚本内容。
  5. `jenkins_list_builds`：分页查询指定任务的构建历史记录。
  6. `jenkins_get_build`：获取单次构建的详细信息（状态、耗时、时间戳等）。
  7. `jenkins_get_build_log`：获取构建控制台日志文本（支持尾部 64 KiB 截断与 `start` 偏移量分块读取；元数据含 `hasMore` / `endByte` / `truncated`）。
- **安全防线 (Hard Exclusions)**：
  - **严格只读**：MCP 工具集坚决不提供任何写操作工具。
  - **后台访问门禁 (`allowBackgroundAccess`)**：每个控制器实例独立提供后台访问开关（默认关闭）；未开启时仍可通过 `jenkins_list_instances` 列出（含标志），但其它 `jenkins_*` 工具会拒绝访问。
  - **敏感数据脱敏**：绝不在 MCP 工具响应中返回密码、Token 等敏感凭据。
- **MCP Hub 互通**：内置 Bridge 桥接服务，无缝接入 `@at-series/mcp-hub` 统一协议。

---

### 🧪 自动化测试与工程质量
- 包含 **310+** 自动化单元与集成测试，100% 通过率。
- 完整的 TypeScript 类型安全与 i18n（英语与简体中文）双语支持。
