# Windows 桌面版构建与维护指南

本文供后续维护者和 agent 在 Windows 11 x64 上重建 Penpot Desktop。它说明完整构建流程、代码更新后的影响检查，以及已知故障的处理方法。

构建过程可以联网下载校验过的源码包、工具和锁文件中的依赖。最终安装器和安装后的应用不得下载运行时依赖。

## 1. 发布边界

一次完整 Windows 交付包含四层结果：

1. 可复现的 Penpot 共享产物：Frontend、Backend、Exporter、Media Processor、Render WASM 等。
2. 自包含的 Windows 运行时：PostgreSQL、Garnet、JRE、Node.js、Chromium、图像和字体工具，以及 Penpot 产物。
3. current-user NSIS 安装器，其中嵌入 WebView2 离线安装器。
4. SHA-256、许可证清单、CycloneDX SBOM、来源证明和原生兼容性报告。

未签名安装器只能标记为工程包。发布合格还要求有效 Authenticode 签名、真实导出 fixture 的完整兼容性报告，以及独立干净 Windows 11 x64 机器上的安装、升级、断网运行和卸载验收。

## 2. Agent 执行规则

- 先确认当前 worktree、分支和 `origin`。所有仓库操作只针对 `xuchen-cloud/penpot`，不得查询或操作被禁止的上游仓库。
- 开始长构建前，先验证命令、参数、共享产物目录和工具路径。长构建只启动一份，按预计阶段低频查询。
- 所有测试和构建输出先完整写入日志文件，再读取日志。不要把命令输出直接送入 `head`、`tail` 或 `grep`。
- 不要删除或覆盖不属于本次构建的工作目录。组装脚本本身使用随机 staging 目录和原子替换。
- 缓存可以复用，但每个输入仍须通过 SHA-256 或锁文件校验。不要用关闭校验、删除锁文件或改用浮动版本来绕过失败。
- 兼容性运行每次使用新的绝对工作目录。`initdb` 不接受已有数据库目录。
- 构建失败后先读完整日志和失败阶段，不要重复启动相同长任务。

## 3. 构建机要求

- Windows 11 x64。
- Visual Studio 2022 C++ Build Tools，包含 MSVC x64 工具链和 Windows SDK。
- Git、Node.js、pnpm、Rust/Cargo 和 PowerShell。
- Render WASM 使用 Emscripten 4.0.6。默认路径为 `D:\Program Files\emsdk`，其他位置通过 `PENPOT_BUILD_EMSDK` 指定。
- 足够的磁盘空间。运行时约 1.67 GB，安装器约 0.85 GB；构建缓存、Rust target、共享产物和 NSIS 临时文件还会占用数 GB。
- 构建时可访问锁文件和元数据声明的来源。安装与运行验收阶段应断开公网。

先从仓库根目录确认环境：

```powershell
git status --short
git branch --show-current
git remote get-url origin
node --version
pnpm --version
cargo --version
```

`origin` 必须是 `https://github.com/xuchen-cloud/penpot.git` 或该仓库的等价 SSH 地址。

## 4. 缓存和环境变量

默认缓存位于 `desktop/.cache/`：

- `runtime-downloads/`：带 SHA-256 校验的运行时下载。
- `pnpm-store/`、`pnpm-state/`、`corepack/`：Node 依赖和 pnpm 状态。
- `m2/`、`clojure-config/`、`clojure-cache/`、`gitlibs/`：Clojure 构建依赖。
- `runtime-prepared/x86_64-pc-windows-msvc/`：已解压或已构建的 Windows 运行时输入。

常用覆盖变量：

```powershell
$env:PENPOT_DESKTOP_DOWNLOAD_CACHE = "D:\cache\penpot-runtime-downloads"
$env:PENPOT_DESKTOP_DOWNLOAD_SOURCE = "D:\cache\verified-downloads"
$env:PENPOT_PNPM_STORE = "D:\cache\pnpm-store"
$env:PENPOT_PNPM_STATE = "D:\cache\pnpm-state"
$env:PENPOT_COREPACK_HOME = "D:\cache\corepack"
$env:PENPOT_BUILD_EMSDK = "D:\Program Files\emsdk"
```

当 PATH 中的 pnpm 不是项目要求的版本时，指定已验证的 pnpm 12 可执行文件：

```powershell
$env:PENPOT_BUILD_PNPM = "D:\tools\pnpm\12.0.0\pnpm-native.exe"
```

