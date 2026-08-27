# AT Jenkins

<p align="center">
  <b>VS Code / Cursor 专业的 Jenkins 任务管理、流水线查看与 AI Agent 协同插件</b>
  <br />
  <sub>作为 AT Series 开发者工具套件的一员，为 CI/CD 运维与研发提供无缝的 IDE 原生 Jenkins 操作体验与 AI Agent MCP 互通能力。</sub>
</p>

---

## 🌟 核心特性

### 1. 多控制器与多鉴权模式
- **多实例集中管理**：支持配置多个 Jenkins Controller（支持前缀路径如 `/jenkins`），一键在侧边栏切换当前活动控制器。
- **三种鉴权模式**：
  - **无身份验证 (None)**：适用于公开或内网无认证的只读实例；若控制器启用了 CSRF，匿名 POST 同样会获取并绑定 Crumb 与会话 Cookie。
  - **API Token（推荐）**：使用 Jenkins 用户个人资料生成的 API Token 进行认证。
  - **用户名与密码 (Password)**：支持账号密码认证，自动探测并注入 CSRF Crumb 保护头及会话 Cookie（兼容 Jenkins 2.x CSRF 防护机制）。
- **凭据安全存储**：敏感密码与 API Token 均存储在 VS Code 原生 `SecretStorage` 加密存储中，绝不写入明文配置文件。
- **只读控制器安全模式**：支持将生产环境控制器配置为“只读控制器 (`readOnly`)”，UI 层禁用写操作，底层硬拦截触发构建、停止构建和脚本修改请求。

### 2. TLS 首次信任机制 (TOFU)
- **自签名证书支持**：支持配置 HTTPS 控制器连接。
- **Trust-On-First-Use (TOFU)**：首次连接出示新证书时弹出指纹确认框并记录 SHA-256 证书指纹；证书发生意外变更时强制弹出安全告警并拦截连接，有效防止中间人攻击 (MITM)。

### 3. 任务与构建导航
- **层级树状导航**：
  - **Controllers 视图**：清晰展示所有已配置的 Jenkins 控制器、活跃状态、URL 与安全选项。
  - **Jobs 视图**：按层级展现 Jenkins 任务结构，完整支持 Folder / 目录递归展开。
- **任务与状态识别**：智能区分 Pipeline 流水线任务（`WorkflowJob`）与 Freestyle 自由风格任务，通过图标颜色直观反映任务状态（成功/失败/构建中/已终止/不稳定）；Multibranch / Organization / Matrix 任务带类型徽标；Jobs 树展示 Jenkins `healthReport` 天气/稳定性。
- **增量构建分页**：构建列表支持按页加载（默认 10 条，可在设置中调整），提供「加载更多构建...」按需展开历史记录。
- **在 Jenkins 中打开**：从控制器、文件夹、任务、构建或虚拟文档一键在浏览器打开对应页面（仅允许 http/https）。
- **最近参数复用**：参数化构建可选择使用上次提交的非密钥参数、逐项编辑或恢复默认值。
- **状态栏跟踪**：触发构建后在状态栏显示排队/构建中，完成后通知并可查看日志。

### 4. 虚拟文档与流式日志
- **流水线脚本编辑 (`at-jenkins:` 协议)**：
  - 打开控制器存储的 CPS 流水线脚本草稿 (`at-jenkins-draft://{instanceId}/Jenkinsfile?job={jobFullName}`)。
  - 原生 Groovy 语法高亮，支持在编辑器中直接修改并保存（`Cmd+S` / `Ctrl+S`）同步回 Jenkins 服务端（受只读与二次确认保护）。
- **实时构建日志查看**：
  - 打开构建控制台日志虚拟文档 (`at-jenkins://{instanceId}/{buildNumber}/consoleText?job={jobFullName}`)。
  - 对正在运行的构建自动轮询刷新（默认 3 秒，可通过 `atJenkins.log.pollIntervalMs` 调整）；日志尾部通过 Jenkins `progressiveText` 增量拉取，避免每次重下整份 console。
  - 构建完成后自动停止轮询。
- **输出通道跟踪 (Follow in Output)**：
  - 支持将构建日志实时流式输出到 VS Code Output Channel（`AT Jenkins`），支持进度跟踪与终端式阅读。

### 5. 安全可控的构建操作
- **参数化构建弹窗**：触发构建时，自动解析任务定义的参数列表，交互式引导输入：
  - **String / Text**：输入框引导。
  - **Choice**：下拉单选列表并标注默认项 `(default)`。
  - **Boolean**：`true` / `false` 快速单选。
  - **Password**：敏感密码输入掩码。
