# Issue 1：Luna 续作计划

> 状态：已执行。Windows 最终双轮统一源码构建和完整清单比较通过；
> macOS 共享检查已配置但尚无本功能分支实跑记录。本文其余内容保留为执行记录。

核对日期：2026-09-06。仓库：`D:\project\penpot`。
分支：`codex/issue-1-reproducible-desktop-artifacts`。

## 当前事实

- 当前功能改动仍在工作树，包含未跟踪的新文件；尚未完成提交和推送。
- 本次进程检查未发现该任务的 Java、Cargo、Rust 或 Node 构建仍在运行。
- 共享下载缓存、产物清单及校验、macOS 准备接口、WASM 构建入口已实现。
- Frontend 和 Exporter WASM 各有两轮独立构建及真实加载通过记录，JS/WASM 哈希一致。
- 历史日志记录 Node 全量测试 41 项通过；此后又增加了聚焦用例，最终全量结果待更新。
- 历史 Rust 检查记录：57 项通过、2 项忽略，Clippy 和格式检查通过。
- 统一源码构建失败在 `common` 的 `-T:build compile`，错误为
  `Key is missing value: compile`。当前未产出可验收的完整共享产物。
- Windows/macOS Node CI 已写入工作流，但本地 Windows 记录不能代替 macOS 运行结果。
- 本轮只核对文件与已有日志，没有重跑构建或测试。

## 执行范围与资料

目标是完成 Issue 1 的共享源码产物、持久化下载和可复现构建。
Windows 优先；共享模块保持 macOS 可用。Windows 运行时组装、NSIS、
macOS 签名、公证和 DMG 属于后续平台任务。

开始前读取 `AGENTS.md`、`.serena/memories/critical-info.md`，以及
`common`、`backend`、`frontend`、`exporter`、`media-processor`、
`render-wasm` 的 core memory 和相关测试记忆。另读：

- `desktop/ISSUE-1-IMPLEMENTATION-PLAN.md`
- `desktop/packaging/build-sources.mjs`
- `desktop/packaging/invoke-clojure-windows.ps1`
- `desktop/packaging/toolchains.json`

保留现有改动和缓存。只使用 `xuchen-cloud/penpot` 进行仓库远端操作。
不要访问上游 `penpot/penpot`。长任务按仓库规则估计单次运行时间、写完整日志、
低频检查；每个任务只启动一份进程。无需给开发工作安排“开发日”。

## 1. 修通 Windows Clojure 参数传递

先检查 `.ci-logs/issue-1-build-sources-a.log`、
`.ci-logs/issue-1-clojure-windows-verbose.log` 和
`common/.cpcache/A8711069C3EEF3F9B87456A7C9752365.basis`。
失败记录中的 basis 没有应用构建 alias；这是线索，尚不是最终根因。

按调用边界逐层检查：Node 参数数组 → `powershell.exe -File` → 适配器
`$args` → `$normalized` → `Invoke-Clojure` → Java 参数。
本地 ClojureTools 模块对 `-T:`、`-M:`、`-X:` 有拆分参数分支。
当前适配器已拆分组合参数，但仍失败；不要重复提交同一种修法。

先用无编译的 alias/classpath 检查证明 `:build` 生效，再单独编译 common。
可评估 `-M:build` 加显式 `build/compile` 调用作为替代，但必须验证
`build.clj` 可定位、tools.build 在 classpath 中、表达式和退出码完整传递。
`-T` 与 `-M` 的路径语义不同，不能机械替换后直接运行完整流水线。
优先将 Windows 差异限制在适配器内；不用修改下载的 ClojureTools 模块来修项目。

成功条件：

- common 独立编译退出码为 0，产生预期 class 文件。
- backend 的构建 alias 可用，后续 `jar` 命令能调用正确函数。
- `-M:dev:shadow-cljs` 多 alias 能正确传入。
- 对含空格工具路径、alias 传递和失败退出码补有意义的回归检查。

如果失败，保存完整 argv 的无敏感信息诊断与最新 basis；定位差异后才重试。

## 2. 对齐工具链与缓存的真实行为

本机已知入口：

- Emscripten 4.0.6（`1ddaae4d`）：`D:\Program Files\emsdk`。
- 安装归档来源：`D:\project\tools\downloads`，只读复用并校验 SHA-256。
- Node：`D:\project\tools\nodejs\node.exe`。
- ClojureTools：`desktop/.cache/toolchains/clojure-1.12.5.1664/ClojureTools/`。
- JDK、Corepack、Maven 等已放在 `desktop/.cache/`；先检查已有内容。

`toolchains.json` 声明模块 pnpm 12.0.0、根 pnpm 11.20.0。
此前尝试使用 11.20.0 的 JS 入口，不能把它当成已符合模块版本要求。
核对每个模块实际运行的 pnpm 版本及嵌套脚本调用；修复入口或下载来源，
避免悄悄降级、改锁文件或把未实际使用的版本写入产物清单。
同样核对 Java、Clojure 和 Node 的实际版本，失败应尽早报错。

检查 frontend 的 `postinstall`（含分号的 shell 命令）和构建脚本的子进程调用，
验证 Windows 默认 shell 能执行，且嵌套 pnpm 使用正确入口。
按失败证据修兼容问题，不批量改写无关模块。

