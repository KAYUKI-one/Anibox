# Anibox

Windows 桌面代理客户端，原生 JSON 配置优先。当前版本 **0.2.1**。

## 运行

便携版：`release/Anibox/Anibox.exe`。保留同级的 `cores` 和 `rules`。
应用采用单实例；先退出旧实例，再打开新版。工作区格式继续使用 v1，已有节点、配置和背景保留。

开发环境要求 Node.js 22.12+、Rust stable、Visual Studio C++ Build Tools 与 WebView2。
脚本优先使用项目 `.tooling` 内的 Rust，不修改系统 PATH。

```powershell
npm ci
npm run setup:cores
npm run desktop
npm run desktop:build
```

`setup:cores` 从官方发布下载固定版本 Xray 26.10.31、sing-box 1.14.4 和两份大陆 SRS，校验 SHA256；已有完整内核目录时保留。二进制依赖和个人工作区不提交到 Git。

正式构建固定输出到 `release/Anibox`，内含版本及哈希记录 `build-info.json`。
旧构建归档到 `.local/releases-archive`；目标被占用时提示退出，不生成其他 preview 目录。
`npm run desktop:qa` 输出到 `.local/qa/Anibox`，使用独立应用标识和工作区。
浏览器预览使用 `npm run dev`，地址为 `http://127.0.0.1:1420`；浏览器不模拟连接或统计。

## 0.2.1

- 修复新版 Windows 11 下旧式模糊导致的外层黑底和拖动性能问题，改用 DWM Desktop Acrylic，并将玻璃扩展到无边框客户区。较旧系统回退浅色背景。
- 默认页面为浅蓝色；设置中的恢复默认同时重置背景照片、模糊和透明度。
- 后台规则检查延后到启动 30 秒后；文件读写和内核校验放到阻塞线程池。流量轮询避免请求重叠。
- 整理固定发布目录、隔离测试目录，并加入固定依赖准备脚本。

## 0.2.0

- 删除标语、大标题、装饰页脚和提示卡。除设置页外，各页面固定在窗口内；长列表、日志、JSON 仅在自身区域滚动。
- 窗口外层玻璃效果；页面背景与卡片可分别自定义。
- Xray 与 sing-box 均支持托管 TUN 配置，默认内核随所选节点确定。
- TUN 单独启动提权进程，GUI 保持普通权限。控制连接断开时自动停止核心；停止优先发送正常退出信号，再清理生成接口的路由与 DNS。
- 内置大陆 SRS 规则，首次可离线使用；启动及运行中检查更新，每 24 小时拉取公开源。两份文件校验完成后才切换缓存代际，失败保留旧规则。
- 显示真实上传、下载速率与本次累计流量。Xray 使用入站 Metrics，sing-box 使用带认证的本机 Clash API。
- 保留节点、订阅、原生 JSON 编辑、导出、校验、运行配置预览、托盘行为及备份恢复。

规则源：[2dust/sing-box-rules](https://github.com/2dust/sing-box-rules)，与 v2rayN 使用的公开增强规则源一致。
来源见 [assets/rules/SOURCES.md](assets/rules/SOURCES.md)。不会修改用户的 v2rayN 文件。

自动更新目前只覆盖 **sing-box 的两份大陆 SRS**，Xray 的 `geoip.dat` / `geosite.dat` 随内核提供，DAT 自动更新尚未实现。
应用启动 30 秒后检查一次，之后每小时检查时间戳；距离上次成功检查满 24 小时才下载（约 0.53 MiB，随上游变化）。退出应用后没有定时任务。
内容相同只更新时间戳；内容变化才启动一次 sing-box 校验并切换缓存，正在运行的内核不强制重启。失败保留旧缓存，下一次检查重试。

文件数量按用途决定：当前默认分流引用 `geosite-cn`、`geoip-cn`，另用内置内网 IP 判断；广告、服务分类和额外分流需自行加入对应规则集及引用。
Xray 的 DAT 本身可以包含多个分类，与 sing-box 按分类拆分的 SRS 文件数不能直接比较。完整原生 JSON 使用其自身声明的规则，不由应用自动补齐。

## 原生配置与默认模板

分享链接转换为原生出站，默认模板组合本地入站、DNS、路由；高级用户可以直接维护完整原生 JSON。
完整原生配置固定内核、保留原文，不自动添加入站、规则或统计接口。当前未启用统计时显示 `—`。
托管配置在启动时分配独立的统计端口、认证令牌、规则缓存路径和 TUN 接口名；不反写原始节点。

分享链接目前实现 VLESS、Trojan、Hysteria2、TUIC、Shadowsocks 常用参数及 Base64 订阅。
其他协议可导入原生 JSON；无法完整转换的参数会显式报告。
订阅保存地址并手动更新，保留本地修改；Clash YAML 和其他分享格式尚待扩展。

## 当前边界

- TUN 需要管理员授权。已验证配置、控制接口与两个内核的正常退出机制；未在用户的实际远端节点上切换全局路由进行公网验证。
- TUN 授权当前要求当前 Windows 账户可完成提权；未实现长期安装的 Windows 服务或其他管理员账户代授权的支持。
- 自定义 TUN 接口的生命周期主要交给原生内核；应用的补充路由清理只作用于自己生成的接口名。
- 核心自动更新、测速、内核日志流、更多订阅格式尚未实现。
- 配置编辑当前使用严格 JSON；JSONC 尚未接入。
- 规则缓存保留历史代际，避免正在使用或导出的配置失去规则文件；清理策略后续补充。
- 工作区当前为本机 JSON 文件，尚无 DPAPI 保护；备份也包含凭据。

## 验证

```powershell
npm test
npm run test:cores
npm run test:ui
npm run test:desktop
cargo test --manifest-path src-tauri/Cargo.toml
```

`test:cores` 只执行 `-test` / `check`，不创建 TUN 或更改网络。
UI 测试使用 Edge，包含 900×620、1024×768、1440×900 的无整页滚动检查。
桌面集成测试只将代理流量发送到本机，规则更新会访问上述公开源；不修改系统代理、DNS 或全局路由。
`test:desktop` 默认使用 `desktop:qa` 构建的隔离版本；可通过 `ANIBOX_TEST_EXE` 指定其他测试程序。
Windows 11 22H2+ 可设置 `ANIBOX_CHECK_WINDOW=1`，额外核对 DWM 属性及窗口移动。该检查只接受固定目录中的 QA 程序。

结构与扩展约定见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可

应用源码 GPL-3.0-or-later。内核、Wintun、规则及其他组件遵循各自许可，见 [THIRD_PARTY.md](THIRD_PARTY.md)。