- **停止构建**：对运行中的构建支持一键终止。
- **二次确认与保护**：所有构建触发、终止与脚本保存操作均强制弹出模态确认对话框；若控制器处于只读模式则直接拒绝执行。

### 6. AI Agent 与 MCP 支持
- **内置 7 大只读 MCP 工具**（严格只读，UI 可写，MCP 只读）：
  1. `jenkins_list_instances`：列出全部已配置的 Jenkins 控制器及 allowBackgroundAccess 等标志（不含敏感凭据）；其它工具仍需该实例开启后台访问。
  2. `jenkins_list_jobs`：查询任务列表（支持可选 `folderFullName`）。
  3. `jenkins_get_job`：获取指定任务的详细元数据与参数定义。
  4. `jenkins_get_pipeline_script`：获取控制器存储的 Pipeline 流水线脚本内容。
  5. `jenkins_list_builds`：分页查询指定任务的构建历史记录。
  6. `jenkins_get_build`：获取单次构建的详细信息（状态、耗时、时间戳等）。
  7. `jenkins_get_build_log`：获取构建控制台日志文本（支持尾部 64 KiB 截断与 `start` 偏移量分块读取；元数据含 `hasMore` / `endByte` / `truncated`）。
- **安全防线 (Hard Exclusions)**：
  - **严格只读**：MCP 工具集坚决不提供任何写操作工具（不提供触发构建、停止构建、编辑脚本工具）。
  - **后台访问门禁 (`allowBackgroundAccess`)**：每个控制器实例独立提供后台访问开关（默认关闭），未开启时 Agent 仍可通过 jenkins_list_instances 看见该控制器，但无法调用其它 jenkins_* 工具查询它。
  - **敏感数据脱敏**：绝不在 MCP 工具响应中返回密码、Token 等敏感凭据。
- **MCP Hub 互通**：内置 Bridge 桥接服务，无缝接入 `@at-series/mcp-hub` 统一协议，由 `AT Series` 统一管理。

---

## 🚀 编译与打包

### 前置要求
- Node.js 18+
- npm 或 pnpm

### 本地构建
```bash
# 安装依赖
npm install

# 运行自动化测试 (350+ 单元测试)
npm test

# 类型检查
npm run typecheck

# 编译扩展与 Webview
npm run compile

# 打包 VSIX 插件
npm run package
```
打包成功后，将在根目录下生成 `at-jenkins-0.1.0.vsix`。

---

## 📦 安装与使用

1. 打开 VS Code 或 Cursor。
2. 进入扩展视图（Extensions），点击右上角 **`⋯` (更多操作) -> 从 VSIX 安装... (Install from VSIX...)**。
3. 选择生成的 `at-jenkins-0.1.0.vsix` 文件完成安装。
4. 在左侧活动栏点击 **AT Jenkins** 图标，点击 **「添加控制器」** 即可配置 Jenkins 实例。
5. （可选）为需要允许 AI Agent 访问的实例勾选 **「允许 Agent 后台访问」**。

## Agent Skill

| Skill | 说明 |
| --- | --- |
| [`at-jenkins-mcp`](skills/at-jenkins-mcp/SKILL.md) | 通过 AT Series MCP (`pluginId` `at.jenkins`) 检查 Jenkins 任务、构建状态、流水线脚本及控制台日志。 |

---

## 🛡️ 架构与工程设计

本项目采用严谨的分层架构设计：
- **Client & Auth 层**：轻量原生 HTTP 客户端，支持 Cookie / Crumb 管理、Keep-Alive 连接池复用与 TOFU TLS 证书校验。
- **Virtual Document 虚拟文档层**：基于 `at-jenkins-draft` FileSystemProvider（可编辑流水线脚本）与 `at-jenkins` ContentProvider（日志/只读回退），支持脚本保存确认与日志轮询。
- **Webview UI 层**：纯原生深色系 Webview 表单，零冗余框架依赖，响应极速。
- **MCP Bridge 层**：基于 `@at-series/mcp-hub` 协议暴露只读工具，严格执行 `allowBackgroundAccess` 与参数校验。
- **自动化测试**：覆盖全量客户端、认证、文档提供者、TreeProvider、MCP 工具与 i18n 多语言，100% 测试通过率。

---

## 📄 开源许可

[MIT License](LICENSE)
