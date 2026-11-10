# icqq 适配器

用 [icqq](https://github.com/icqqjs/icqq) 登录 QQ，收发消息。

## 启用

`config/config/bot.yaml`：

```yaml
adapter: icqq
```

## 结构

适配器随插件分发：`adapter.js` 在启动前被加载器 preload，`index.js` 是插件外壳，用于在插件列表中显示与随插件热重载。

```js
export default defineAdapter({
  id: "icqq",
  segment, // 消息段工厂
  prepare(), // 首次启动时收集账号配置
  create(botConfig, ctx), // 返回 Bot 实例
  login(bot, ctx), // 登录，返回 false 表示只加载插件
}, "icqq-adapter")
```

`ctx` 提供 `cfg`、`logger` 与 `segment`。Bot 需要带 `uin`，并能接收 `on(event, handler)`。

## 配置

配置文件为 `plugins/icqq-adapter/config/config.yaml`，缺失时由 `default.yaml` 生成。首次启动会从旧的 `config/config/qq.yaml` 与 `config/config/bot.yaml` 迁移。

| 键 | 说明 |
| --- | --- |
| `enable` | 是否启用登录 |
| `qq` / `pwd` / `platform` | 账号、密码、登录端口 |
| `sign_api_addr` | 签名服务地址 |
| `slider_ticket_addr` | 滑动验证 ticket 服务地址 |

`data_dir` 由适配器计算为 `data/icqq/<qq>`。
