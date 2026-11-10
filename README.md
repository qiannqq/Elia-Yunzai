# Elia-Yunzai v3 伊莉雅

<p align="center">
  <img src="./resources/elia.png" width="30%" height="30%">
</p>

由Miao-Yunzai修改，主轻量化，优化性能/内存开销，增加和修改一些机制

### 简介
开发该Yunzai的目的是本组织成员不便迁移到TRSS-Yunzai，又需要一个轻量化但可以正常使用的Miao-Yunzai，因此 **Elia-Yunzai** 诞生了

### 修改的机制
1. 内核与插件解耦：lib 不再 import 任何插件，也不写死插件目录
* miao-plugin、genshin 均为可选插件；安装后由 `plugins/genshin-compat` 提供米游社相关能力
* 内核边界由 `pnpm run check:kernel` 检查，`pnpm run test:kernel` 覆盖不依赖第三方模块的部分
2. 登录与收发由适配器插件负责，内核不依赖具体协议库；默认跳过登录，需要可以在配置文件中打开
3. 重写Redis启动逻辑
4. 插件包(含index.js的大型插件)可以通过调用`changePlugin`方法来热重载插件，key参数为插件包的目录名（例如miao-plugin）
5. 修改重启逻辑，防止重启时报错父子进程不协调的问题

更多详见[CHANGELOG.md](./CHANGELOG.md)

### 增加的机制
1. 内置Stdin标准输入，可以直接在控制台执行指令
* 如果装了Lain-plugin等自带标准输入的插件，可删除`plugins/system/stdin.js`自带的标准输入
2. 对`log: false`的插件输出Debug日志，方便排查问题
3. 可使用`BotID:GroupID`的格式添加指定Bot的黑白名单
4. group.yaml可配置“群配置是否继承默认配置禁用或启用的功能”
5. `#日志`增加了`#控制台日志`，使用`#控制台日志`将会把日志以终端的方式渲染为图片后发送，更方便阅读
6. JS插件被修改（新增、修改、卸载）时，支持热重载（新增、重载、卸载）定时任务
7. 渲染后端与适配器均可插拔：`renderers/` 下是独立包，适配器随插件分发；`renderer.yaml` 的 `name` 留空时按模板自动分流：含 `<script>` 的模板先试支持脚本的后端，其余优先走进程内的 shotium

更多详见[CHANGELOG.md](./CHANGELOG.md)


### 安装
```bash
git clone --depth=1 https://gitee.com/Orbiter_StellarTrek/Elia-Yunzai.git
cd Elia-Yunzai
pnpm i
```
### 配置
默认配置内置于 `lib/config/defaults.js`。首次启动会生成 `config/default_config/`、`config/config/`，以及 `plugins/`、`renderers/`、`data/`、`resources/`、`temp/` 目录；`config/` 可整体删除，启动时重建。

登录相关配置（账号、密码、签名 API、滑块地址、是否登录）位于 `plugins/icqq-adapter/config/config.yaml`，首次启动会从旧的 `qq.yaml` 与 `bot.yaml` 迁移。

Redis 不可用时自动降级为内存实现，数据不落盘。

### 由Miao-Yunzai迁移（换源）至Elia-Yunzai
```bash
git reset --hard 9fa4496d25e53622b2701b25a061e05f9c93d863
git remote set-url origin https://gitee.com/Orbiter_StellarTrek/Elia-Yunzai.git
git pull
```

### 安装genshin（如果需要）
```bash
git clone --depth=1 https://gitee.com/TimeRainStarSky/Yunzai-genshin.git ./plugins/genshin
```

### 安装miao-plugin（如果需要）
按 miao-plugin 官方仓库的说明 clone 到 `./plugins/miao-plugin`。内核不依赖该插件，安装后由 `plugins/genshin-compat` 提供渲染布局与消息前缀。

### 内核扩展点
内核只提供通用能力，插件相关部分经以下入口注册：

| 入口 | 用途 |
| --- | --- |
| `Runtime.provide(name, factory, key)` | 注册 lazily 求值的服务，插件中以 `e.runtime.<name>` 访问 |
| `Runtime.onInit(fn, key)` | 每条消息在 `Runtime.init` 中执行，用于补充 `e.user` 等实例字段 |
| `Runtime.renderData(fn, key)` | 追加渲染数据，合并顺序为 内核默认 → 提供者 → 调用方 data → 内核终值 |
| `Loader.useMsgPreprocessor(fn, { key, priority })` | 在事件过滤之后、命令匹配之前加工 `e` |
| `Handler.add()` / `plugin` 基类 | 命令、上下文与 handler 扩展 |

