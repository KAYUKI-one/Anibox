# 配置说明

## 导入

主页可粘贴分享链接或原生 JSON，也可从文件导入。订阅页添加订阅地址，点击更新获取节点。
节点页修改单个出站；内核页编辑完整配置。配置使用严格 JSON，保存后可执行内核校验。
订阅更新保留已在本地修改的节点。

## 入站与出站

默认 SOCKS 入站为 `127.0.0.1:10808`，HTTP 入站为 `127.0.0.1:10809`，端口可在设置中修改。
系统代理需要监听本机的无认证 HTTP 或 mixed 入站。TUN 配置需要对应内核的 TUN 入站。

在 `outbounds` 中定义出站并设置唯一 `tag`，再通过路由规则将流量送往该出站。
完整原生配置不会自动补充入站、DNS、路由或统计接口。

TUN 连接成功后暂时停用 Windows 系统代理和 PAC，断开后恢复原设置。
默认 sing-box TUN 使用 IPv4 地址和 `ipv4_only` DNS 策略，不返回 AAAA 记录。
需要 IPv6 时可使用完整原生配置，同时配置 IPv6 TUN 地址、DNS 策略，并确认规则对应的直连或代理出站具备 IPv6 连通性。

## 按域名分流

以下规则将 `google.com` 及其子域名交给已有的 `proxy-google` 出站，不需要外部规则文件。
将具体规则放在更宽泛的规则之前；`googleapis.com`、`gstatic.com` 等其他域名需要另外添加。

Xray：加入 `routing.rules`。

```json
{
  "type": "field",
  "domain": ["domain:google.com"],
  "outboundTag": "proxy-google"
}
```

sing-box：加入 `route.rules`。

```json
{
  "domain_suffix": ["google.com"],
  "action": "route",
  "outbound": "proxy-google"
}
```

Xray 精确匹配单个域名使用 `full:google.com`；sing-box 对应 `"domain": ["google.com"]`。
域名规则需要连接携带目标域名，或通过配置中的嗅探等方式获得域名；仅有目标 IP 时不能直接匹配域名。

## 规则集

Xray 的 `geosite:cn`、`geoip:cn` 分别依赖 `geosite.dat`、`geoip.dat`。
sing-box 的 `rule_set` 需要声明本地文件或远程规则集，并在规则中引用对应 `tag`。
默认大陆分流使用 `geosite-cn` 和 `geoip-cn`，内网 IP 由内置规则处理。
广告过滤、按服务分流等功能可以自行添加相应规则集。

原生配置中的相对文件路径以实际内核所在目录为基准；自定义规则建议使用绝对路径，或使用 sing-box 远程规则集。

## 内核与规则更新

应用运行期间自动检查两种内核的官方 GitHub 稳定版；内核页也可手动检查。
发现新版后点击更新，程序自动下载、校验 SHA256，并检查内核版本和当前所选配置（如适用）。
更新成功后重新连接生效；下载或校验失败保留原内核。更新窗口提供版本回退。

sing-box 的默认大陆 SRS 规则每 24 小时后台更新，无需重启正在运行的连接；失败使用旧缓存。
Xray DAT 随官方内核更新。自定义原生配置中的规则下载和更新由该配置及内核自身管理。

## 文件目录

默认配置保存在 `%LOCALAPPDATA%\io.anibox.desktop\workspace.json`，原生配置文本保存在其中的 `profiles`。
背景图片副本保存在同级 `backgrounds` 文件夹；设置中显示当前实际路径，并提供打开文件夹和更改目录的入口。
更改目录会复制配置和背景，原目录保留；请选择没有其他配置的空目录。
手动修改配置文件前请退出应用；在应用内编辑原生 JSON 可以直接保存和校验。
删除背景图片后，在回到应用或重新打开相应页面时显示默认背景。
背景按原始比例铺满，自动裁剪超出画框的部分。自动对焦优先保留画面信息较多的区域；需要时可切换为手动焦点。
外观设置中的预览对应所选页面，卡片不透明度和背景模糊可以分别调整；控件及编辑区保留必要底色。

## 日志

日志页可切换应用日志和内核输出。默认生成的配置启用 `info` 级别；原生配置保留自己的日志级别和输出设置。
若原生配置把日志写入指定文件，需直接查看该文件，日志页显示的是内核标准输出与错误输出。

应用与内核输出分别保存在 `%LOCALAPPDATA%\io.anibox.desktop\logs\app.log` 和 `core.log`。
设置中可打开日志文件夹。每个文件最多 1 MB，另保留两份轮转文件；超过 7 天的文件自动清理。
日志页只读取最近的输出，后台写入不依赖日志页是否打开；“清空”同时删除该类轮转日志，不会停止内核。
日志目录不随配置、背景的存储目录迁移。

## 官方文档

- [Xray 路由](https://xtls.github.io/config/routing.html)
- [sing-box 路由规则](https://sing-box.sagernet.org/configuration/route/rule/)
- [sing-box 规则集](https://sing-box.sagernet.org/configuration/rule-set/)
