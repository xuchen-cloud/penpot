# Penpot Desktop 项目状态与后续计划

更新日期：2026-09-06

本文是 Penpot Desktop 离线安装版的统一状态与规划文档。后续开发应先更新本文，再开始下一项工作。`ROADMAP.md`、`DELIVERY.md` 和兼容性报告可保留为历史和技术资料，但项目进度、执行顺序和交付判断以本文为准。

## 1. 目标与首版边界

目标是交付可在目标机器上一键安装、首次启动和日常使用的 Penpot Desktop：

- 不依赖 Docker、Kubernetes、WSL 或系统预装的 Java、Node.js、PostgreSQL、缓存服务和浏览器。
- 安装和运行时不下载依赖；断网时仍能完成核心设计工作。
- 首发支持 macOS 14+ Apple Silicon 和 Windows 11 x86-64。
- 使用 Tauri 2 作为桌面壳，所有服务作为随包原生进程运行。
- PostgreSQL 15、JRE、Node.js、Chromium、媒体工具和 Penpot 构建产物全部随安装包提供。
- macOS 使用 Valkey；Windows 先验证 Garnet。若 Garnet 不能满足队列、Pub/Sub 或 Lua 需求，再评估可维护的 Windows Valkey 构建。

首版不支持 Intel Mac、Windows 10、Linux 安装包、高可用、现有 Docker 数据库直接迁移、在线自动更新、第三方登录和邮件服务。数据交换先使用 `.penpot` 导入与导出。

## 2. 当前结论

项目已经完成桌面运行基础、本地服务编排的大部分代码、网关、凭据存储和 macOS 打包脚本。Windows x64 运行时已完成组装、DLL 审计和完整性锁校验，并已产出未签名 NSIS 工程包。

因此当前状态是“阶段二开发中”，不能称为“已交付”或“可离线安装使用”。单元测试通过只说明模块行为可用，不代表真实安装包已通过冷启动和断网验收。

## 3. 上一个任务为何停止

Codex 任务 `Penpot Desktop：交付可离线安装使用的软件包` 当前为 idle。

- 最后一个有内容的运行因 Codex 用量上限失败。
- 后续三次续跑均被中断，且没有产出新的消息。
- 这不是应用代码崩溃，也不是文件丢失。
- 所有阶段二改动已在分支 `codex/desktop-stage2-local-stack` 完成审查并保存为提交。

检查时发现两套流程重复获取同一 Node 压缩包。审查时已停止进度较少的
`prepare-macos.mjs` 流程；另一套随后也因网络中断退出，未通过校验的部分
下载仍留在 `/tmp`，当前没有重复下载进程。

## 4. 已完成内容

### 4.1 已提交的基础

- Tauri 工作区、桌面配置、托盘菜单和应用数据目录。
- macOS 与 Windows 目标的运行时 manifest 校验。
- 回环端口预留和静态网关健康检查。
- 子进程启动、独立日志、失败回滚、正常关闭和进程树约束。
- 首位管理员邮箱采集，不把凭据写入普通桌面配置。
- macOS 和 Windows Rust CI 工作流。

相关提交：

- `66510da64f`：Desktop runtime foundation。
- `0851644c04`：Desktop native compatibility gate。

### 4.2 当前分支中已实现

#### 运行时完整性

- 运行时 manifest 支持 macOS ARM64 和 Windows x64。
- `runtime-lock.json` 对完整运行时树做 SHA-256 校验。
- 能发现文件被修改、增加、删除，以及逃出运行时目录的符号链接。
- 打包前强制校验运行时；缺少 PostgreSQL、JRE、前端、Exporter、Chromium 或媒体工具时拒绝生成安装包。

#### 本地服务与安全配置

- 生成 PostgreSQL、Valkey/Garnet、Media Processor、Backend 和 Exporter 的跨平台启动配置。
- 所有可执行文件使用随包绝对路径。
- 所有内部服务只绑定 `127.0.0.1`。
- PostgreSQL 使用随包 `pg_ctl` 正常关闭。
- 修正 Windows PostgreSQL 不应使用 Unix `-k` 参数的问题。
- Valkey/Garnet 使用密码认证；缓存密码不放在命令行参数中。
- Backend 与 Exporter 的共享管理密钥已统一。

#### 凭据、初始化和生命周期

