# Penpot 本机离线独立包可行性研究

> 本文保留最初的可行性调查。产品范围随后确定为 macOS 14+（Apple
> Silicon）和 Windows 11（x86-64），使用 Tauri 2、本机 PostgreSQL 15，
> macOS 使用 Valkey，Windows 使用 Garnet。当前实施状态与验收门槛见
> `desktop/ROADMAP.md`；其中的已定方案取代本文早期的 Linux 优先建议。

## 结论

**可以实现，但不能把现有发布包直接解压后运行。** 当前源码已经具备离线运行所需的大部分基础：前端是静态文件，后端能生成独立 JAR，媒体可在后端本地处理，上传对象可写本机文件系统，构建时会预取内置模板，而且官方已有 `enable-air-gapped-conf`。缺口主要在发布工程、进程编排、跨平台原生依赖，以及“完全禁止出站”的统一策略，而不是设计编辑器的核心业务逻辑。

建议先做 **Linux x86-64/arm64 独立包**，再做 macOS；Windows 原生包单独立项。Linux 首版预计不必改核心数据模型，只需新增打包、启动器、配置和少量离线模式补丁。Windows 的主要阻碍不是 JVM 或 Node，而是 Valkey 没有官方 Windows 服务端支持，以及 FontForge/woff 工具、反向代理脚本和部分发布流程偏 POSIX。

本报告基于仓库 `develop` 分支提交 `00e0492bb53e93360795eb7feb3b0baefc06383d`（2026-09-04）。

## 两种“离线”目标必须分开

1. **运行时无需外网**：断网时主要编辑、上传、自定义字体、协作通知（同机）、导入导出仍可工作。现有代码离这个目标很近。
2. **系统保证零出站**：即使误开功能或点击外链，Penpot 的所有进程也不能连接非回环地址。现有 `enable-air-gapped-conf` 不足以单独给出这个保证；必须叠加应用级离线策略和操作系统防火墙/沙箱。若界面运行在用户的普通浏览器中，只能约束 Penpot 服务进程，无法保证整个浏览器零出站；要约束界面导航，需要受控桌面壳或浏览器策略。

官方文档对 air-gapped 的定义也较窄：它列出的默认外部代理只有 GitHub 模板和 Google Fonts，并说明该标志会去掉这些 Nginx 位置及相应界面（`docs/technical-guide/configuration.md:420-434`）。前端仍含手动更新检查和多处外部帮助链接，后端仍可按其他功能标志启用遥测、OAuth、Webhook 等，因此“配置为 air-gapped”不等于“技术上无法出站”。

## 当前运行架构

### 基础进程和数据流

| 进程/服务 | 当前作用 | 独立包结论 | 依据 |
|---|---|---|---|
| 前端静态站点 + 反向代理 | 提供 SPA；把 `/api`、`/assets`、`/ws/notifications`、`/api/export` 分流到后端或导出器 | 必需。可继续捆绑 Nginx/Caddy，也可写小型本机网关 | `docker/images/files/nginx.conf.template:74-188` |
| JVM 后端 | RPC/HTTP、会话、WebSocket、迁移、存储、后台任务 | 必需；已有 uber-JAR 构建 | `backend/build.clj:7-24`；`backend/scripts/run.template.sh:17-26` |
| PostgreSQL | 业务主库、会话、任务、迁移、文件数据 | 必需；建议捆绑，不建议换 SQLite | `backend/src/app/main.clj:151-170`；`backend/src/app/config.clj:35-58` |
| Valkey/Redis | 消息总线、WebSocket 通知、后台任务的 dispatcher→runner 交接；导出作业状态 | 现架构下必需；单机仍会在启动时建立普通和 Pub/Sub 连接 | `backend/src/app/main.clj:177-191`；`backend/src/app/msgbus.clj:69-103`；`backend/src/app/main.clj:584-606`；`exporter/src/app/core.cljs:26-48` |
| 文件系统对象存储 | 图片、字体、缩略图、临时导出物 | 单机推荐；不需要 MinIO/S3 | `backend/src/app/config.clj:55-58`；`backend/src/app/storage/fs.clj:37-46,61-99` |
| Exporter（Node + Playwright） | 位图、SVG、PDF、批量/异步导出 | 要保持完整导出功能则必需；需随包携带 Node、匹配版本 Chromium 和原生工具 | `exporter/package.json:13-26`；`exporter/src/app/browser.cljs:133-169`；`docker/images/Dockerfile.exporter:27-90` |
| 本地媒体工具或 media-processor | 图片信息/缩略图与字体转换 | 二选一。首版建议沿用后端本地模式，少一个常驻进程 | `backend/src/app/media.clj:7-38`；`backend/src/app/media/local.clj:89,223-284` |
| SMTP | 注册验证、邀请、找回密码 | 单机可选；用 `disable-email-verification disable-smtp enable-log-emails` 或首次启动直接建本地管理员 | `common/src/app/common/flags.cljc:43-58,193-208` |
| MCP、LDAP/OIDC、Nitrate、S3、Loki、审计归档 | 扩展或企业集成 | 离线首版全部关闭，不是编辑器核心依赖 | `docker/images/docker-compose.yaml:1-18,182-186`；`backend/src/app/config.clj:213-229`；`media-processor/src/config.ts:20-26` |

