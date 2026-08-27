# at-jenkins 前端 UI 美化与用户友好度优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 针对 `at-jenkins` 进行全面的前端 UI 美化与交互友好度升级，包括现代化的 Webview 配置表单（Toggle Switch、密码显隐、诊断反馈）、侧边栏健康度天气图标与任务类型徽标、全局 VS Code 状态栏常驻指示与构建完成智能通知，以及参数化构建历史记忆。

**Architecture:** 
1. **Webview Layer**: 重构 `webview/jenkins-instance-form` 样式与交互逻辑，使用标准 CSS Custom Properties (`--vscode-*`) 打造现代化卡片式布局、原生风格 Switch 开关组件与密码显隐切换。
2. **Tree Provider Layer**: 增强 `JobsTreeProvider` 与 `InstancesTreeProvider`，引入 Jenkins 经典健康度算法（基于最近构建计算 Weather Score）及增强型 Markdown Tooltip 与状态徽标。
3. **Global UX Layer**: 在 `src/extension.ts` 中注册常驻 `vscode.StatusBarItem`，集成当前控制器切换与构建中进度提示；在 `src/commands/buildCommands.ts` 中增加参数历史记忆与构建完成通知。

**Tech Stack:** VS Code Extension API (1.85+), TypeScript, Vanilla CSS3 (with CSS Variables & Animations), Vitest, esbuild.

**Spec / Requirements:**
- 严格遵循 VS Code 官方 Webview UI Guidelines 与设计规范。
- 无缝适配 VS Code Dark / Light / High Contrast 主题。
- 全量国际化（中英文 `l10n` 和 `package.nls.json` 覆盖）。
- 保持 100% 现有单元测试与构建流程绿色通过。

---

## 任务拆解 (Task Decomposition)

### Task 1: Webview 控制器配置表单现代化视觉与交互升级 (Webview Instance Form UI Polish)

**Files:**
- Modify: `webview/jenkins-instance-form/index.css`
- Modify: `webview/jenkins-instance-form/index.ts`
- Modify: `src/webview/JenkinsInstancePanel.ts`
- Modify: `src/webview/html.ts`
- Test: `test/webview/JenkinsInstancePanel.test.ts`

**Interfaces:**
- `renderInstanceForm(options)`: 生成包含 Switch 开关结构、密码显隐按钮与诊断卡片的 HTML。
- `webview/jenkins-instance-form/index.ts`: 处理密码显隐点击事件、URL 智能纠偏与诊断卡片渲染。

- [ ] **Step 1: 编写 Webview HTML 结构与渲染测试**
  在 `test/webview/JenkinsInstancePanel.test.ts` 中补充针对密码显隐按钮、Switch 开关属性以及结构化反馈容器的测试用例。

- [ ] **Step 2: 运行测试验证失败**
  运行: `npx vitest run test/webview/JenkinsInstancePanel.test.ts`

- [ ] **Step 3: 重构 Webview HTML 模板与 CSS 样式**
  - 在 `src/webview/JenkinsInstancePanel.ts` 中更新 HTML 模板：
    - 为 `apiToken` 和 `password` 字段增加显隐切换按钮 `<button type="button" class="password-toggle" ...>`。
    - 将复选框重构为具有无障碍特性的 Switch 组件结构 `<label class="switch-row">...<span class="switch-slider"></span></label>`。
  - 在 `webview/jenkins-instance-form/index.css` 中：
    - 实现 VS Code 风格的 Toggle Switch（平滑滑动动画、选中状态高亮颜色 `var(--vscode-button-background)`、焦点轮廓）。
    - 增加输入框组内嵌按钮样式 `.input-group` 与 `.password-toggle`。
    - 美化卡片式 `.form-panel`、输入框悬浮/聚焦动效。
    - 优化反馈区域 `.form-feedback` 为精致的结构化卡片样式。