- 用 `keyring` 封装 macOS Keychain 和 Windows Credential Manager。
- 数据库密码、缓存密码、Penpot secret、媒体处理密钥和管理密钥只生成一次并复用。
- 密钥不写入 `desktop.json`。
- 临时缓存配置文件使用收紧的权限。
- 支持 PostgreSQL 初始化、幂等建库、按依赖顺序启动、TCP/HTTP readiness、失败回滚和反序关闭。
- Tauri 的初始化、启动、状态查询和退出命令已经接入本地运行时。
- 加入每用户实例锁和 Tauri single-instance；第二次启动应聚焦已有窗口。

#### 网关与界面

- Rust 网关可提供静态前端和运行时生成的前端配置。
- 支持 Backend 与 Exporter 路由反向代理。
- 支持 WebSocket upgrade。
- 支持受限的 `X-Accel-Redirect` 本地资源响应、Range 请求和请求体上限。
- 启动界面已接入初始化、运行状态和进入 Penpot 的动作。

#### 构建与打包脚本

- 已写 macOS 的准备、源码构建、运行时组装、动态库重定位、全树校验和 Tauri 打包入口。
- 已写运行时元数据文件。
- Backend JAR 和 Media Processor 构建曾成功。
- 已安装并验证部分本机构建工具，包括临时 Emscripten、字体和图像工具。

## 5. 当前验证结果

2026-09-06 在保留改动的 worktree 中重新检查：

- `cargo test --locked`：57 项通过，0 项失败，2 项忽略。
- `git diff --check`：通过。
- `cargo clippy --locked --all-targets -- -D warnings`：通过。
- `cargo fmt -- --check`：通过。
- 47 项 Desktop Node 单元测试、JavaScript 脚本语法、PowerShell 语法和相关 JSON 解析：通过。
- Windows 统一源码构建完成两轮独立全量构建；两轮各含 6 个组件和 810 个声明文件，文件集合、大小、SHA-256、来源与工具链清单一致。
- macOS 14 CI 已配置共享 Node/Rust 检查，但当前功能分支尚无 macOS 实跑记录，状态为“已配置，待验证”。
- Windows x64 运行时已生成，PE 导入审计通过（691 个二进制、0 个未解析 DLL），运行时锁校验通过。
- Windows 运行时已剔除源码映射、调试/链接文件、测试数据和重复 ImageMagick 命令，体积由约 2.0 GB 降至约 1.67 GB。
- NSIS 构建已产出约 0.79 GiB 的未签名工程安装器，并生成 SHA-256、许可证清单、CycloneDX SBOM 和来源证明。

## 6. 当前卡点

### 6.1 Render WASM 已完成可复现构建闭环

- 已固定 Rust 1.91.0、Emscripten 4.0.6（`1ddaae4d`）和 Skia 版本。
- Windows 默认读取 `D:\Program Files\emsdk`，不运行会改写 SDK 目录的环境脚本。
- Frontend 与 Exporter 均从两个独立输出目录构建并通过真实模块加载测试。
- 路径重映射移除了构建机和输出目录绝对路径，两轮 JS 与 WASM 哈希逐项一致。
- Frontend WASM SHA-256 为 `3696c94d2f3167a5476d969f00f6e9581b64877531e8de70e818ab562ec5dadb`。
- Exporter WASM SHA-256 为 `47f610db8d48ff822d111a4fe3a7b56605a877c478315e1ec1b90559ee3626a8`。

### 6.2 共享下载缓存已实现

- 默认持久化目录为 `desktop/.cache/runtime-downloads/`，打包不会重复下载已校验文件。
- 网络下载前先检查 `D:\project\tools\downloads`，仅导入 SHA-256 匹配的安装包。
- 已实现断点续传、连接与停顿超时、有限重试、同文件系统原子提交和按目标加锁。
- 下载与锁行为已有 Windows/macOS 共用的 Node 测试，CI 在两个系统运行。

### 6.3 没有真实安装包验收

目前没有完整运行时、`.app`、`.dmg`、`.msi` 或 `.exe`。以下关键路径均未在干净机器上验证：

- 首次冷启动与数据库迁移。
- 首位管理员注册。
- 新建设计、保存、退出、重启和重新打开。
- WebSocket 编辑。
- 图片和字体上传。
- `.penpot` 导入导出。
- PNG、JPEG、WebP、SVG 和 PDF 导出。
- 完全断网运行及无意外公网请求。

### 6.4 Windows Issue #2 实施状态

