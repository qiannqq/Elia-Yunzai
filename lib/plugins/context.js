/**
 * 插件上下文
 *
 * 形状与 Yunzai-NG 的 PluginContext 对齐：插件只经这里登记能力，
 * 内核在卸载时按归属整批回收，插件作者不需要（也不会忘记）手工清理。
 *
 * 不实现的部分（command / render / kv / sql / config）给出可读的抛错，
 * 而不是让调用方收到 undefined is not a function。
 */
import path from "node:path"
import LruCache from "../util/lru.js"
import coreEvents from "./events.js"
import serviceRegistry from "./services.js"
import defaultScheduler from "../scheduler.js"
import defaultRoutes from "../web/router.js"

/**
 * HTTP 服务由加载器在启动时注入
 * 这样 context.js 不直接 import server（那个模块会读配置），
 * 自测环境里没有 node_modules 也能单独加载
 */
let defaultWeb = null
export function setDefaultWeb(server) {
  defaultWeb = server
}

const NOT_IMPLEMENTED = {
  command: "命令 DSL（ctx.command）",
  render: "模板渲染（ctx.render）",
  kv: "键值存储（ctx.kv）",
  sql: "数据库（ctx.sql）",
  config: "配置声明（ctx.config）",
  panel: "面板挂载（ctx.panel）",
}

function notImplemented(name) {
  return () => {
    throw new Error(
      `ctx.${name}（${NOT_IMPLEMENTED[name]}）在当前内核尚未实现；` +
        `可移植的只有登记与回收，详见 README「跨内核插件」一节`,
    )
  }
}

function wrapLogger(logger, name) {
  if (!logger) {
    return {
      mark: (...args) => console.log(`[${name}]`, ...args),
      info: (...args) => console.log(`[${name}]`, ...args),
      warn: (...args) => console.warn(`[${name}]`, ...args),
      error: (...args) => console.error(`[${name}]`, ...args),
      debug: () => {},
    }
  }
  const wrap = method => (...args) => {
    const fn = logger[method] || logger.info || logger.mark
    if (typeof fn === "function") fn.call(logger, `[${name}]`, ...args)
  }
  return {
    mark: wrap("mark"),
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    debug: wrap("debug"),
  }
}

/** 把插件内相对路径解析成绝对路径，拦掉 ../ 越界 */
export function safeResource(root, ...parts) {
  const base = path.resolve(root)
  const target = path.resolve(base, ...parts.map(String))
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`ctx.resource 路径越界：${parts.join("/")}`)
  }
  return target
}

/** 统一的登记入口 */
function own(scope, disposer, label) {
  if (typeof disposer === "function") scope.add(disposer, label)
  return disposer
}

/**
 * 造一个插件上下文
 * @param options.name 插件名（也是路由前缀、日志前缀、服务归属）
 * @param options.root 插件目录绝对路径
 * @param options.scope DisposalScope
 * @param options.signal 插件中止信号
 * @param options.events / services / scheduler / routes / web 可替换，便于单测
 * @param options.middleware (fn, { priority, owner }) => Disposer，由加载器提供
 * @param options.sendMessage? 预留
 */