`plugins/genshin-compat` 使用上述入口注册消息前缀、渲染布局与米游社 model，仅在检测到对应插件时生效。

### 渲染后端

渲染后端是 `renderers/` 下的独立包，内核只负责发现、排序与调度。

- 契约：`index.js` 导出 `(config, host) => ({ id, type, render(name, data), support_script? })`，`host` 为 `{ Renderer, cfg, logger }`。缺少 `id`、`type` 不受支持或 `render` 不是函数的后端不会注册。
- 安装：`renderers/puppeteer`、`renderers/shotium` 各自带 `package.json`，按目录内 README 安装；一个都没有时发送图片会提示「没有可用的渲染后端」。
- 插件自带后端：`ctx.renderer(provider)`，插件卸载时自动摘除。
- `lib/puppeteer/puppeteer.js` 与 `#yunzai` 的 `puppeteer` 导出仍可用。

### 适配器

登录与收发由适配器负责，内核只认 `Bot` 的形状。适配器随插件分发：插件目录下放一个 `adapter.js`，启动前由加载器 preload。

- 声明：`adapter.js` 内 `export default { id, prepare?, create(botConfig, ctx), login?(bot, ctx), segment? }`，也可用 `defineAdapter(definition, owner)` 注册。
- 契约：`create` 返回的 Bot 需带 `uin` 并能接收 `on(event, handler)`；`login` 返回 `false` 表示本次不登录、只加载插件。
- 启用：`config/config/bot.yaml` 的 `adapter`，留空时使用唯一已注册的适配器。
- 插件自带适配器：`ctx.adapter(provider)` 或全局 `defineAdapter`，插件卸载时自动摘除。
- 没有可用适配器时不中断启动：内核提供一个完整的占位 Bot（含 `emit` 等常用方法），插件照常加载，只在日志里提示。

### 跨内核插件（同时兼容 Yunzai-NG）

插件可写成 `{ name, setup }` 对象，无需引入框架包：

```js
export default {
  name: "my-plugin",
  version: "1.0.0",
  setup(ctx) {
    ctx.every("60s", () => ctx.logger.mark("tick"))
    return () => ctx.logger.mark("unloaded")
  },
}
```

目录入口与类插件写法照旧加载。`ctx` 与 NG 同名同义：`every` / `cron` / `on` / `middleware` / `route` / `static` / `websocket` / `provide` / `inject` / `require` / `waitFor` / `cache` / `onDispose` / `resource` / `adopt`。

定时任务经 `ctx.every` / `ctx.cron` 登记；自建句柄交给 `ctx.onDispose`，或使用 `ctx.adopt(timer)`：

```js
setup(ctx) {
  const timer = setInterval(poll, 30_000)
  timer.unref?.()
  ctx.onDispose(() => clearInterval(timer))
}
```

#### 最小化改动

旧插件无需改写为 `ctx` 形式，加一行登记即可：

```js
const timer = setInterval(poll, 30_000)
timer.unref?.()
registerDispose(() => clearInterval(timer), "轮询")
```

| 函数 | 用途 |
| --- | --- |
| `registerDispose(fn, label)` | 登记清理函数，卸载时逆序执行；返回幂等的取消函数 |
| `ownTimer(timer, label)` | 登记定时器或间隔器的清除 |
| `onPluginUnload(fn, label)` | `registerDispose` 的别名 |

归属由加载器在 import、`init`、命令回调与定时任务中记录；无归属时仅告警。

未登记的定时器、事件监听与 `net.Server` 在卸载时按归属兜底清扫，日志格式：

```
[插件回收] miao-plugin：登记项 3，事件 1，服务 12，兜底自建项 定时器 2 / 监听 4 / 连接 0
```

`process.stdin` / `stdout` / `stderr` 上的监听不参与记账与摘除。

卸载顺序：

1. `abort.abort()`
2. `scope.dispose()`：逆序执行 disposer
3. 按 owner 清扫事件、服务、消息预处理器、中间件、路由与定时任务
4. 兜底清扫未登记的定时器、监听与套接字
5. 摘除命令 handler

`config/default_config/web.yaml` 默认 `enable: false`；开启后监听非回环地址须设置 `token`，否则拒绝启动。

`pnpm run test:compat` 覆盖上述链路。
