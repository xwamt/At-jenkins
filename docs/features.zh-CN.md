# AT Jenkins — 功能特性文档

**目标读者：** 配置和使用插件的终端用户与系统管理员（AI Agent 的 MCP 工具契约请参考 [`skills/at-jenkins-mcp/SKILL.md`](../skills/at-jenkins-mcp/SKILL.md)）。

## 概述

AT Jenkins 为 VS Code 与 Cursor 带来了原生的 Jenkins CI/CD 控制器管理、任务层级浏览、构建日志实时跟踪与流水线脚本编辑能力，并通过共享的 [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) 协议 v1 将 Jenkins 元数据、任务配置及构建日志开放给 AI Agent —— 无需单独配置独立的 MCP 服务器，在添加 Jenkins 控制器后即可开箱即用。

---

## 控制器实例配置

- **多 Jenkins 控制器管理**：支持配置一个或多个 Jenkins 控制器（包含显示标签 Label、基础 URL、认证方式），支持自定义路径前缀（如 `http://ci.internal.net:8080/jenkins`）。
- **三种身份验证模式**：
  - **无身份验证 (None)**：适用于公开或仅内网只读镜像。
  - **API Token（推荐）**：使用 Jenkins 用户个人资料页面（Jenkins → 用户个人资料 → 设置 → API Token）生成的 API Token 进行认证。
  - **用户名与密码 (Username and Password)**：支持账号密码认证，自动获取并缓存 CSRF Crumb 请求头（完整适配 Jenkins 2.x 的 `DefaultCrumbIssuer` CSRF 防护机制）。
- **凭据安全加密存储**：敏感 API Token 及密码由 VS Code 原生 `SecretStorage` 进行安全加密存储，绝不以明文形式保存在设置文件或磁盘上。
- **TLS 首次信任机制 (TOFU)**：针对自签名证书或私有 CA 证书的 HTTPS 连接，首次连接时弹出指纹确认弹窗并记录 SHA-256 指纹；若证书在后续发生非预期变更，则自动拦截连接并弹出安全警告，有效防御中间人劫持。
- **只读控制器模式 (`readOnly`)**：支持将生产环境控制器设置为只读模式。UI 层禁用构建触发、构建停止及流水线脚本保存操作，底层运行时硬拦截任何写请求并抛出 `ReadOnly` 错误。
- **Agent 后台访问控制 (`allowBackgroundAccess`)**：每个控制器实例均具备独立的“允许 Agent 后台访问”开关（默认关闭）。只有显式开启该选项的控制器，才能被 AI Agent 通过 MCP 发现和查询。
- **连接测试**：控制器配置表单提供「测试连接」按钮，在保存前全面验证网络连通性、TLS 证书及认证有效性。

---

## 侧边栏树状导航

- **Controllers 控制器视图 (`atJenkins.instances`)**：
  - 清晰展示所有已配置的 Jenkins 控制器列表，通过图标状态直观标识当前活动控制器（活动控制器为 `radio-tower` 图标，非活动控制器为 `server` 图标）。
  - 支持快捷行内操作与右键菜单：**设为当前控制器**、**测试连接**、**编辑控制器**、**删除控制器**。
  - 提供富文本 Markdown 悬浮提示（Tooltip），完整展示基础 URL、认证模式、用户名、活动状态、只读状态、后台访问权限及 TLS 验证配置。
- **Jobs 任务视图 (`atJenkins.jobs`)**：
  - 自动加载当前活动控制器下的任务列表。
  - 完整支持 Folder / 目录递归展开（兼容 `com.cloudbees.hudson.plugins.folder.Folder`）。
  - 任务类型与状态智能识别：
    - 区分 Pipeline 流水线任务（`WorkflowJob` / `CpsFlowDefinition`）与 Freestyle 自由风格任务（`FreeStyleProject`）。
    - 丰富的状态图标（成功绿色圆圈、失败红色错误、不稳定黄色警告、终止/禁用紫色圆圈、构建中蓝色旋转动画）。
  - 增量分页与按需加载：展开任务时按需分页加载历史构建记录（默认每页 10 条），末尾提供「加载更多构建...」按钮以展开更多历史。

---

## 虚拟文档与流式日志

- **流水线脚本编辑 (`jenkins:` 协议)**：
  - 通过虚拟文档 URI 打开控制器存储的 CPS 流水线脚本 (`jenkins://<instance>/pipeline/<job>.groovy`)。
  - 原生 Groovy 语法高亮。
  - 支持原地编辑并直接保存（`Cmd+S` / `Ctrl+S`）：修改并保存虚拟文档即可将最新脚本同步回 Jenkins 控制器（受只读控制器模式与破坏性操作模态确认框保护）。