官方 Compose 也印证了最小拓扑：frontend、backend、exporter、PostgreSQL、Valkey；MinIO 不是默认生产 Compose 的必需项，因为默认对象存储已经是 `fs`（`docker/images/docker-compose.yaml:80-150,188-259`）。Mailcatch 和 MCP 可以从独立包裁掉。

### 为什么仍需要反向代理

它不只是静态文件服务器。当前文件系统对象响应返回 `x-accel-redirect`，实际文件由 Nginx 的内部 `/internal/assets` 位置读取（`backend/src/app/http/assets.clj:77-90`；`docker/images/files/nginx.conf.template:113-128`）。代理还必须正确处理 WebSocket upgrade、大请求体、导出路由和 SPA fallback（`docker/images/files/nginx.conf.template:130-185`）。

因此有两条可行路径：

- 首版捆绑并生成 Nginx/Caddy 配置，保留现有行为；
- 后续让后端直接流式返回本地对象并托管前端静态文件，才可真正省掉网关。该改法会扩大后端 I/O、安全和缓存测试面，不建议放进最小可行版本。

## 现有离线能力与缺口

### 已有能力

- `enable-air-gapped-conf` 在前端镜像启动时删除三个外部代理位置，并追加 `disable-google-fonts-provider disable-dashboard-templates-section`（`docker/images/files/nginx-entrypoint.sh:14-21`）。被删除的位置正是 GitHub 文件、`fonts.gstatic.com` 和 `fonts.googleapis.com`（`docker/images/files/nginx-external-locations.conf:1-57`）。
- 后端默认走本地媒体处理；只有 `remote-media-processing` 标志开启时才请求 media-processor（`backend/src/app/media.clj:34-38`）。本地路径调用 `magick`、`fontforge`、`sfnt2woff`、`woff2sfnt`、`woff2_decompress`（`backend/src/app/media/local.clj:89,223-284`）。
- 后端构建会下载全部 onboarding 模板，并复制进产物的 `builtin-templates/`（`backend/scripts/build:23-27`）。运行时优先读本地文件，仅缺失时才访问 `file-uri`（`backend/src/app/setup/templates.clj:37-68`）。因此离线发行物必须保留此目录并校验 15 个模板全部存在（模板清单见 `backend/resources/app/onboarding.edn:1-45`）。
- 前端、后端和 exporter 已经各自生成不含源码编译要求的 bundle；现有 `build-bundle` 只汇总应用产物，还没有带 JRE、Node、Chromium、数据库或系统工具的最终安装器（`manage.sh:1201-1263`）。

### 仍会或可能出站的路径