- [ ] **Step 4: 编写 Webview 交互逻辑**
  在 `webview/jenkins-instance-form/index.ts` 中：
  - 实现密码/Token 输入框的 `type="password" <-> "text"` 显隐切换。
  - 增加 URL 自动修剪尾部 `/` 及缺失协议时的轻量提示。
  - 支持键盘快捷键 `Cmd+Enter` / `Ctrl+Enter` 快速提交。

- [ ] **Step 5: 运行测试并验证构建**
  运行: `npx vitest run test/webview/JenkinsInstancePanel.test.ts` && `npm run compile`

---

### Task 2: 侧边栏任务树健康度天气图标与类型徽标 (Jobs & Instances Tree Views UX)

**Files:**
- Modify: `src/tree/JobsTreeProvider.ts`
- Modify: `src/tree/InstancesTreeProvider.ts`
- Modify: `src/jenkins/types.ts`
- Test: `test/tree/JobsTreeProvider.test.ts`
- Test: `test/tree/InstancesTreeProvider.test.ts`

**Interfaces:**
- `calculateWeatherScore(builds: BuildSummary[]): { icon: string; text: string; score: number }`
- `JenkinsJobTreeItem.description`: 格式化展示任务类型 `[Pipeline]` / `[Freestyle]` / `[Multibranch]` 与健康度得分。
- `JenkinsInstanceTreeItem`: 优化 Tag 徽标展示与 Markdown Tooltip。

- [ ] **Step 1: 编写健康度算法与树节点格式化单元测试**
  在 `test/tree/JobsTreeProvider.test.ts` 中增加天气健康度计算测试（100% 晴天、80% 晴间多云、40% 雨天、0% 暴风雨）与类型徽标解析测试。

- [ ] **Step 2: 运行测试验证失败**
  运行: `npx vitest run test/tree/JobsTreeProvider.test.ts`

- [ ] **Step 3: 实现健康度算法与 Job 节点视觉增强**
  - 在 `src/tree/JobsTreeProvider.ts` 中：
    - 增加 `calculateWeatherScore` 函数，根据历史构建计算通过率与对应天气图标（`sunny`, `cloudy`, `rain`, `thunderstorm` 对应的 ThemeIcon / emoji）。
    - 为 `JenkinsJobTreeItem` 添加富文本 Description（如 `[Pipeline] • ☀️ 100%` 或构建中动态耗时）。
    - 丰富 Tooltip，展示完整健康度百分比、最后成功/失败构建详情。
  - 在 `src/tree/InstancesTreeProvider.ts` 中：
    - 优化控制器节点 description 徽标与 Tooltip 布局。

- [ ] **Step 4: 运行测试验证**
  运行: `npx vitest run test/tree/JobsTreeProvider.test.ts test/tree/InstancesTreeProvider.test.ts`

---

### Task 3: 全局状态栏常驻指示与构建完成智能通知 (Status Bar & Notifications)

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/commands/buildCommands.ts`
- Create: `src/utils/statusBar.ts`
- Test: `test/utils/statusBar.test.ts`
- Test: `test/commands/buildCommands.test.ts`
- Test: `test/extension.test.ts`

**Interfaces:**
- `class JenkinsStatusBarManager`: 管理 VS Code 底部状态栏（显示活跃控制器，支持点击快捷切换；构建中时显示旋转动画与已耗时）。
- `notifyBuildCompletion(jobFullName: string, buildNumber: number, result: string, durationMs: number)`: 构建完成时弹出 Toast 并提供快捷按钮。

- [ ] **Step 1: 编写状态栏管理器与通知逻辑的单元测试**
  在 `test/utils/statusBar.test.ts` 中编写状态栏文本更新、点击命令与构建状态切换的测试。

- [ ] **Step 2: 运行测试验证失败**
  运行: `npx vitest run test/utils/statusBar.test.ts`

- [ ] **Step 3: 实现 JenkinsStatusBarManager**
  在 `src/utils/statusBar.ts` 中实现：
  - 默认展示 `$(radio-tower) Jenkins: [控制器名称]`，绑定 `atJenkins.setActiveInstance` 命令。
  - 当触发构建或检测到正在构建时，切换为 `$(sync~spin) Jenkins: [Job名称] #[构建号] (耗时)`，点击打开该构建日志。
  - 销毁与资源释放管理。

