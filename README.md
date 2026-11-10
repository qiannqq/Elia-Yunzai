# Elia-Yunzai v3 伊莉雅

<p align="center">
  <img src="./resources/elia.png" width="30%" height="30%">
</p>

由Miao-Yunzai修改，主轻量化，优化性能/内存开销，增加和修改一些机制

### 简介
开发该Yunzai的目的是本组织成员不便迁移到TRSS-Yunzai，又需要一个轻量化但可以正常使用的Miao-Yunzai，因此 **Elia-Yunzai** 诞生了

### 修改的机制
1. 内核与插件解耦：lib 不再 import 任何插件，也不写死插件目录
* miao-plugin、genshin 都成为可选插件：装了就由 `plugins/genshin-compat` 把米游社相关能力接回来，不装也不影响启动
* 内核边界可由 `pnpm run check:kernel` 检查，`pnpm run test:kernel` 覆盖不依赖第三方模块的部分
2. 默认跳过登录ICQQ，需要可以在配置文件中打开
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
7. 渲染后端可插拔，`renderer.yaml` 的 `name` 留空时按模板自动分流：含 `<script>` 的模板交给 puppeteer，其余优先走进程内的 shotium

更多详见[CHANGELOG.md](./CHANGELOG.md)


### 安装
```bash
git clone --depth=1 https://gitee.com/Orbiter_StellarTrek/Elia-Yunzai.git
cd Elia-Yunzai
pnpm i
```
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
按 miao-plugin 官方仓库的说明 clone 到 `./plugins/miao-plugin` 即可。内核不依赖它，装了之后由 `plugins/genshin-compat` 自动接回渲染布局与消息前缀。

### 内核扩展点
内核只提供通用能力，插件相关的部分通过下面的入口注册，内核本身不需要认识具体插件：

| 入口 | 用途 |
| --- | --- |
| `Runtime.provide(name, factory, key)` | 注册 lazily 求值的服务，插件里用 `e.runtime.<name>` 访问 |
| `Runtime.onInit(fn, key)` | 每条消息在 `Runtime.init` 时执行，适合补充 `e.user` 之类的实例字段 |
| `Runtime.renderData(fn, key)` | 追加渲染数据，合并顺序为 内核默认 → 提供者 → 调用方 data → 内核终值 |
| `Loader.useMsgPreprocessor(fn, { key, priority })` | 在事件过滤之后、命令匹配之前加工 `e`（命令标准化、补充字段等） |
| `Handler.add()` / `plugin` 基类 | 命令、上下文、handler 等常规扩展 |

`plugins/genshin-compat` 就是这套入口的一个完整例子：消息前缀、渲染布局、米游社 model 全部由它注册，且只在检测到对应插件时才生效。