| 路径 | 自动/用户触发 | 离线包处理 | 依据 |
|---|---|---|---|
| 遥测 `https://telemetry.penpot.app/` | 后台定时任务，取决于标志/配置；官方 Compose 还显式设为 true。即使关闭 telemetry，只要用户订阅 newsletter，当前任务仍会发送邮箱列表和版本 | 独立包必须在 air-gapped 下让任务直接不发送，不能只设 `disable-telemetry`；零出站版再加网络封锁 | `backend/src/app/config.clj:72,310-312`；`backend/src/app/tasks/telemetry.clj:313-357`；`docker/images/docker-compose.yaml:160-166` |
| Google Fonts 和 GitHub 模板代理 | 使用字体/模板时 | 现有 air-gapped 标志已处理；模板文件应随包带齐 | `docs/technical-guide/configuration.md:420-434` |
| “检查更新”直连 GitHub raw | 用户点击 | air-gapped 时隐藏入口或改读随包 `HIGHLIGHTS.md` | `frontend/src/app/main/ui/dashboard/check_updates.cljs:29-39,119-137`；入口仅在非 air-gapped 显示：`frontend/src/app/main/ui/dashboard/sidebar.cljs:1320-1330` |
| 帮助、社区、Hub、插件目录、条款等外链 | 用户点击；部分配置为默认外部 URL | air-gapped 时隐藏/禁用，或指向随包离线帮助；桌面壳拦截非本地导航 | `frontend/src/app/config.cljs:159-168,230-231`；`frontend/src/app/main/ui/workspace/main_menu.cljs:69-109` |
| OAuth/OIDC/LDAP、Nitrate、Webhook、SMTP、S3、Loki、审计归档、错误报告 | 配置或用户触发 | 离线 profile 中强制关闭；若以后允许内网集成，应使用显式本地 allowlist | `backend/src/app/auth/oidc.clj:234-305`；`backend/src/app/loggers/webhooks.clj:162-192`；`backend/src/app/loggers/mattermost.clj:56-71,138` |
| URL 图片导入 | 用户输入 URL | “断网可用”可保留并给出失败提示；“零出站”必须禁用或只允许 loopback/本地文件 | `backend/src/app/media.clj:44-111` |
| 原型中的外部交互链接 | 用户点击设计内容 | 受控桌面壳拦截；普通浏览器场景只能靠主机网络策略 | `frontend/src/app/main/ui/viewer/shapes.cljs:145` |

特别说明：前端源码里的 `https://penpot.app/xmlns` 等 XML namespace 只是标识符，不会自动发请求；外链也不等于后台自动联网。离线审计应按实际网络 API、HTML 资源加载和导航区分，不能只扫描字符串。

## 构建时依赖与离线交付边界

**用户安装和运行可以完全离线，但发行版构建机仍需要联网，或需要预先建好内部依赖镜像。** 推荐在联网、可复现 CI 中按平台构建，产物做哈希和软件物料清单，然后将完整安装器送入隔离网。

