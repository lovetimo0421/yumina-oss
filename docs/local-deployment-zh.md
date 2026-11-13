# 本地部署配置

日常部署值统一放在仓库根目录 `.env`。该文件被 Git 忽略；参考 `.env.example`，不要提交真实密钥。

## 电脑运行，手机连接电脑热点

```dotenv
YUMINA_EDITION=local
HOST=0.0.0.0
PORT=3000
YUMINA_PUBLIC_HOST=192.168.137.1
```

保留已经生成的 `BETTER_AUTH_SECRET`。手机和电脑统一打开 `http://192.168.137.1:3000`。热点 IP 以电脑的实际地址为准。

`HOST` 表示服务监听的网卡地址；`YUMINA_PUBLIC_HOST` 是浏览器访问的电脑地址，不能填写 `0.0.0.0`，也不包含协议、端口或路径。

默认自动推导访问地址和登录地址；本地 HTTP 的 Cookie、沙箱资源白名单也跟随该地址。HTTPS 和 hosted 模式保留安全 Cookie；沙箱的网络隔离继续保留。

## 改端口

例如把 `.env` 中 `PORT=3000` 改成 `PORT=3088`，关闭原进程，再运行：

```powershell
node scripts/start.mjs
```

访问地址自动变为 `http://192.168.137.1:3088`。只改 `.env` 不需要重新构建；启动日志会显示监听地址和实际访问地址。

Windows 防火墙是独立的系统设置，不会随 `.env` 自动变化。需要管理员在防火墙规则中同步更新端口。例如已有旧规则时：

```powershell
Get-NetFirewallRule -DisplayName 'Yumina Hotspot TCP 3000' |
  Get-NetFirewallPortFilter |
  Set-NetFirewallPortFilter -LocalPort 3088
```

规则显示名可不改，真正生效的是端口过滤条件。热点 IP 变化时，还要同步更新规则的本地地址和允许网段。

## HTTPS 或反向代理

```dotenv
PORT=3088
PUBLIC_ORIGIN=https://yumina.example.com
```

内部监听 3088，但浏览器和登录使用 HTTPS 地址。`BETTER_AUTH_URL` 默认跟随公开地址，也可以单独覆盖。

优先级：公开地址使用 `PUBLIC_ORIGIN`，其次兼容旧的 `BETTER_AUTH_URL`，最后才按 `YUMINA_PUBLIC_HOST` 和 `PORT` 推导。显式完整 URL 的端口不会随 `PORT` 改变。普通热点部署应留空这两个完整 URL，避免重复配置。

## 配置边界与备份

- API Key 和模型连接在应用设置中维护。
- 数据目录仍由 `YUMINA_DATA_DIR` 等现有配置控制，本次不迁移数据。
- UUID 兼容及 SQL 文件打包是程序兼容逻辑，不是需要日常调整的部署值。
- 修改源码才需要重新构建。首次构建请使用项目声明的 pnpm 版本；`start.mjs` 内的自动构建仍要求终端的 `pnpm` 指向该版本。
- 备份数据目录和 `.env`，保留原始 `BETTER_AUTH_SECRET`，不要为了修改端口重置密钥。