export function createPluginContext({
  name,
  version = "0.0.0",
  root = process.cwd(),
  dataDir = null,
  scope,
  signal = null,
  logger = null,
  events = coreEvents,
  services = serviceRegistry,
  scheduler = defaultScheduler,
  routes = defaultRoutes,
  web = null,
  middleware = null,
}) {
  if (!scope) throw new Error("createPluginContext 需要 DisposalScope")
  const log = wrapLogger(logger, name)
  const webServer = web || defaultWeb

  /** 路由前缀：与 NG 一致，固定挂在 /plugin/<插件名> 下 */
  const scoped = sub => {
    const text = String(sub ?? "/")
    const withSlash = text.startsWith("/") ? text : `/${text}`
    return withSlash === "/" ? `/plugin/${name}` : `/plugin/${name}${withSlash}`
  }

  const ctx = {
    name,
    version,
    root,
    dataDir: dataDir || path.join(root, "data"),
    logger: log,
    signal: signal || new AbortController().signal,

    /** 周期任务 */
    every(interval, fn, options = {}) {
      return own(
        scope,
        scheduler.register({ plugin: name, kind: "interval", schedule: interval, fn, options, signal }),
        `every:${options.name || interval}`,
      )
    },

    /** cron 任务 */
    cron(expression, fn, options = {}) {
      return own(
        scope,
        scheduler.register({ plugin: name, kind: "cron", schedule: expression, fn, options, signal }),
        `cron:${options.name || expression}`,
      )
    },

    /** 内核事件 */
    on(event, handler, options = {}) {
      return own(
        scope,
        events.on(event, handler, { owner: name, priority: options.priority ?? 100 }),
        `on:${event}`,
      )
    },

    /** 中间件：在命令匹配之前执行 */
    middleware(fn, options = {}) {
      if (!middleware) throw new Error("当前内核未提供中间件登记能力")
      return own(scope, middleware(fn, { priority: options.priority ?? 100, owner: name }), "middleware")
    },

    /** HTTP 路由 */
    route(method, pattern, handler, options = {}) {
      const disposer = routes.add(method, scoped(pattern), handler, {
        owner: name,
        auth: options.auth ?? true,
        bodyLimit: options.bodyLimit,
        rawBody: options.rawBody,
      })
      own(scope, disposer, `route:${method} ${pattern}`)
      webServer?.ensure?.()
      return disposer
    },

    /** 静态目录 */
    static(urlPath, dir, options = {}) {
      const disposer = routes.addStatic(scoped(urlPath), dir, { owner: name, auth: options.auth ?? true })
      own(scope, disposer, `static:${urlPath}`)
      webServer?.ensure?.()
      return disposer
    },

    /** WebSocket 路由 */
    websocket(urlPath, handler, options = {}) {
      const disposer = routes.addSocket(scoped(urlPath), handler, {
        owner: name,
        verify: options.verify || null,
      })
      own(scope, disposer, `websocket:${urlPath}`)
      webServer?.ensure?.()
      return disposer
    },

    /** 跨插件服务 */
    provide(key, value) {
      return own(scope, services.provide(key, value, name), `provide:${key}`)
    },

    inject(key) {
      return services.get(key)
    },

    require(key, hint = "") {
      return services.require(key, hint)
    },

    async waitFor(key, timeout = 30000) {
      return await services.waitFor(key, timeout)
    },

    /** 缓存：随插件卸载清空 */
    cache(options = {}) {
      const cache = new LruCache(options)
      scope.add(() => cache.clear(), "cache")
      return cache
    },

    /** 额外清理钩子 */
    onDispose(fn) {
      return scope.add(fn, "onDispose")
    },

    /** 插件内资源路径 */
    resource(...parts) {
      return safeResource(root, ...parts)
    },

    /**
     * 收下一个自己创建的句柄
     * 定时器会 clear，服务/连接会 close，函数按清理函数处理
     */
    adopt(handle) {
      if (!handle) return handle
      if (typeof handle === "function") return scope.add(handle, "adopt")
      if (typeof handle.close === "function") {
        return scope.add(() => handle.close(), "adopt:close")
      }
      if (typeof handle === "object" && typeof handle.then !== "function") {
        return scope.add(() => clearInterval(handle), "adopt:timer")
      }
      return handle
    },

    /** 带插件信号的 fetch */
    http(input, init = {}) {
      return fetch(input, { ...init, signal: init.signal || ctx.signal })
    },
  }

  for (const key of Object.keys(NOT_IMPLEMENTED)) {
    if (ctx[key]) continue
    ctx[key] = notImplemented(key)
  }

  return ctx
}

export default createPluginContext