- Clojure/JVM：Maven/Clojars 依赖，还含 Git 依赖 `funcool/yetti`（`backend/deps.edn:1-72`）。
- 前端/exporter：pnpm 包；exporter 的 `@penpot/svgo` 直接来自 Git 仓库，并由 Playwright 安装特定 Chromium（`exporter/package.json:13-26`；`exporter/scripts/setup:5-8`）。当前 exporter 生成的 `target/setup` 会在目标机再次执行 `pnpm install` 和 `playwright install chromium`，这直接违反离线安装要求，必须在发行构建阶段完成并随包复制 `node_modules` 与浏览器目录（`exporter/scripts/build:27-46`）。Playwright 官方也说明每个 Playwright 版本需要匹配的浏览器二进制，并允许用 `PLAYWRIGHT_BROWSERS_PATH` 指定随包目录：[Playwright Browsers](https://playwright.dev/docs/browsers)。
- WASM：Rust + Emscripten + Skia；脚本硬编码从 `/opt/emsdk/emsdk_env.sh` 载入环境（`render-wasm/build:22-32`）。只需在 CI 构建，不应放进用户安装过程。
- 后端本地媒体：JRE 之外还要带 ImageMagick、FontForge、woff-tools、woff2 及其动态库；当前 Linux 镜像列出了完整包组（`docker/images/Dockerfile.backend:62-106`）。
- exporter：Node、Chromium 及其 OS 动态库、字体、ImageMagick；SVG 路径还执行 `potrace`，WebP 执行 `convert`（`exporter/src/app/renderer/svg.cljs:131-137`；`exporter/src/app/renderer/bitmap.cljs:41`）。应把这些列入启动前自检；当前 exporter Dockerfile 并未明显安装 `potrace`，需要在新打包流水线中补齐并加端到端导出测试。

## 推荐独立包架构

### 第一阶段：本机 Web 应用，不先做 Electron

一个小型 supervisor/launcher 统一管理如下内容：

```text
Launcher / tray / service manager
  ├─ reverse proxy + frontend static files     127.0.0.1:9001
  ├─ PostgreSQL                                loopback/Unix socket
  ├─ Valkey                                    loopback/Unix socket
  ├─ JVM backend + worker                      127.0.0.1:6060
  └─ Node exporter + bundled Chromium          127.0.0.1:6061
```

启动器应负责：首次生成 512-bit secret；创建版本化配置和用户数据目录；`initdb`；按依赖顺序启动并轮询 readiness；设置全部 `PENPOT_*`；打开系统浏览器；正常停机；崩溃重启；日志轮转；升级前备份；端口冲突提示。所有内部服务只绑定回环或私有 Unix socket，不能绑定 `0.0.0.0`。Valkey 官方也建议仅本机使用时绑定 `127.0.0.1` 并加认证：[Valkey Installation](https://valkey.io/topics/installation/)。

推荐固定离线 profile：

- `PENPOT_PUBLIC_URI=http://127.0.0.1:9001`
- `enable-air-gapped-conf disable-telemetry disable-google-fonts-provider disable-dashboard-templates-section`
- `enable-login-with-password disable-email-verification disable-smtp disable-secure-session-cookies`（只限回环 HTTP；若允许局域网访问则必须改 HTTPS/安全 Cookie）
- `disable-remote-media-processing disable-login-with-google disable-login-with-github disable-login-with-gitlab disable-login-with-oidc disable-login-with-ldap disable-webhooks disable-mcp`
- `PENPOT_OBJECTS_STORAGE_BACKEND=fs` 和用户数据目录中的绝对路径
- 本地 PostgreSQL、Valkey URI；后端 worker 保持开启以执行清理和异步任务。

不要把数据库、对象文件或 secret 放进只读安装目录。Windows 用 `%LOCALAPPDATA%`，macOS 用 `~/Library/Application Support`，Linux 用 XDG data/config/state 目录。升级只能替换程序目录，数据迁移交给后端现有 migration，并在迁移前做 `pg_dump` 与 assets 快照。

### 第二阶段：受控桌面壳（可选）

Electron/Tauri 只提供窗口、托盘、协议处理和导航策略，后端拓扑不变。若用 Electron，会同时带 UI Chromium 和 exporter Chromium，体积、内存和安全更新成本显著上升；系统浏览器方案更适合先验证安装器。Electron 官方要求对分发包做平台打包和代码签名，并指出更新是独立发布环节：[Electron Distribution Overview](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)。完全隔离环境应默认关闭自动更新，只支持签名的离线升级包。

## 必须修改或新增的代码/工程点

按优先级建议：

1. **新增 standalone 发布目录和 CI 矩阵**：例如 `packaging/standalone/{common,linux,macos,windows}`，从现有 frontend/backend/exporter bundle 组装 JRE、Node、Chromium、PostgreSQL、Valkey、代理和媒体工具。不要在目标机运行 pnpm/Maven/Playwright 下载。
2. **新增 supervisor**：实现首次初始化、健康检查、优雅停机、日志、备份/恢复、端口与权限检查。不要依赖现有 Bash `run.sh` 作为跨平台入口；它通过 `source` 读取环境且使用 Bash（`backend/scripts/run.template.sh:1-26`）。
3. **把 air-gapped 变成后端可执行的统一策略**：目前关键动作发生在 Docker 前端镜像 entrypoint，而非应用自身（`docker/images/files/nginx-entrypoint.sh:14-21`）。standalone 网关必须复刻删除外部 routes 的逻辑；后端应在 air-gapped 下拒绝遥测（包括 telemetry 关闭但 newsletter 仍发送的分支）、外部媒体 URL、外部 Webhook/S3/SMTP/OIDC/Nitrate 等，不能只相信互相冲突的环境变量（`backend/src/app/tasks/telemetry.clj:313-357`）。
4. **补齐前端离线 UX**：air-gapped 下隐藏或替换所有外部帮助、Hub、插件、更新、定价入口；外部图片不自动加载；给 URL 导入明确说明。现有更新入口已有 air-gapped 条件，可沿用其模式（`frontend/src/app/main/ui/dashboard/sidebar.cljs:1320-1330`）。
5. **离线模板校验**：构建失败条件应是清单任一文件缺失，而非运行时回退到 GitHub；保留 `backend/scripts/build:23-27` 的预取成果。
6. **修正 exporter 离线组装和联网边界**：打包固定版本 Chromium、Node modules、WASM、字体和所有命令行工具；设置 `PLAYWRIGHT_BROWSERS_PATH`；在每个 Playwright context 上拦截请求，仅放行发行包定义的 loopback origin 及必要的 `data:`/`blob:` URL。当前代码创建 context/page 时没有 host allowlist（`exporter/src/app/browser.cljs:192-217`）。新增断网条件下 PNG/JPEG/WebP/SVG/PDF 回归测试。
7. **动态前端配置**：当前 Nginx entrypoint 会原地改写 `/var/www/app/js/config.js`（`docker/images/files/nginx-entrypoint.sh:27-48`）。签名的 macOS/Windows 包不应修改安装资源。可让 launcher 在用户缓存目录生成该文件，或让网关动态返回配置内容。
8. **增加浏览器侧约束**：standalone 网关为离线 profile 生成严格 CSP，例如将 `connect-src`、`font-src`、`img-src`、`frame-src` 收紧到 `self` 及确需的 `data:`/`blob:`，并按本地插件需要细分。当前 Nginx 只发四个基础安全头，没有 CSP（`docker/images/files/nginx-security-headers.conf:1-4`）。CSP 是纵深防护，不替代 OS 防火墙。
9. **零出站验收**：CI/系统测试在拒绝公网路由的网络命名空间或防火墙规则下跑注册、建文件、图片/字体上传、协作 WebSocket、导入、五种导出、重启恢复和升级迁移；另跑出站捕获，确保没有 DNS/HTTP/TCP 尝试。应用标志测试和 OS 封锁测试都要有。

## 为什么不建议把 PostgreSQL 换成 SQLite

仓库出现 `sqlite-jdbc` 不能说明主库已兼容 SQLite：它只用于 `.penpot` binfile v2 容器（`backend/deps.edn:42-44`；`backend/src/app/binfile/v2.clj:8,43-46`）。主库大量依赖 PostgreSQL 专有能力：

- 初始迁移创建 PL/pgSQL 函数、触发器、`uuid`、`timestamptz`、`jsonb`（`backend/src/app/migrations/sql/0001-add-extensions.sql:1-25`）；
- 数据层直接构造 PostgreSQL `jsonb` 对象并调用 advisory transaction lock（`backend/src/app/db.clj:657-728`）；
- worker/cron 用 `FOR UPDATE SKIP LOCKED` 保证抢占（`backend/src/app/worker/cron.clj:44`）；
- 遥测和业务查询使用 `date_trunc`、interval、JSON 运算等 PostgreSQL SQL（`backend/src/app/tasks/telemetry.clj:48-62,145-152`）。

换 SQLite 意味着重写全部迁移、SQL 方言、锁与 worker 语义、JSON 编解码、并发测试和升级工具，风险远高于随包携带 PostgreSQL。PostgreSQL 官方提供 Linux、macOS、Windows 包；Windows 页面还明确提供“供其他应用安装器嵌入”的二进制 ZIP：[PostgreSQL Downloads](https://www.postgresql.org/download/)，[PostgreSQL Windows installers](https://www.postgresql.org/download/windows/)。

## 平台可行性矩阵

| 平台 | 可行性 | 主要工作与风险 |
|---|---|---|
| Linux x86-64 | **高，建议首发** | 当前容器运行环境就是 Debian，JRE/Node/PostgreSQL/Valkey/Chromium/媒体工具都有成熟原生包。需决定 glibc 基线并打 `.deb`/`.rpm` 或自包含 tar/AppImage；动态库和字体必须随包或严格声明。 |
| Linux arm64 | **高到中** | 当前 Dockerfile 对 JRE、Node 已区分 arm64/x86-64（`docker/images/Dockerfile.backend:21-37`；`docker/images/Dockerfile.media-processor:54-73`），Playwright 官方支持 Debian/Ubuntu arm64；仍需为 Skia/WASM、ImageMagick、PostgreSQL、Valkey及所有 exporter 工具建 arm64 产物。 |
| macOS Apple Silicon | **中** | JVM、Node、Playwright、PostgreSQL、Valkey、FontForge 都可获得，但当前发布脚本和路径按 Linux/POSIX 容器写。需打 universal/arm64 原生依赖、处理 dylib/rpath、签名与 notarization；若进 Mac App Store，后台数据库/服务和沙箱权限会更复杂，建议先做 Developer ID 站外 `.dmg/.pkg`。 |
| macOS Intel | **中到低** | 技术上类似 Apple Silicon，但测试矩阵和维护成本翻倍；应先确认用户需求和上游支持周期。 |
| Windows x86-64 | **中到低，需单独项目** | PostgreSQL 有可嵌入 ZIP，Node/Playwright 原生支持，FontForge 有 Windows 发布版；但 **Valkey 官方明确不支持 Windows 服务端，仅建议 WSL 开发**。WSL 不符合“不依赖虚拟化/本机原生一键安装”的严格目标。还需移植 Bash/envsubst/Nginx 路径、`sfnt2woff`/`woff2sfnt`/`woff2_decompress`、ImageMagick/potrace 查找、服务控制和 ACL。 |
| Windows arm64 | **低** | 除上述问题外，所有原生依赖都需 arm64 或可靠 x64 仿真验证；不建议首批支持。 |

上游依据：Valkey 官方称 Linux/macOS 是主要开发测试平台且没有官方 Windows build：[Valkey Introduction](https://valkey.io/topics/introduction/)；FontForge 官方提供 Windows、Mac、GNU/Linux release：[FontForge Downloads](https://fontforge.org/en-US/downloads/)；Playwright 当前支持 Windows 11+/Server 2019+、macOS 14+、Debian 12/13 与 Ubuntu 22.04/24.04/26.04 的 x86-64/arm64：[Playwright Installation](https://playwright.dev/docs/intro)。

### Windows 的决策点

可选方案只有三个：

1. 维护非官方 Valkey Windows build：业务代码改动最少，但安全更新、兼容和签名责任都转给本项目；风险最高。
2. 通过 WSL 带 Linux 子系统：工程快，但不满足严格的“原生、无额外平台依赖”。
3. 新增 standalone 单进程传输实现：后端以本地内存 msgbus 代替 Redis Pub/Sub，以 JVM 队列代替 dispatcher/runner 的 Redis list；exporter 改为同步调用或实现非 Redis 作业存储。该方案能移除 Valkey，但会改变协作、任务恢复、导出进度和未来多实例语义，必须明确只在 standalone 单机 profile 下启用，并做大量故障恢复测试。

建议首两版仍捆绑 Valkey，只支持 Linux/macOS；等产品需求证明 Windows 必须原生，再比较方案 1 与 3。不要为 Windows 顺带重写 PostgreSQL。

## 风险与验收标准

### 主要风险

- **安装器体积与内存**：JRE、Node、Chromium、PostgreSQL、Valkey和图像/字体库会让安装包达到数百 MB；Electron 会再加一份 Chromium。
- **安全更新面**：打包方必须跟踪 Chromium、JRE、PostgreSQL、Valkey、ImageMagick、FontForge、libvips/Sharp 及 Node 依赖漏洞。
- **数据升级/回滚**：数据库迁移通常不可直接回滚；必须先备份，并禁止两个版本同时打开同一数据目录。
- **渲染一致性**：导出结果受 OS 字体和图像库影响；当前 Linux exporter 明确安装一组字体（`docker/images/Dockerfile.exporter:27-43`），其他平台应固定同一字体集合并做像素/布局基线测试。
- **本机端口和权限**：固定端口可能冲突；随机端口又要求动态配置 public URI、cookie、exporter internal URI。首版可固定 9001 并做清晰冲突提示。
- **“离线”误承诺**：air-gapped 标志关闭的是已知应用入口，不能替代主机出站策略。对高保证场景，安装说明必须给出并验证防火墙规则。

### 最小可发布标准

- 新机器在断网状态完成安装、首次初始化和启动，目标机不需要 Java、Node、PostgreSQL、Valkey、ImageMagick 或浏览器下载。
- 完成注册/登录、建团队/项目/文件、重启恢复、图片上传、自定义字体、`.penpot` 导入导出、PNG/JPEG/WebP/SVG/PDF 导出。
- 所有服务只监听 loopback；随机生成 secret；数据目录权限仅当前用户可读写。
- 抓包证明默认离线 profile 没有公网 DNS/TCP 请求；零出站版即使错误配置也被 OS 规则拒绝。
- 支持备份、恢复、卸载保留/删除数据的明确选择，以及签名离线升级包。

## 推荐路线图

1. **PoC（Linux）**：直接用已有 bundles，手工组装 JRE/PostgreSQL/Valkey/Node/Chromium/Nginx/媒体工具，写 launcher，证明断网全流程。
2. **产品化（Linux）**：可复现 CI、SBOM/许可证、签名、备份恢复、升级迁移、出站测试、`.deb` 和自包含包。
3. **macOS**：arm64 优先，解决 dylib、签名/notarization、launchd/托盘和数据目录。
4. **Windows 技术预研**：先决定 Valkey 策略，再做 x86-64；不要在该决策前承诺发布日期。
5. **可选桌面壳**：只在需要受控导航、托盘和系统集成时加入；不要把它与第一版离线能力绑定。

总体判断：**“不依赖 Docker/K8S、目标机一键安装、运行时断网可用”可实现，Linux 改造量中等；“跨三大系统且技术上保证零出站”也可实现，但属于新的发行产品线，Windows 和出站强制策略需要实质代码改造与长期维护。**
