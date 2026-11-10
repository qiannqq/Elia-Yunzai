# puppeteer 渲染后端

把 HTML 模板渲染成图片，支持带 `<script>` 的模板。它是 `renderers/` 目录下的一个独立包，内核只负责发现与调度。

## 安装

放在 Yunzai 根目录的 `renderers/puppeteer` 下，然后安装依赖：

```bash
cd renderers/puppeteer
pnpm install
```

根目录的 `pnpm-workspace.yaml` 已包含 `renderers/**`，所以根目录执行 `pnpm install` 也会一并安装。

首次安装会下载 Chromium。已有 Chromium 时可以在 `config.yaml` 里指定 `chromiumPath`，或连接现成的浏览器：`puppeteerWS`。

## 配置

复制 `config_default.yaml` 为 `config.yaml`（该文件不入库），按需修改。常用项：

| 项 | 说明 |
|---|---|
| `chromiumPath` | 指定 Chromium / Edge 路径 |
| `puppeteerWS` | 连接已存在的浏览器，如 `ws://browserless:3000` |
| `headless` | 无头模式，默认 `"new"` |
| `args` | 启动参数 |
| `idleTimeout` | 空闲多久自动关闭浏览器，默认 30 分钟 |
| `restartNum` | 累计截图多少次后重启浏览器，默认 100 |
| `pageGotoParams` | 页面跳转参数 |

旧版 `config/config/bot.yaml` 里的 `chromium_path`、`puppeteer_ws`、`puppeteer_timeout`、`puppeteer_idle` 仍然会被读取，作为上面各项的回落值。

## 契约

`index.js` 导出一个工厂函数：

```js
export default function (config, host) {
  return new Puppeteer(config, host)
}
```

- `config`：`config.yaml` 的内容，没有该文件时是空对象。
- `host`：内核注入的 `{ Renderer, cfg, logger }`。基类与内核配置优先从这里取，取不到时回落到仓库内的模块，方便把本包放到任意目录或独立安装。
- 返回值需要 `id`、`type`（目前只有 `image`）、`render(name, data)`，可选 `support_script`。

## 卸载

删掉整个目录，或把 `config/config/renderer.yaml` 的 `name` 改成别的前端即可。