组装 Media Processor 和 Exporter 时会运行 `pnpm install --prod --frozen-lockfile`。允许它在构建机上补齐 pnpm store 中缺失的 tarball；不要强加 `--offline`。冻结锁文件保证版本不漂移，安装后的运行时不会再运行 pnpm 或下载依赖。

## 5. 完整构建流程

以下命令从仓库根目录开始。日志目录不是产品产物，可以按本机构建约定放置。

```powershell
New-Item -ItemType Directory -Path ".ci-logs" -Force | Out-Null
```

### 5.1 安装 Desktop 开发依赖并做快速检查

```powershell
pnpm --dir plugins install --frozen-lockfile
pnpm --dir desktop install --frozen-lockfile
pnpm --dir desktop run test:node *> .ci-logs/windows-node.log
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml -- --check *> .ci-logs/windows-rust-fmt.log
cargo clippy --locked --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings *> .ci-logs/windows-rust-clippy.log
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml *> .ci-logs/windows-rust-test.log
```

每条命令结束后检查退出码，并读取完整日志。不要只读日志末尾来判断是否成功。

### 5.2 构建两份共享产物并比较

共享产物必须来自当前准备发布的提交。建议使用两个独立输出目录，完成后比较完整清单：

```powershell
$env:PENPOT_SHARED_ARTIFACT_ROOT = "D:\artifacts\penpot-shared-a"
pnpm --dir desktop run build:sources *> .ci-logs/windows-shared-a.log

$env:PENPOT_SHARED_ARTIFACT_ROOT = "D:\artifacts\penpot-shared-b"
pnpm --dir desktop run build:sources *> .ci-logs/windows-shared-b.log

node desktop/packaging/verify-shared-artifacts.mjs `
  "D:\artifacts\penpot-shared-a" `
  "D:\artifacts\penpot-shared-b" *> .ci-logs/windows-shared-compare.log
```

如果已有与当前提交匹配且通过双构建比较的共享产物，可以跳过重新构建，但必须先运行 `verify-shared-artifacts.mjs`。

### 5.3 准备 Windows 运行时输入

```powershell
pnpm --dir desktop run prepare:windows *> .ci-logs/windows-prepare.log
```

此步骤读取 `desktop/packaging/runtime-metadata.windows.json`，只接受固定版本和匹配 SHA-256 的来源。它解压工具，构建 Garnet 和 WOFF 工具，并复制 Garnet 与 ImageMagick 所需的 Visual C++ 运行库。

### 5.4 组装并审计运行时

```powershell
$env:PENPOT_SHARED_ARTIFACT_ROOT = "D:\artifacts\penpot-shared-a"
pnpm --dir desktop run assemble:windows *> .ci-logs/windows-assemble.log
```

组装步骤会：

- 验证共享产物清单。
- 从每个模块自己的 `package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 安装生产依赖。
- 复制固定版本的运行时和 Penpot 产物。
- 删除 PostgreSQL 可选语言模块、FontForge 测试、源码映射、PDB、LIB、Chromium 安装器和重复 ImageMagick 命令。
- 生成兼容性字体 fixture。
- 审计所有 PE 的普通和延迟 DLL 导入。
- 最后生成并验证 `runtime-lock.json`，再原子替换最终运行时。

成功后检查：

```powershell
$runtime = "desktop/src-tauri/resources/runtime/x86_64-pc-windows-msvc"
$audit = Get-Content "$runtime/runtime-audit.windows.json" -Raw | ConvertFrom-Json
$audit.passed
$audit.unresolved.Count
```

必须得到 `True` 和 `0`。任何组装后改动都会使 `runtime-lock.json` 失效；不要手工修改最终运行时。如果确有变更，应修改组装逻辑并重新组装。

### 5.5 运行原生兼容性计划

先准备五个真实导出请求文件，详见 `desktop/compatibility/README.md`。这些文件需要一次性本地用户、文件、页面、对象 ID 和有效会话，不能使用假的 Exporter 响应。

```powershell
pnpm --dir desktop run build:compat *> .ci-logs/windows-compat-build.log