- 已固定 PostgreSQL 15、Node 24.19、JRE、Chromium、WebView2、ImageMagick、Potrace、FontForge、Garnet 与 WOFF 构建输入的 Windows x64 来源和 SHA-256。
- 已实现 owner-only 保护 ACL，并在本机真实 Windows ACL 上通过聚焦测试；Credential Manager 增加真实写入、读取、删除探针。
- 已加入 PostgreSQL 强制终止、恢复重启和数据持久性兼容步骤；现有 Job Object 负责整棵子进程树的退出约束。
- 已实现 Windows 原子准备与组装、完整 PE 普通/延迟导入 DLL 审计、末尾运行时锁、current-user NSIS 与固定 WebView2 离线安装器。
- 已实现安装包 SHA-256、许可证清单、CycloneDX SBOM、来源证明和 Authenticode 发布门禁；无签名包只标为工程包。
- 已加入干净机 PowerShell 验收框架，覆盖凭据、ACL、全兼容计划、非回环 TCP、升级/失败和卸载保留数据。
- 兼容性计划已启动 PostgreSQL、Garnet、Media Processor、Backend 和 Exporter，并通过迁移、缓存、字体和 Chromium 检查；导出步骤因缺少五个真实请求 fixture 和有效本地会话而停止。
- 尚需解决 NSIS 大包限制、提供真实导出 fixture，并在独立干净 Windows 11 x64 机器上执行验收；完成前不能称为发布包。

## 7. 下一步执行顺序

2026-09-06 续作结果：Issue 1 的 Windows 统一源码构建、两轮完整产物比较、
缓存与校验测试均已通过。Windows Clojure 参数、前端外部 `rsync`、插件 runtime
隐式构建、JAR 时间、编译期随机字体 UUID 和 Shadow 并行分析导致的不稳定均已修复。
完整日志位于 `.ci-logs/issue-1-*`，共享产物位于
`desktop/target/shared-artifacts-repro-{a,b}`。下一项仓库开发工作是 Issue 2；
macOS 完整源码构建仍需 macOS 主机或获准的 CI 运行。下列 P0–P7 保留为整体产品路线。

Issue #1 的当前实施方案见 `ISSUE-1-IMPLEMENTATION-PLAN.md`。执行以 Windows
为首个开发和验证环境，共用下载、锁、产物清单和 Render WASM 接口从第一步
起保持 macOS 兼容，并在两个目标的 CI 中验证。

### P0：保存断点并恢复干净执行环境（已完成）

- 已复核 diff，移除无关代理规则和失败的 Render WASM 实验参数。
- 已停止重复下载流程，只保留一个带校验的有效流程。
- 已修复 Clippy 问题，并通过 Rust 测试、Clippy、格式、脚本语法、JSON
  解析和 `git diff --check`。
- 已为代理请求体限制、动态前端配置和公共端口占用补充测试。
- 已按仓库提交规范保存本地栈、网关与打包脚本。

完成条件：工作树内容可复现、检查全绿、没有重复后台任务，且阶段二成果有清楚的提交边界。

### P1：单独解决 Render WASM 构建

- 读取 Render WASM 模块记忆与现有 CI 构建方式。
- 找到仓库当前支持的 Rust 与 Emscripten 版本组合。
- 对齐 exception 与 longjmp 参数，撤销无依据的 `_build_env` 临时修改。
- 单独构建前端和 Exporter 的 WASM，并验证输出可加载。
- 把工具链检查和固定版本写入 `build-sources.mjs`。

完成条件：全新构建目录中可稳定生成两个 WASM，重复两次结果一致，失败时给出明确缺项。

### P2：让 macOS 准备和源码构建可重复

- 为 Node、Chromium、JRE 和其他归档加入缓存、校验、有限重试与并发锁。
- 记录每个组件的版本、来源、许可证、目标、校验和与构建方法。
- 完成 Backend、Frontend、两个 WASM、Exporter 和 Media Processor 的一次统一构建。
- 确认目标机不需要 pnpm、Maven、Playwright 或其他在线下载。

完成条件：`prepare-macos` 和 `build-sources` 在清理构建输出后仍能一次通过，重复运行能安全复用缓存。

### P3：产出首个 unsigned macOS ARM64 开发包

- 收集 PostgreSQL 15、Valkey、JRE、Node.js、Chromium、字体和媒体工具。
- 完成可重定位复制和 dylib/rpath 修正。
- 生成完整运行时锁并校验所有文件。
- 执行 assemble、relocate、lock、Tauri package。
- 生成 unsigned `.app` 和开发 DMG；此阶段不把它称为发布包。

完成条件：安装包能复制到未安装开发工具的干净目录，并在断网时启动到首次设置界面。

### P4：macOS 本地栈闭环

