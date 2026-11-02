# 第三方组件

本项目不是 Xray、sing-box 或 v2rayN 的官方客户端。

| 组件                     | 来源                                       | 许可                                                                           |
| ------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------ |
| Xray-core                | https://github.com/XTLS/Xray-core          | MPL-2.0；随内核携带 LICENSE                                                    |
| sing-box                 | https://github.com/SagerNet/sing-box       | GPL-3.0-or-later 及上游随附说明；随内核携带 LICENSE                            |
| Wintun                   | https://www.wintun.net/                    | 随官方预编译二进制分发的许可；携带 LICENSE-Wintun                              |
| Xray GeoIP / GeoSite DAT | 本地 Xray 发布包附带；DAT 自动更新尚未接入 | 分发前需按实际数据来源补充许可与来源版本                                       |
| sing-box 大陆 SRS        | https://github.com/2dust/sing-box-rules    | 由公开增强规则源生成；来源见 assets/rules/SOURCES.md，分发前需整理上游数据许可 |
| libcronet.dll            | 用户已下载的 sing-box Windows 发布包附带   | 分发前需核对该发布资产的第三方许可与对应源码说明                               |
| Tauri                    | https://github.com/tauri-apps/tauri        | MIT / Apache-2.0                                                               |
| React                    | https://github.com/facebook/react          | MIT                                                                            |
| Monaco Editor            | https://github.com/microsoft/monaco-editor | MIT                                                                            |
| Lucide                   | https://github.com/lucide-icons/lucide     | ISC                                                                            |

当前便携目录用于本地开发验证，尚未作为公开发行包发布。
公开分发前应整理各精确版本的完整许可、对应源码获取方式、规则数据来源及 libcronet 的第三方声明。
JavaScript 精确依赖记录于 package-lock.json，Rust 精确依赖记录于 src-tauri/Cargo.lock。