$root = (Resolve-Path ".").Path
$runtime = (Resolve-Path "desktop/src-tauri/resources/runtime/x86_64-pc-windows-msvc").Path
$plan = (Resolve-Path "desktop/compatibility/plans/x86_64-pc-windows-msvc.json").Path
$work = Join-Path $root ("desktop/target/compatibility-windows-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$report = Join-Path $work "report.json"
New-Item -ItemType Directory -Path (Join-Path $work "fixtures") -Force | Out-Null

# 将五个真实 export-*.json 复制到 $work/fixtures 后运行：
& "desktop/src-tauri/target/debug/penpot-desktop-compat.exe" `
  $plan $runtime $work $report *> .ci-logs/windows-compat.log
```

必须使用绝对的 `$runtime`、`$plan` 和 `$work`。通过报告应覆盖数据库初始化和迁移、Garnet 行为、四项字体转换、Chromium 离线渲染、五种真实导出、PostgreSQL 正常重启和强制终止恢复。

### 5.6 构建 NSIS 工程包

```powershell
pnpm --dir desktop run package:windows *> .ci-logs/windows-package.log
```

`package:windows` 是完整流水线：准备运行时、在未提供共享产物时构建源码、组装、打包并生成证据。如果前面已完成准备和组装，只想重跑打包，可在 `desktop` 目录直接运行：

```powershell
node packaging/package.mjs *> ..\.ci-logs\windows-package-only.log
node packaging/windows-release-evidence.mjs --engineering *> ..\.ci-logs\windows-evidence.log
```

Tauri 的 WebView2 配置应保持：

```json
{ "type": "offlineInstaller", "silent": true }
```

当前 Tauri schema 不接受 `offlineInstaller.path`。Tauri 在构建时取得并嵌入离线安装器；不要再把该安装器复制到应用资源中。

工程安装器位于：

```text
desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

证据位于：

```text
desktop/target/release-evidence/x86_64-pc-windows-msvc/
```

只有在安装器已正确签名时才设置 `PENPOT_RELEASE_QUALIFY=1`。否则证据必须保持 `engineering: true` 和 `releaseQualified: false`。

### 5.7 干净机验收

将安装器、证据、五个真实导出 fixture 和验收脚本复制到独立 Windows 11 x64 机器。验收脚本使用 `<ReportRoot>/runtime/fixtures`，因此先放好 fixture，再断开公网并运行：

```powershell
$reportRoot = "C:\penpot-acceptance"
New-Item -ItemType Directory -Path "$reportRoot\runtime\fixtures" -Force | Out-Null
Copy-Item "C:\fixtures\export-*.json" "$reportRoot\runtime\fixtures\"

powershell -ExecutionPolicy Bypass -File .\windows-clean-machine.ps1 `
  -InstallerPath ".\Penpot Desktop_2.17.0_x64-setup.exe" `
  -ReportRoot $reportRoot `
  -Engineering
```

正式签名包移除 `-Engineering`。升级验收还应传入 `-PreviousInstallerPath`；失败安装器场景使用 `-FailureInstallerPath`。脚本验证：

- current-user 安装和首次冷启动。
- Credential Manager 和仅所有者 ACL。
- 所有子进程只连接回环地址。
- 新建设计、保存、重启后重新打开。
- WebSocket 编辑、图片和字体上传。
- `.penpot` 导入导出，以及 PNG、JPEG、WebP、SVG、PDF 导出。
- 升级成功、升级失败回滚、卸载后保留用户数据。

## 6. 用户仓库代码更新后的影响

只有更新已进入 `xuchen-cloud/penpot` 或以本地内容提供后，agent 才能检查和构建。不要从被禁止的上游仓库抓取、比较或读取内容。

每次更新都先看当前分支相对上一个已验证提交的文件变化，再按下表选择重建范围：

| 变化区域 | 主要影响 | 最低重建和检查 |
| --- | --- | --- |
| `frontend/`、`common/`、插件静态资源 | 前端 JS、字体、图片、配置或共享逻辑变化 | 重建两份共享产物并比较；重新组装；兼容性和 NSIS |
| `render-wasm/` | Frontend 和 Exporter 各自的 WASM 可能变化 | 固定 Rust/Emscripten/Skia；双构建比较两个 WASM；重新组装和导出检查 |
| `backend/` 或数据库迁移 | JAR、配置、数据库结构和升级路径变化 | 重建共享产物；全新数据库迁移；旧版本数据升级和失败回滚 |
| `exporter/` | Node 依赖、Chromium 调用和导出协议变化 | 生产依赖冻结安装；五种真实导出；Chromium 离线检查；DLL 审计 |
| `media-processor/` | Sharp 原生库、ImageMagick/FontForge 调用或上传协议变化 | 生产依赖冻结安装；四类字体转换；图片上传；DLL 审计 |
| `package.json`、`pnpm-lock.yaml`、workspace 文件 | 安装树和原生依赖可能变化 | 用项目 pnpm 版本和 `--frozen-lockfile`；检查新 DLL、许可证和 SBOM；不得沿用旧 node_modules |
| `deps.edn`、Clojure 配置或 Git 依赖 | Backend/Frontend/Exporter 的编译输入变化 | 清楚记录缓存来源；双构建比较；检查 Windows Clojure 参数适配器 |
| `desktop/src-tauri/`、Cargo 锁或 Tauri 配置 | 应用进程模型、网关、安全、安装器或 WebView2 行为变化 | Rust 全套检查；重新组装锁；NSIS；安装、升级、卸载验收 |
| `runtime-manifest.json` 或 Windows 元数据 | 所需文件、版本、来源、哈希或许可证变化 | 更新固定元数据和测试；重新准备、审计、组装、证据和干净机验收 |
| Backend 环境变量、Feature Flag 或服务端口 | 本地服务可能无法启动或功能静默关闭 | 对照 `local_stack.rs` 和 Windows 兼容计划；检查 readiness、迁移、任务队列和 WebSocket |
| PostgreSQL、JRE、Node、Chromium、Garnet、ImageMagick、FontForge、WOFF 工具版本 | ABI、命令参数、系统 DLL 和许可证可能变化 | 逐项更新 SHA-256；先做 `--version`/帮助探针；重跑 PE 审计和完整兼容性计划 |

即使只改文档，最终发布构建也应以准备发布的提交为来源重新生成 provenance。不要给旧安装器换一份指向新提交的证据。

### 更新后的固定检查表

1. 确认所有锁文件、工具链版本和运行时元数据仍一致。
2. 清除或隔离会掩盖问题的旧输出目录，但保留已校验下载缓存。
3. 做两份独立共享产物并比较文件集合、大小、SHA-256、来源和工具链清单。
4. 用新 staging 重新组装，不要在旧最终运行时上覆盖文件。
5. 检查 PE 审计是否出现新的系统 DLL、VC++ CRT、OpenMP 或组件内 DLL。
6. 检查运行时未接近 NSIS 约 2 GB 的数据限制，并查找新 `.map`、PDB、LIB、测试和重复可执行文件。
7. 用全新数据库跑迁移，再用上一发布版本的数据副本跑升级。
8. 使用真实 fixture 完成导出和媒体检查；不得用 mock 代替。
9. 重建 NSIS 和证据，核对安装器哈希、签名状态、许可证和 SBOM。
10. 在干净机断网执行安装、首次启动、升级、故障恢复和卸载验收。

## 7. 本次构建遇到的问题和规避方式

### 7.1 工作目录和命令

- **在错误 worktree 执行。** 同一仓库可能有多个 Codex worktree。每次先核对 `Get-Location`、分支和 `git status`，不要凭任务标题猜目录。
- **相对日志路径写入失败。** 命令切换到 `desktop` 后，`.ci-logs/...` 指向了不存在的子目录。长任务使用已解析的绝对日志路径。
- **兼容性参数使用相对路径。** Node 把运行时脚本路径相对到隔离工作目录，产生 `MODULE_NOT_FOUND`。计划、运行时和工作目录都传绝对路径。
- **重复启动长构建。** Rust release、运行时哈希和 NSIS 压缩都可能长时间没有新输出。先看进程是否仍消耗 CPU，再低频等待，不启动第二份任务。

### 7.2 依赖和工具链

- **pnpm `--offline` 缺少 tarball。** 锁文件存在不代表本地 store 完整。构建机允许联网，用 pnpm 12、`--prod` 和 `--frozen-lockfile`；离线要求针对最终安装和运行，不针对依赖准备阶段。
- **PATH 中 pnpm 版本或命令不可用。** 用 `PENPOT_BUILD_PNPM` 或 JSON 命令变量指向已验证入口，并先运行最小 `--version` 探针。
- **Garnet 参数写成 `--address`。** 当前 Garnet 使用 `--bind`。版本变化后先读取随包程序的 `--help`，不要照搬其他缓存服务参数。
- **Chromium `--version` 挂起。** Windows Chromium GUI 程序不适合作为版本探针。用 `compat/check.mjs chromium` 启动 headless 浏览器并渲染离线 `data:` URL。
- **Tauri WebView2 schema 不接受 `path`。** `offlineInstaller` 只使用 `type` 和 `silent`。构建时下载并嵌入离线安装器，安装后不联网。

### 7.3 Windows 路径和环境

- **FontForge 吞掉反斜杠。** FontForge 命令字符串中的 Windows 路径必须转为 `/`，并转义单引号。包含空格和单引号的真实路径已有测试。
- **清空环境导致 `initdb` 以 `0xc0000409` 退出。** 兼容性运行器在 `env_clear` 后必须恢复 `SystemRoot`、`COMSPEC`、`ProgramFiles`、用户目录和临时目录等标准 Windows 变量。
- **Backend 文件存储拒绝带盘符路径。** `datoteka.fs` 在该调用路径中把盘符冒号判为非法字符。兼容性计划使用隔离工作目录下的相对 `assets`。
- **临时目录复用。** `initdb` 要求新数据库目录。每次运行用时间戳创建新的工作目录，不要复用失败运行的目录。

### 7.4 DLL 和运行时内容

- **Chromium、JRE 等系统 DLL 被误报。** PE 审计需要维护明确的 Windows 系统 DLL 集，并在整个声明的运行时 PATH 中解析组件 DLL，不能只看二进制同目录。
- **Garnet 缺少 VC++ CRT。** 自包含 .NET 发布仍会导入 `msvcp140.dll`、`vcruntime140.dll` 和 `vcruntime140_1.dll`。从已验证的 Visual Studio x64 redist 复制到 Garnet 目录。
- **ImageMagick 缺少 `vcomp140.dll`。** OpenMP 构建需要该 DLL。准备阶段从 Visual Studio x64 redist 复制。
- **PostgreSQL 可选模块带来无关依赖。** pgAdmin、PL/Perl、PL/Python 和 PL/Tcl 会引入 Perl、Python、Tcl 或调试 CRT。Desktop 不使用它们，组装时删除。
- **手工改动最终运行时使锁失效。** `runtime-lock.json` 必须最后生成。任何裁剪或复制都放在组装脚本内，并重新跑完整组装。

### 7.5 NSIS 体积和文件布局

- **FontForge 测试文件的长路径使 makensis 无法打开文件。** 删除 `pkg_resources/tests`；产品不需要这些测试数据。
- **约 2.0 GB 运行时触发 makensis 内部内存映射错误。** 删除源码映射、PDB、LIB、Chromium 自带安装器、重复 ImageMagick 命令和其他仅用于打包/调试的文件。裁剪后必须重新跑 DLL 审计和兼容性测试。
- **不要随意删除 JRE、Chromium或前端资源。** 先按文件体积排序，再根据 manifest、实际命令和兼容性结果证明文件无运行时用途。不能只为缩小安装包而绕过功能检查。

### 7.6 兼容性和发布结论

- **缺少导出 fixture。** 启动所有服务并不代表兼容性计划完成。五种导出必须使用真实 Backend 数据和会话；没有 fixture 时应将报告标为未完成，而不是生成假的请求或产物。
- **未签名工程包不是发布包。** 即使 NSIS、哈希和 SBOM 都成功，`Get-AuthenticodeSignature` 不是 `Valid` 时仍只能交付工程测试。
- **本机构建不是干净机验收。** 本机已有 Visual Studio、缓存和开发环境，不能证明目标用户机器可用。最终判断以断网干净机验收为准。

## 8. 2026-09-07 工程构建基线

本次已验证结果仅用于回归比较，不是永久固定值：

- Windows 运行时：1,671,708,281 字节。
- PE 审计：683 个二进制，0 个未解析 DLL 导入。
- NSIS 工程安装器：851,599,052 字节。
- 安装器 SHA-256：`b1a7649c6981f8f474ea621488faad7909585fdd6ff546d4febb31d65748e034`。
- Node 测试：61 项通过。
- Rust 测试：59 项通过，3 项忽略。
- Rust Clippy 和格式检查通过。
- 原生计划已通过服务启动、迁移、Garnet、Chromium 和字体相关阶段；五种导出仍等待真实 fixture。
- 安装器未签名，尚未完成独立干净机验收。

代码、锁文件、时间戳或签名变化后，安装器哈希变化是正常的。新的构建必须生成自己的证据，不能复制本节数值作为结果。