- 从空数据目录初始化 PostgreSQL 并运行全部迁移。
- 创建管理员账号，进入编辑器，新建设计并保存。
- 退出应用，确认没有残留子进程；重启后重新打开设计。
- 验证网关、WebSocket、资源 Range、图片与字体处理。
- 验证五种导出格式和 `.penpot` 导入导出。
- 补齐失败组件、脱敏日志、重试、打开日志目录和安全退出界面。

完成条件：干净 macOS 主机在断网条件下通过首次启动、编辑、保存、退出和重启恢复。

### P5：Windows 对等实现

- 准备并固定 Windows x64 所有运行时。
- 实现并验证 Credential Manager、owner-only ACL 和 Job Object。
- 完整验证 Garnet 兼容性；失败时作出 Valkey 替代决策。
- 完成 Windows 运行时组装和 NSIS 安装。
- 在 Windows 11 干净机上重复 macOS 的首次使用、重启、故障和卸载保留数据测试。

完成条件：Windows 11 断网安装和核心使用流程通过，退出后无残留进程。

### P6：离线产品行为与数据安全

- 完成首位管理员与邀请注册流程。
- 默认关闭 telemetry、外部身份、邮件、Webhook 和其他公网集成。
- 随包提供模板、字体、插件和帮助内容，移除公网回退。
- 限制桌面导航和 Exporter 浏览器请求到允许的本地来源。
- 加入崩溃恢复元数据。
- 升级前备份 PostgreSQL 和 assets；校验备份并提供恢复工具。
- 支持签名的完整离线升级包，不原地替换单个运行时组件。
- 卸载默认保留用户数据；只有用户明确选择时才删除。

完成条件：异常退出、升级失败和恢复流程不会破坏用户数据，默认模式无后台公网请求。

### P7：发布验收

- 构建并公证 macOS DMG，签名 Windows NSIS。
- 固定应用标识、Windows upgrade GUID 和版本规则。
- 生成许可证报告、SBOM、安装包校验和与构建来源证明。
- 在两平台执行完整离线端到端用例和异常用例。
- 抓取 DNS/TCP 请求，发现非预期公网访问时直接失败。
- 验证端口冲突、磁盘不足、数据库失败、进程强杀、二次启动、迁移失败、恢复和重装保留数据。

完成条件：签名安装包在干净且断网的目标系统通过全部发布门禁。

## 8. 长任务执行规则

构建、下载、安装依赖、打包和端到端测试均按长任务处理：

- 启动前说明任务内容、预估耗时、输出日志路径和成功条件。
- 把等待和低频状态检查交给 Luna 子代理。
- 首次检查安排在预计完成时间附近；没有新信息时拉长检查间隔。
- 禁止多个代理重复启动同一个下载或流水线。
- 长命令把完整输出写入日志文件，不能把测试输出直接管道给 `head`、`tail` 或 `grep`。
- 主代理继续做不依赖该结果的工作，不做高频轮询。
- 超时后先检查进程、日志更新时间和产物大小，再决定等待、修复或停止；不能盲目重启。

建议默认检查间隔：

- Rust 单测或 Clippy：预计 1 分钟，约 1 分钟后检查。
- 单个源码模块构建：预计 5–15 分钟，约 10 分钟后首次检查。
- 完整源码构建：预计 20–60 分钟，约 30 分钟后首次检查。
- 运行时下载与组装：按文件大小和当前速度估算，通常 20–90 分钟；到预计完成时间的 80%–100% 再检查。
- 完整安装包与离线端到端：预计 30–120 分钟，按阶段事件低频检查。

## 9. 发布硬门禁

以下条件全部满足前，不能对外称“可交付”：

- 目标机不需要开发工具或运行时下载。
- 所有私有服务只监听 loopback；LAN 模式只暴露网关。
- 密钥随机生成并保存在系统凭据存储中。
- 用户数据在签名只读程序目录之外，且仅当前用户可读写。
- macOS 和 Windows 均通过首次安装、注册、编辑、保存、退出和重启恢复。
- 图片、字体、`.penpot` 导入导出和五种渲染导出通过。
- 完整退出不留下子进程。
- 默认离线模式没有非预期公网 DNS/TCP 请求。
- 备份、恢复、升级失败处理和卸载数据保留通过。
- 安装包有签名、校验和、许可证、SBOM 和构建来源证明。

## 10. 下一次继续时的第一组动作

1. 在新任务中读取 Issue 2 及相关模块记忆，保留 Issue 1 的共享构件契约。
2. 以 Windows x64 为先实现对应平台工作，不把安装包工作倒灌进 Issue 1。
3. 在可用的 Apple Silicon 主机或获准 CI 上补充 Issue 1 的 macOS 统一源码构建证据。