- [ ] **Step 4: 实现构建结束智能通知**
  在 `src/commands/buildCommands.ts` 中：
  - 在触发构建成功后，若用户选择跟踪，在构建完成时展示 `vscode.window.showInformationMessage` / `showErrorMessage`，带有 `[查看日志]` 与 `[在 Jenkins 中打开]` 动作按钮。

- [ ] **Step 5: 集成至 extension.ts 并运行全量测试**
  运行: `npx vitest run`

---

### Task 4: 参数化构建历史记忆与交互优化 (Parameterized Build UX)

**Files:**
- Modify: `src/commands/buildCommands.ts`
- Test: `test/commands/buildCommands.test.ts`

**Interfaces:**
- `getRecentParameters(context: BuildCommandsContext, jobFullName: string)`
- `saveRecentParameters(context: BuildCommandsContext, jobFullName: string, params: Record<string, any>)`
- 触发参数化构建时，若存在上次填写的历史参数，在确认对话框或首个步骤提供“使用上次参数 (Use Recent)”快捷选项。

- [ ] **Step 1: 编写参数历史记忆单元测试**
  在 `test/commands/buildCommands.test.ts` 中测试参数缓存保存、读取与一键复用逻辑。

- [ ] **Step 2: 运行测试验证失败**
  运行: `npx vitest run test/commands/buildCommands.test.ts`

- [ ] **Step 3: 实现参数历史记忆与快速复用流**
  - 利用 `context.configManager` 或 `globalState` 存储各 Job 的最近一次成功构建参数。
  - 在 `triggerBuildHandler` 中提示：若有历史参数，提供 `[使用上次参数]` / `[修改参数]` / `[使用默认参数]` 选项，大幅降低反复输入多参数的摩擦。

- [ ] **Step 4: 运行测试验证**
  运行: `npx vitest run test/commands/buildCommands.test.ts`

---

### Task 5: 国际化词条同步与全链路构建验证 (i18n & Smoke Build Verification)

**Files:**
- Modify: `package.nls.json`
- Modify: `package.nls.zh-cn.json`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.zh-cn.json`
- Modify: `src/i18n/t.ts`
- Test: `test/i18n/nls.test.ts`
- Test: `test/i18n/t.test.ts`

- [ ] **Step 1: 补充所有新增 UI 文案至中英文语言包**
- [ ] **Step 2: 运行全量测试套件**
  运行: `npm test`
- [ ] **Step 3: 运行 TypeScript 语法检查与打包构建**
  运行: `npm run typecheck` && `npm run compile`

---

## 验证计划 (Verification Plan)

### 自动化测试 (Automated Tests)
- `npm test`：运行全量 Vitest 单元测试（确保所有测试通过，包含新增的 Webview、StatusBar、WeatherScore、RecentParams 测试）。
- `npm run typecheck`：验证 TypeScript 类型无任何报错。
- `npm run compile`：验证 esbuild 顺利打包 `dist/extension.js` 和 `dist/webview/jenkins-instance-form.js`。

### 人工验证 (Manual Verification)
1. 打开 Webview 控制器表单，确认 Switch 开关动效平滑，点击密码显隐按钮能够正常切换明文/密文。
2. 查看左侧任务树列表，确认 Job 节点能清晰看到天气图标、健康度描述与任务类型徽标。
3. 观察 VS Code 底部状态栏，确认当前控制器名称正确常驻，点击能唤起控制器切换列表。
4. 触发一次多参数构建，验证参数历史记忆与构建完成提示功能。