缓存验收不能只看设置了环境变量：日志显示 Clojure classpath 缓存实际使用
模块 `.cpcache`，basis 还引用用户目录 `.gitlibs`。
确认 CLI 的实际缓存选择；将新 Git 依赖缓存设为项目内位置，允许复用已有缓存，
不删除用户缓存。同步文档中的路径描述。

成功条件：工具版本与清单一致；嵌套构建入口可用；依赖缓存持久化且位置可解释。

## 3. 完成一次统一源码构建

步骤 1、2 通过后才调用 `desktop/packaging/build-sources.mjs`。
使用项目 Node 和经验证的工具入口。命令覆盖变量支持 JSON 参数数组：
`PENPOT_BUILD_PNPM_COMMAND`、`PENPOT_BUILD_CLOJURE_COMMAND`。
默认 Windows Clojure 适配器修通后无需覆盖。

设置 `PENPOT_BUILD_EMSDK`，并将首轮输出指定为：

- `PENPOT_SHARED_ARTIFACT_OUTPUT=D:\project\penpot\desktop\target\shared-artifacts-repro-a`
- `PENPOT_RENDER_WASM_TARGET_DIR=D:\project\penpot\desktop\.cache\build\render-wasm\source-a`

源码构建依次通过 common、backend、依赖安装、两个 WASM、frontend、exporter、
media-processor，最后生成共享清单。完整输出保存到新的 `.ci-logs/` 文件。
任何阶段失败，先复现该阶段，不直接重启整套构建。

成功条件：入口退出码为 0，日志返回的共享产物目录可通过：

```powershell
& 'D:\project\tools\nodejs\node.exe' desktop/packaging/verify-shared-artifacts.mjs '<日志返回的产物目录>'
```

## 4. 完成全量可复现性验证

首轮通过后，冻结源码、工具版本、版本号与构建输入，再跑 B 轮。
使用 `shared-artifacts-repro-b` 和 `source-b`，保留 A 轮产物作为比较基线。
仅改变最终 staging 目录不等于独立干净构建：必须梳理各模块生成文件、
Shadow 缓存和中间输出，隔离或清理生成内容，保留下载缓存及受版本控制的资源。
递归清理前验证绝对路径与 Git 跟踪状态，不删除整个工作区或 `.cache`。

运行：

```powershell
& 'D:\project\tools\nodejs\node.exe' desktop/packaging/verify-shared-artifacts.mjs '<A产物目录>' '<B产物目录>'
```

如果不一致，列出差异文件，检查 JAR 条目时间、生成时间、路径、文件遍历顺序、
构建版本和旧输出混入。这些是排查方向，当前尚未证实发生。
不能删除清单中的差异文件或放松哈希检查来通过验收。

清单目前默认记录 `git rev-parse HEAD`，工作树却有未提交实现。
交付前必须让产物来源能还原实际构建代码：选择固定源码提交进行最终验证，
或实现明确的 dirty/source digest 记录。不要把旧 HEAD 当作包含全部改动的来源证明。

成功条件：两轮文件集合、大小、SHA-256 及清单一致，来源和构建输入有记录。
不要求 Windows 与 macOS 编译出的全部字节相同；需要两平台能消费同一产物契约。

## 5. 最终检查和 macOS 证据

- 在 `desktop/` 执行 `node --test packaging/*.test.mjs ui/*.test.mjs`，
  输出先写文件再读取，记录最终数量。
- 对修改的脚本运行语法检查；校验 JSON 和 `git diff --check`。
- 结合最终代码是否变化决定复跑 Rust 测试、Clippy 和格式检查，保留退出码。
- 检查清单安装、重复执行缓存命中、校验失败和路径兼容用例。
- 核对 `.github/workflows/tests-desktop.yml` 的 Windows/macOS 实际运行结果。
  该工作流不会因推送普通功能分支自动运行；需要使用获准的 CI 触发方式或 macOS 主机。
  无运行记录时标记“已配置，待验证”，不能写“macOS 已通过”。

已通过的独立 WASM 日志位于 `.ci-logs/issue-1-render-wasm-final-*.log`。
除非构建代码、工具链或输入发生变化，无需先重做这四次诊断构建。

## 6. 保存结果并交接

更新实施计划和 `PROJECT_STATUS.md`，区分“已实现”“已验证”和“待验证”。
记录命令、日志、产物目录、哈希、已知限制及最后通过的步骤。

功能完成后按 `mem:workflow/creating-commits` 保存提交并默认推送功能分支。
提交前读该记忆；推送前执行 `git remote get-url origin`，核对
`xuchen-cloud/penpot`、当前分支、工作树状态，使用显式远端和 refspec。
不自动合并 develop，不自动创建 Issue 或 PR。

如果缺少外部条件，保存确切失败证据和可继续的命令，说明缺什么。
完成 Issue 1 的判断必须基于完整产物验证，不能用单测通过替代。

## 可直接交给 Luna 的指令

> 继续 `D:\project\penpot` 的 Issue 1，执行
> `desktop/ISSUE-1-LUNA-HANDOFF.md`。从步骤 1 的 Windows Clojure 参数问题开始，
> 保留当前功能分支、未提交改动和全部持久化下载缓存。
> 每步达到成功条件后再进入下一步；失败先做最小复现。
> 完成统一源码构建、两轮完整产物比较、必要检查和文档更新，
> 然后按仓库规范提交并推送功能分支。Windows 优先并保留 macOS 兼容性；
> 不扩展到安装包开发。报告真实结果和缺项，不再给开发日估算。