- **实时构建控制台日志 (`jenkins:` 协议)**：
  - 通过虚拟文档 URI 打开构建控制台日志 (`jenkins://<instance>/build-log/<job>/<number>.log`)。
  - 原生 Log 语法高亮。
  - 增量流式自动刷新：对正在运行中的构建（`building: true`），每 3 秒自动轮询并追加新日志，构建结束后自动终止轮询。
  - 智能资源释放：当日志标签页在编辑器中关闭时，自动停止对应的后台轮询计时器。
- **在输出通道中跟踪日志 (Follow in Output)**：
  - 右键点击构建节点选择「在输出通道中跟踪构建日志」，在 VS Code Output 通道（`AT Jenkins`）中以终端流式效果实时输出最新日志，带有清晰的构建开始与结束提示。

---

## 安全可控的写操作

- **触发构建 (`atJenkins.triggerBuild`)**：
  - 参数化构建交互式弹窗：自动解析任务定义的参数列表，引导用户填写：
    - **String / Text 参数**：带有参数说明与默认值的输入框。
    - **Choice 下拉参数**：QuickPick 单选列表，标明默认选项 `(default)`。
    - **Boolean 布尔参数**：`true` / `false` 快速选项。
    - **Password 密码参数**：密码掩码输入框。
  - 模态二次确认框：在发送触发请求前弹出警告确认弹窗。
  - 只读控制器拦截：若控制器配置为只读，则拒绝触发并提示错误。
- **停止构建 (`atJenkins.stopBuild`)**：
  - 仅在运行中的构建节点上可用（`jenkinsBuild.building`）。
  - 弹出模态二次确认框，防止误终止生产构建。
  - 只读控制器拦截：若控制器配置为只读，则拒绝停止请求。

---

## AI Agent 与 MCP 工具目录

内置 7 大只读工具，全部为 `read-only` 风险等级，安装 AT Series MCP 配置后由宿主统一管理，无需逐一授权：

1. **`jenkins_list_instances`**：
   - 列出所有开启了 `allowBackgroundAccess: true` 的 Jenkins 控制器。
   - 绝不返回 API Token、密码或敏感凭据。
2. **`jenkins_list_jobs`**：
   - 查询指定控制器的任务列表。
   - 支持可选的 `folder` 参数以查询嵌套目录内的任务。
   - 返回任务名称、完整路径、类型 (`_class`)、颜色/状态及是否为文件夹标识。
3. **`jenkins_get_job`**：
   - 获取指定任务的详细元数据，包含参数定义、最近构建摘要与健康报告。
4. **`jenkins_get_pipeline_script`**：
   - 获取控制器存储的 CPS 流水线 Groovy 脚本内容。
5. **`jenkins_list_builds`**：
   - 分页查询任务的历史构建列表（支持 `limit` 与 `offset` 参数）。
   - 包含构建编号、结果状态、时间戳、持续时间及构建中标识。
6. **`jenkins_get_build`**：
   - 获取单次构建的详细信息（状态结果、耗时、时间戳、变更集、使用参数）。
7. **`jenkins_get_build_log`**：
   - 获取指定构建的控制台日志文本。
   - 默认截取末尾 64 KiB 日志（`DEFAULT_LOG_TAIL_BYTES`）。
   - 支持传入 `start` 字节偏移量进行增量分块读取，并返回分页元数据（`hasMore`、`totalBytes`、`nextStartByte`）。

### 安全边界与硬性隔离
- **MCP 无写操作工具**：MCP 工具集严格不提供任何构建触发、终止构建或修改脚本的工具。所有破坏性与写操作均只能由用户在 IDE 界面手动确认执行。
- **后台访问门禁**：未勾选“允许 Agent 后台访问”的实例对 Agent 完全不可见。
- **敏感数据脱敏**：日志与错误响应中涉及 Token、Cookie 及密码的内容均由脱敏器自动掩码。

---

## Hub 与 IDE 集成

- **AT Jenkins: Install/Repair AT Series MCP Config** 统一管理所有 AT 家族插件共享的单个 `AT Series` MCP 条目（Cursor、Kiro、Continue），安装 AT Jenkins 绝不会产生重复的独立 MCP 服务条目。
- **统一桥接协议**：通过本地环回接口（`127.0.0.1`）与 `@at-series/mcp-hub` 进行高效安全的通信。

---

## 非本版本目标 (Non-goals)

- 多分支流水线 (Multibranch Pipeline) 的分支索引远程触发（支持常规流水线与自由风格任务的查看与直接构建）
- Jenkins 系统管理员级别运维（如插件安装、节点管理等）
- 对 Jenkins Agent 节点的直接 SSH 终端执行
- Jenkins 1.x 遗留控制器支持（专注兼容 Jenkins 2.x+）
