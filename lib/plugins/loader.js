import fs from "node:fs/promises"
import fsSync from "node:fs"
import lodash from "lodash"
import cfg from "../config/config.js"
import plugin from "./plugin.js"
import segment from "../adapter/segment.js"
import chokidar from "chokidar"
import moment from "moment"
import path from "node:path"
import { pathToFileURL } from "node:url"
import Runtime from "./runtime.js"
import Handler from "./handler.js"
import KeyedRegistry from "./registry.js"
import { DisposalScope } from "./scope.js"
import createPluginContext, { setDefaultWeb } from "./context.js"
import coreEvents from "./events.js"
import serviceRegistry from "./services.js"
import scheduler from "../scheduler.js"
import routeTable from "../web/router.js"
import webServer from "../web/server.js"
import leakguard from "./leakguard.js"
import { bindOwner, unbindOwner, installGlobals } from "./owners.js"

/** 插件路由挂到这个服务上；没有插件登记路由时不会真的 listen */
setDefaultWeb(webServer)

/** 老插件只加一行 registerDispose(...) 就能登记，不需要改成 ctx 写法 */
installGlobals()

/** 插件 setup 的超时时间，避免一个卡死的插件拖住整个加载流程 */
const SETUP_TIMEOUT = 30000

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

/** 新式插件：与 Yunzai-NG 的 looksLikePlugin 判据一致 */
function isObjectPlugin(value) {
  return !!value && typeof value === "object" && typeof value.name === "string" && typeof value.setup === "function"
}

/**
 * 对象插件在 priority 里也要有可构造的 class。
 * 面板、调试器等第三方工具会直接 new entry.class()，class 为 null 时会抛
 * 「Cannot create proxy with a non-object as target」。
 */
function objectPluginClass(definition, ctx) {
  const Cls = class {
    constructor(e) {
      this.name = definition.name
      this.dsc = definition.description || "无"
      this.event = definition.event || "message"
      this.priority = definition.priority ?? 5000
      this.rule = []
      this.handler = {}
      this.e = e
      this.ctx = ctx
    }
  }
  Object.defineProperty(Cls, "name", { value: definition.name })
  return Cls
}

/** 全局变量 plugin */
/** 消息段工厂：适配器启动后会替换成平台自己的实现 */
global.plugin = plugin
global.segment ??= segment

/**
 * 编译正则缓存
 * 每条消息都会对所有插件规则执行 new RegExp().test()，重复编译开销与 GC 压力较大，
 * 这里按正则来源缓存已编译实例，复用前重置 lastIndex 保证与每次新建行为一致。
 */
const regExpCache = new Map()
function getCachedRegExp(reg) {
  const key = reg instanceof RegExp ? `re ${reg.source} ${reg.flags}` : `str ${reg}`
  let re = regExpCache.get(key)
  if (!re) {
    re = reg instanceof RegExp ? reg : new RegExp(reg)
    /** 防止动态生成的正则导致缓存无限增长 */
    if (regExpCache.size > 5000) regExpCache.clear()
    regExpCache.set(key, re)
  }
  return re
}

/**
 * 加载插件
 */
class PluginsLoader {
  constructor() {
    this.priority = []
    this.handler = {}
    this.task = []
    this.dir = "plugins"

    /** 命令冷却cd */
    this.groupGlobalCD = {}
    this.singleCD = {}

    /** 插件监听 */
    this.watcher = {}
    this.eventMap = {
      message: ["post_type", "message_type", "sub_type"],
      notice: ["post_type", "notice_type", "sub_type"],
      request: ["post_type", "request_type", "sub_type"],
    }

    this.msgThrottle = {}

    /** 消息预处理器，插件通过 useMsgPreprocessor 注册 */
    this.msgPreprocess = new KeyedRegistry()

    /** 中间件，在命令匹配之前执行，可通过不调用 next 中止 */
    this.middlewares = new KeyedRegistry()

    /** 每个插件一份回收作用域：key => { key, name, namespace, scope, abort, ctx } */
    this.instances = new Map()
    /** import 阶段（模块顶层）先建的作用域，等实例化时被认领 */
    this.moduleScopes = new Map()

    /** app/ready 只发一次 */
    this.readyFired = false
  }

  /**
   * 注册消息预处理器
   *
   * 在事件过滤之后、accept 与命令匹配之前执行，可在此标准化消息内容与补充事件字段。
   * @param fn (e, loader) => void
   * @param options.key 去重键，同 key 覆盖
   * @param options.priority 越小越先执行
   * @param options.owner 归属插件，卸载时按它批量摘除
   */
  useMsgPreprocessor(fn, { key = fn, priority = 5000, owner = null } = {}) {
    this.msgPreprocess.set(key, fn, priority, owner)
    return this
  }

  /** 注销消息预处理器 */
  offMsgPreprocessor(key) {
    this.msgPreprocess.delete(key)
    return this
  }

  /** 按归属摘除消息预处理器 */
  offMsgPreprocessorByOwner(owner) {
    return this.msgPreprocess.deleteByOwner(owner)
  }

  /** 依次执行消息预处理器，单个出错不影响后续 */
  runMsgPreprocessor(e) {
    for (const { key, value: fn } of this.msgPreprocess.values()) {
      try {
        fn(e, this)
      } catch (err) {
        logger.error(`[消息预处理][${key}] 执行出错`)
        logger.error(err)
      }
    }
  }

  /**
   * 注册中间件
   *
   * 与 NG 的 ctx.middleware 同形：(e, next) => void，priority 越小越先执行，
   * 不调用 next 即视为吞掉这条消息。
   * @returns Disposer
   */
  useMiddleware(fn, { key = fn, priority = 100, owner = null } = {}) {
    this.middlewares.set(key, fn, priority, owner)
    return () => this.middlewares.delete(key)
  }

  offMiddleware(key) {
    return this.middlewares.delete(key)
  }

  /**
   * 执行中间件链
   * @returns 链是否走到底部（false 表示被中间件中止）
   */
  async runMiddleware(e) {
    const list = this.middlewares.values()
    if (!list.length) return true

    let index = -1
    let reachedEnd = false
    const dispatch = async i => {
      if (i <= index) throw new Error("next() 被重复调用")
      index = i
      if (i >= list.length) {
        reachedEnd = true
        return
      }
      const { key, value: fn } = list[i]
      try {
        await fn(e, () => dispatch(i + 1))
      } catch (err) {
        logger.error(`[中间件][${key}] 执行出错`)
        logger.error(err)
      }
    }
    await dispatch(0)
    return reachedEnd
  }

  async getPlugins() {
    if (!fsSync.existsSync(this.dir)) fsSync.mkdirSync(this.dir, { recursive: true })
    const files = await fs.readdir(this.dir, { withFileTypes: true }).catch(() => [])
    const ret = []
    for (const val of files) {
      if (val.isFile()) continue
      const tmp = {
        name: val.name,
        path: `../../${this.dir}/${val.name}`,
      }

      try {
        if (await fs.stat(`${this.dir}/${val.name}/index.js`)) {
          tmp.path = `${tmp.path}/index.js`
          ret.push(tmp)
          continue
        }
      } catch (err) {}

      const apps = await fs.readdir(`${this.dir}/${val.name}`, { withFileTypes: true })
      for (const app of apps) {
        if (!app.isFile()) continue
        if (!app.name.endsWith(".js")) continue
        ret.push({
          name: `${tmp.name}/${app.name}`,
          path: `${tmp.path}/${app.name}`,
        })
        /** 监听热更新 */
        this.watch(val.name, app.name)
      }
    }
    return ret
  }

  /**
   * 预加载适配器
   *
   * 适配器随插件分发：插件目录下的 adapter.js 在启动前被 import，
   * 模块顶层的 defineAdapter(...) 会注册到 globalThis.AdapterRegistry。
   */
  async preloadAdapters() {
    const files = await this.getPlugins()
    for (const file of files) {
      if (file.name.endsWith(".js")) continue
      await this.preloadAdapter(file.name)
    }
    return globalThis.AdapterRegistry ?? null
  }

  /** 加载单个插件目录下的 adapter.js；热重载时也走这里重新注册 */
  async preloadAdapter(name) {
    const target = path.resolve(this.dir, name, "adapter.js")
    let exists = false
    try {
      exists = (await fs.stat(target)).isFile()
    } catch (err) {}
    if (!exists) return null

    this.moduleScope(name)
    try {
      await leakguard.run(name, () => import(pathToFileURL(target).href))
    } catch (err) {
      logger.error(`[适配器] ${name} 加载失败`)
      logger.error(err)
      return null
    }
    return globalThis.AdapterRegistry ?? null
  }

  /**
   * 监听事件加载
   * @param isRefresh 是否刷新
   */
  async load(isRefresh = false) {
    this.delCount()
    if (isRefresh) this.priority = []
    if (this.priority.length) return

    /** 记录归属，旧插件自己 new 出来的定时器/监听也能在卸载时回收 */
    leakguard.install()

    const files = await this.getPlugins()

    logger.info("-----------")
    logger.info("加载插件中...")

    this.pluginCount = 0
    const packageErr = []

    if (cfg.bot.serial_load) {
      for (const file of files) {
        await this.importPlugin(file, packageErr)
      }
    } else {
      await Promise.allSettled(files.map(file => this.importPlugin(file, packageErr)))
    }

    this.packageTips(packageErr)
    this.createTask()

    logger.info(`加载定时任务[${this.task.length}个]`)
    logger.info(`加载插件[${this.pluginCount}个]`)

    /** 优先级排序 */
    this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])

    if (!this.readyFired) {
      this.readyFired = true
      coreEvents.emit("app/ready")
    }
  }

  /**
   * 模块级作用域：文件被 import 之前先建好，并认到该文件头上
   * 这样模块顶层的「副作用代码」（直接 setInterval、直接注册监听）也归这个插件
   */
  moduleScope(key) {
    let scope = this.moduleScopes.get(key)
    if (!scope) {
      scope = new DisposalScope(key)
      this.moduleScopes.set(key, scope)
      bindOwner(key, scope)
    }
    return scope
  }

  async importPlugin(file, packageErr) {
    try {
      this.moduleScope(file.name)
      const app = await leakguard.run(file.name, () => import(file.path))
      await this.registerModule(file, app)
    } catch (error) {
      if (packageErr && error.stack.includes("Cannot find package")) {
        packageErr.push({ error, file })
      } else {
        logger.error(`加载插件错误：${logger.red(file.name)}`)
        logger.error(decodeURI(error.stack))
      }
    }
  }

  /** 把 import 结果里的每个导出登记进内核 */
  async registerModule(file, exported) {
    const app = exported?.apps ? { ...exported.apps } : exported
    const pluginArray = []
    lodash.forEach(app, p => pluginArray.push(this.loadPlugin(file, p)))
    for (const i of await Promise.allSettled(pluginArray)) {
      if (i?.status && i.status != "fulfilled") {
        logger.error(`加载插件错误：${logger.red(file.name)}`)
        logger.error(decodeURI(i.reason))
      }
    }
  }

  /**
   * 建一个插件作用域
   * 之后这个插件登记的一切都挂在 scope 上，卸载时按逆序回收
   */
  createInstance(key, name, { namespace = "", version = "0.0.0" } = {}) {
    /** 复用 import 阶段就已经建好的作用域，让模块顶层登记的东西与实例共享同一份回收簿 */
    const scope = this.moduleScopes.get(key) ?? new DisposalScope(key)
    this.moduleScopes.delete(key)
    bindOwner(key, scope)
    const abort = new AbortController()
    const dir = key.split("/")[0]
    const ctx = createPluginContext({
      name,
      owner: key,
      version,
      root: path.resolve(process.cwd(), this.dir, dir),
      dataDir: path.resolve(process.cwd(), "data", name),
      scope,
      signal: abort.signal,
      logger: globalThis.logger,
      renderers: globalThis.RendererRegistry ?? null,
      adapters: globalThis.AdapterRegistry ?? null,
      middleware: (fn, options) => this.useMiddleware(fn, { ...options, owner: key }),
    })
    const record = { key, name, namespace, version, scope, abort, ctx }
    this.instances.set(key, record)
    return record
  }

  /** 执行插件 setup：结果里的函数当作清理钩子，失败则整份回收 */
  async runSetup(record, setup) {
    try {
      const ret = await withTimeout(
        Promise.resolve(leakguard.run(record.key, () => setup(record.ctx))),
        SETUP_TIMEOUT,
        `插件 ${record.name} 初始化超时（${SETUP_TIMEOUT}ms）`,
      )
      if (typeof ret === "function") record.scope.add(ret, "setup")
      return true
    } catch (err) {
      logger.error(`[插件初始化] ${record.name} 失败，已回滚`)
      logger.error(err?.stack || err)
      this.release(record.key)
      return false
    }
  }

  async loadPlugin(file, p) {
    /** 新式插件：{ name, setup(ctx) }，不继承 plugin 类 */
    if (isObjectPlugin(p)) {
      this.pluginCount++
      const record = this.createInstance(file.name, p.name, {
        namespace: p.name,
        version: p.version || "0.0.0",
      })
      logger.debug(`加载插件 [${file.name}][${p.name}]`)
      if (!(await this.runSetup(record, p.setup))) return
      this.priority.push({
        class: objectPluginClass(p, record.ctx),
        object: p,
        key: file.name,
        name: p.name,
        priority: p.priority ?? 5000,
        event: p.event || "message",
      })
      return
    }

    if (!p?.prototype) return
    this.pluginCount++
    const plugin = new p()
    logger.debug(`加载插件 [${file.name}][${plugin.name}]`)

    const record = this.createInstance(file.name, plugin.name, {
      namespace: plugin.namespace || file.name,
    })
    plugin.ctx = record.ctx

    /** 执行初始化，返回 return 则跳过加载 */
    if (plugin.init) {
      let ret
      try {
        ret = await withTimeout(
          Promise.resolve(leakguard.run(file.name, () => plugin.init(record.ctx))),
          SETUP_TIMEOUT,
          `插件 ${plugin.name} 初始化超时（${SETUP_TIMEOUT}ms）`,
        )
      } catch (err) {
        logger.error(`[插件初始化] ${plugin.name} 失败，已回滚`)
        logger.error(err?.stack || err)
        this.release(file.name)
        return
      }
      if (ret == "return") {
        this.release(file.name, { silent: true })
        return
      }
    }
    /** 初始化定时任务 */
    this.collectTask(plugin.task, file.name, p)
    this.priority.push({
      class: p,
      key: file.name,
      name: plugin.name,
      priority: plugin.priority,
      event: plugin.event,
    })
    if (plugin.handler) {
      lodash.forEach(plugin.handler, ({ fn, key, priority }) => {
        Handler.add({
          ns: plugin.namespace || file.name,
          key,
          self: plugin,
          priority: priority ?? plugin.priority,
          fn: plugin[fn],
        })
      })
    }
  }

  /**
   * 卸载一个插件并归还它占用的全部资源
   *
   * 顺序与 Yunzai-NG 一致：先中止（让挂起的等待退出），再逆序执行登记项，
   * 然后按归属清扫各注册表，最后兜底收回旧插件自己创建的东西。
   */
  release(key, { silent = false, label = null } = {}) {
    const record = this.instances.get(key)
    const stats = { entries: 0, events: 0, services: 0, preprocessors: 0, middlewares: 0 }

    if (record) {
      record.abort.abort()
      stats.entries = record.scope.size
      const failures = record.scope.dispose()
      if (failures.length && !silent) {
        logger.error(`[插件回收] ${key} 有 ${failures.length} 项清理失败`)
      }
      this.instances.delete(key)
    }

    /** 只写了副作用的文件（没有导出插件）到这里收：模块作用域还没人认领 */
    const orphan = this.moduleScopes.get(key)
    if (orphan) {
      this.moduleScopes.delete(key)
      stats.entries += orphan.size
      const failures = orphan.dispose()
      if (failures.length && !silent) {
        logger.error(`[插件回收] ${key} 有 ${failures.length} 项清理失败`)
      }
    }
    unbindOwner(key)

    for (let i = this.priority.length - 1; i >= 0; i--) {
      if (this.priority[i].key === key) this.priority.splice(i, 1)
    }

    Handler.del(record?.namespace || key)
    stats.events = coreEvents.removeByOwner(key)
    stats.services = serviceRegistry.removeByOwner(key)
    Runtime.forgetOwner(key)
    stats.preprocessors = this.msgPreprocess.deleteByOwner(key)
    stats.middlewares = this.middlewares.deleteByOwner(key)
    routeTable.removeByOwner(key)
    globalThis.RendererRegistry?.removeByOwner?.(key)
    globalThis.AdapterRegistry?.removeByOwner?.(key)
    this.clearTasks(key)

    const swept = leakguard.sweep(key)
    if (!silent) {
      const extras = []
      if (swept.timers) extras.push(`定时器 ${swept.timers}`)
      if (swept.listeners) extras.push(`监听 ${swept.listeners}`)
      if (swept.servers) extras.push(`连接 ${swept.servers}`)
      const head = label || `[插件回收] ${key}`
      logger.mark(
        `${head}：登记项 ${stats.entries}，事件 ${stats.events}，服务 ${stats.services}` +
          (extras.length ? `，兜底自建项 ${extras.join(" / ")}` : ""),
      )
    }
    return stats
  }

  packageTips(packageErr) {
    if (!packageErr || packageErr.length <= 0) return
    logger.mark("--------插件载入错误--------")
    packageErr.forEach(v => {
      let pack = v.error.stack.match(/'(.+?)'/g)[0].replace(/'/g, "")
      logger.mark(`${v.file.name} 缺少依赖：${logger.red(pack)}`)
      logger.mark(`新增插件后请执行安装命令：${logger.red("pnpm i")} 安装依赖`)
      logger.mark(
        `如安装后仍未解决可联系插件作者将 ${logger.red(pack)} 依赖添加至插件的package.json dependencies中，或手工安装依赖`,
      )
    })
    // logger.error('或者使用其他包管理工具安装依赖')
    logger.mark("---------------------")
  }

  /**
   * 处理事件
   *
   * 参数文档 https://oicqjs.github.io/oicq/interfaces/GroupMessageEvent.html
   * @param e 事件对象
   */
  async deal(e) {
    try {
      await this.process(e)
    } catch (err) {
      logger.error("[事件处理] 出现未捕获的错误")
      logger.error(err?.stack || err)
    } finally {
      const type = e?.post_type
      if (type === "message" || type === "notice" || type === "request") {
        coreEvents.emit(type, e)
      }
    }
  }

  async process(e) {
    /** 适配器可以自带 bot（多账号时靠它区分是哪个号收到的），没有才回落到全局 Bot */
    if (!e.bot) {
      Object.defineProperty(e, "bot", {
        /** 适配器自定义的 self_id（如标准输入）不在 Bot 上时回落到全局 Bot */
        value: Bot[e?.self_id] ?? Bot,
      })
    }
    /** 检查频道消息 */
    if (this.checkGuildMsg(e)) return

    /** 处理消息 */
    this.dealMsg(e)
    /** 检查黑白名单 */
    if (!this.checkBlack(e)) return
    /** 冷却 */
    if (!this.checkLimit(e)) return
    /** 处理回复 */
    this.reply(e)
    /** 注册runtime */
    await Runtime.init(e)

    /** 中间件链，可在此改写或吞掉事件 */
    if (!(await this.runMiddleware(e))) return

    /** 优先处理 */
    if(Bot.prioritizePlugin && typeof Bot.prioritizePlugin === 'function') {
      try {
        if(await Bot.prioritizePlugin(e)) return
      } catch (error) {
        logger.error('[优先处理] 出现错误，忽略优先处理继续执行')
        logger.error(error)
      }
    }

    const priority = []
    /** 群配置每条消息只取一次，避免在插件循环内重复合并配置 */
    const groupCfg = cfg.getGroup(e.group_id)
    const defaultGroupCfg = cfg.getConfig("group").default
    for (const i of this.priority) {
      /** 先用加载期缓存的 name/event 过滤，命中后再实例化，避免每条消息实例化全部插件 */
      if (!i.class || i.object) continue
      if (!this.checkDisable(i.name, groupCfg, defaultGroupCfg)) continue
      if (!this.filtEvent(e, i)) continue
      const p = new i.class(e)
      p.e = e
      const record = this.instances.get(i.key)
      if (record) p.ctx = record.ctx
      p.pluginKey = i.key
      priority.push(p)
    }

    for (const plugin of priority) {
      /** 上下文hook */
      if (!plugin.getContext) continue
      const context = {
        ...plugin.getContext(),
        ...plugin.getContext(false, true),
      }
      if (!lodash.isEmpty(context)) {
        let ret
        for (const fnc in context) {
          ret ||= await leakguard.run(plugin.pluginKey, () => plugin[fnc](context[fnc]))
        }
        // 返回continue时，继续响应后续插件
        if (ret === "continue") continue
        return
      }
    }

    /** 是否只关注主动at */
    if (!this.onlyReplyAt(e)) return

    /** 消息预处理，插件可在此标准化命令与补充事件字段 */
    this.runMsgPreprocessor(e)

    /** 优先执行 accept */
    for (const plugin of priority)
      if (plugin.accept) {
        const res = await leakguard.run(plugin.pluginKey, () => plugin.accept(e))
        if (res == "return") return
        if (res) break
      }

    a: for (const plugin of priority) {
      /** 正则匹配 */
      if (plugin.rule)
        for (const v of plugin.rule) {
          /** 判断事件 */
          if (v.event && !this.filtEvent(e, v)) continue
          const reg = getCachedRegExp(v.reg)
          /** 复用缓存实例时重置 lastIndex，保证与每次新建正则行为一致 */
          reg.lastIndex = 0
          if (!reg.test(e.msg)) continue
          e.logFnc = `[${plugin.name}][${v.fnc}]`

          if (v.log !== false) {
            logger.info(`${e.logFnc}${e.logText} ${lodash.truncate(e.msg, { length: 100 })}`)
          } else {
            logger.debug(`${e.logFnc}${e.logText} ${lodash.truncate(e.msg, { length: 100 })}`)
          }

          /** 判断权限 */
          if (!this.filtPermission(e, v)) break a

          try {
            const start = Date.now()
            const res = plugin[v.fnc] && (await leakguard.run(plugin.pluginKey, () => plugin[v.fnc](e)))
            if (res !== false) {
              /** 设置冷却cd */
              this.setLimit(e)
              if (v.log !== false) {
                logger.mark(
                  `${e.logFnc} ${lodash.truncate(e.msg, { length: 100 })} 处理完成 ${Date.now() - start}ms`,
                )
              } else {
                logger.debug(
                  `${e.logFnc} ${lodash.truncate(e.msg, { length: 100 })} 处理完成 ${Date.now() - start}ms`,
                )
              }
              break a
            }
          } catch (error) {
            logger.error(`${e.logFnc}`)
            logger.error(error.stack)
            break a
          }
        }
    }
  }

  /** 过滤事件 */
  filtEvent(e, v) {
    if (!v.event) return false
    const event = v.event.split(".")
    const eventMap = this.eventMap[e.post_type] || []
    const newEvent = []
    for (const i in event) {
      if (event[i] == "*") newEvent.push(event[i])
      else newEvent.push(e[eventMap[i]])
    }
    return v.event == newEvent.join(".")
  }

  /** 判断权限 */
  filtPermission(e, v) {
    if (v.permission == "all" || !v.permission) return true

    if (v.permission == "master") {
      if (e.isMaster) {
        return true
      } else {
        e.reply("暂无权限，只有主人才能操作")
        return false
      }
    }

    if (e.isGroup) {
      if (!e.member?._info) {
        e.reply("数据加载中，请稍后再试")
        return false
      }
      if (v.permission == "owner") {
        if (!e.member.is_owner) {
          e.reply("暂无权限，只有群主才能操作")
          return false
        }
      }
      if (v.permission == "admin") {
        if (!e.member.is_admin) {
          e.reply("暂无权限，只有管理员才能操作")
          return false
        }
      }
    }

    return true
  }

  /**
   * 处理消息，加入自定义字段
   * @param e.msg 文本消息，多行会自动拼接
   * @param e.img 图片消息数组
   * @param e.atBot 是否at机器人
   * @param e.at 是否at，多个at 以最后的为准
   * @param e.file 接受到的文件
   * @param e.isPrivate 是否私聊
   * @param e.isGroup 是否群聊
   * @param e.isMaster 是否管理员
   * @param e.logText 日志用户字符串
   * @param e.logFnc  日志方法字符串

   * 频道
   * @param e.isGuild 是否频道
   * @param e.at 支持频道 tiny_id
   * @param e.atBot 支持频道

   */
  dealMsg(e) {
    if (e.message) {
      for (let val of e.message) {
        switch (val.type) {
          case "text":
            e.msg =
              (e.msg || "") +
              (val.text || "")
                .replace(/^\s*[＃井#]+\s*/, "#")
                .replace(/^\s*[\\*※＊]+\s*/, "*")
                .trim()
            break
          case "image":
            if (!e.img) {
              e.img = []
            }
            e.img.push(val.url)
            break
          case "at":
            if (val.qq == e.bot.uin) {
              e.atBot = true
            } else if (e.bot.tiny_id && val.id == e.bot.tiny_id) {
              e.atBot = true
              /** 多个at 以最后的为准 */
            } else if (val.id) {
              e.at = val.id
            } else {
              e.at = val.qq
            }
            break
          case "file":
            e.file = { name: val.name, fid: val.fid }
            break
          case "xml":
          case "json":
            e.msg =
              (e.msg || "") + (typeof val.data == "string" ? val.data : JSON.stringify(val.data))
            break
        }
      }
    }

    e.logText = ""

    if (e.message_type === "private" || e.notice_type === "friend") {
      e.isPrivate = true

      if (e.sender) {
        e.sender.card = e.sender.nickname
      } else {
        e.sender = {
          card: e.friend?.nickname,
          nickname: e.friend?.nickname,
        }
      }

      e.logText = `[私聊][${e.sender.nickname}(${e.user_id})]`
    }

    if (e.message_type === "group" || e.notice_type === "group") {
      e.isGroup = true
      if (e.sender) {
        e.sender.card = e.sender.card || e.sender.nickname
      } else if (e.member) {
        e.sender = {
          card: e.member.card || e.member.nickname,
        }
      } else if (e.nickname) {
        e.sender = {
          card: e.nickname,
          nickname: e.nickname,
        }
      } else {
        e.sender = {
          card: "",
          nickname: "",
        }
      }

      if (!e.group_name) e.group_name = e.group?.name

      e.logText = `[${e.group_name}(${e.sender.card})]`
    } else if (e.detail_type === "guild") {
      e.isGuild = true
    }

    if (e.user_id && cfg.masterQQ.includes(Number(e.user_id) || String(e.user_id))) {
      e.isMaster = true
    }

    /** 只关注主动at msg处理 */
    if (e.msg && e.isGroup) {
      let groupCfg = cfg.getGroup(e.group_id)
      let alias = groupCfg.botAlias
      if (!Array.isArray(alias)) {
        alias = [alias]
      }
      for (let name of alias) {
        if (e.msg.startsWith(name)) {
          e.msg = lodash.trimStart(e.msg, name).trim()
          e.hasAlias = true
          break
        }
      }
    }
  }

  /** 处理回复,捕获发送失败异常 */
  reply(e) {
    if (e.reply) {
      e.replyNew = e.reply

      /**
       * @param msg 发送的消息
       * @param quote 是否引用回复
       * @param data.recallMsg 群聊是否撤回消息，0-120秒，0不撤回
       * @param data.at 是否at用户
       */
      e.reply = async (msg = "", quote = false, data = {}) => {
        if (!msg) return false

        /** 禁言中 */
        if (e.isGroup && e?.group?.mute_left > 0) return false

        let { recallMsg = 0, at = "" } = data

        if (at && e.isGroup) {
          let text = ""
          if (e?.sender?.card) {
            text = lodash.truncate(e.sender.card, { length: 10 })
          }
          if (at === true) {
            at = Number(e.user_id) || String(e.user_id)
          } else if (!isNaN(at)) {
            if (e.isGuild) {
              text = e.sender?.nickname
            } else {
              let info = e.group.pickMember(at).info
              text = info?.card ?? info?.nickname
            }
            text = lodash.truncate(text, { length: 10 })
          }

          if (Array.isArray(msg)) msg.unshift((globalThis.segment ?? segment).at(at, text), "\n")
          else msg = [(globalThis.segment ?? segment).at(at, text), "\n", msg]
        }

        let msgRes
        try {
          msgRes = await e.replyNew(msg, quote)
        } catch (err) {
          if (typeof msg != "string") {
            if (msg.type == "image" && Buffer.isBuffer(msg?.file)) msg.file = {}
            msg = lodash.truncate(JSON.stringify(msg), { length: 300 })
          }
          logger.error(`发送消息错误:${msg}`)
          logger.error(err)
          if (cfg.bot.sendmsg_error)
            Bot[Bot.uin].pickUser(cfg.masterQQ[0]).sendMsg(`发送消息错误:${msg}`)
        }

        // 频道一下是不是频道
        if (!e.isGuild && recallMsg > 0 && msgRes?.message_id) {
          if (e.isGroup) {
            setTimeout(() => e.group.recallMsg(msgRes.message_id), recallMsg * 1000)
          } else if (e.friend) {
            setTimeout(() => e.friend.recallMsg(msgRes.message_id), recallMsg * 1000)
          }
        }

        this.count(e, msg)
        return msgRes
      }
    } else {
      e.reply = async (msg = "", quote = false, data = {}) => {
        if (!msg) return false
        this.count(e, msg)
        if (e.group_id) {
          return await e.group.sendMsg(msg).catch(err => {
            logger.warn(err)
          })
        } else {
          let friend = e.bot.fl.get(e.user_id)
          if (!friend) return
          return await e.bot
            .pickUser(e.user_id)
            .sendMsg(msg)
            .catch(err => {
              logger.warn(err)
            })
        }
      }
    }
  }

  count(e, msg) {
    let screenshot = false
    if (msg && msg?.file && Buffer.isBuffer(msg?.file)) {
      screenshot = true
    }

    this.saveCount("sendMsg")
    if (screenshot) this.saveCount("screenshot")

    if (e.group_id) {
      this.saveCount("sendMsg", e.group_id)
      if (screenshot) this.saveCount("screenshot", e.group_id)
    }
  }

  saveCount(type, groupId = "") {
    let key = "Yz:count:"

    if (groupId) {
      key += `group:${groupId}:`
    }

    let dayKey = `${key}${type}:day:${moment().format("MMDD")}`
    let monthKey = `${key}${type}:month:${Number(moment().month()) + 1}`
    let totalKey = `${key}${type}:total`

    redis.incr(dayKey)
    redis.incr(monthKey)
    if (!groupId) redis.incr(totalKey)
    redis.expire(dayKey, 3600 * 24 * 30)
    redis.expire(monthKey, 3600 * 24 * 30)
  }

  delCount() {
    let key = "Yz:count:"
    redis.set(`${key}sendMsg:total`, "0")
    redis.set(`${key}screenshot:total`, "0")
  }

  /** 收集定时任务 */
  collectTask(task, pluginKey, classRef = null) {
    if (!task) return
    for (const i of Array.isArray(task) ? task : [task]) {
      if (i && i.cron && i.name) {
        i.pluginKey = pluginKey
        i.classRef = i.classRef || classRef
        this.task.push(i)
      }
    }
  }

  /** 创建定时任务 */
  createTask() {
    for (const i of this.task) this.scheduleTask(i)
  }

  /** 把一个任务交给调度器，重复调用不会重复注册 */
  scheduleTask(item) {
    if (item.job) return
    const record = this.instances.get(item.pluginKey)
    const ctx = record?.ctx
    const direct = typeof item.fnc === "function" ? item.fnc : null
    const fncName = typeof item.fnc === "string" ? item.fnc : null

    const run = () => {
      if (direct) return direct()
      const Cls = item.classRef
      if (!Cls || !fncName) {
        logger.error(`[定时任务] ${item.name} 没有可执行的方法`)
        return
      }
      const instance = new Cls()
      if (ctx) instance.ctx = ctx
      const fn = instance?.[fncName]
      if (typeof fn !== "function") {
        logger.error(`[定时任务] ${item.name} 找不到方法 ${fncName}`)
        return
      }
      return fn.call(instance)
    }

    item.job = scheduler.register({
      plugin: item.pluginKey,
      kind: "cron",
      schedule: item.cron,
      fn: run,
      options: { name: item.name },
      signal: record?.abort.signal,
    })
  }

  /** 摘掉某个插件的全部定时任务 */
  clearTasks(pluginKey) {
    const kept = []
    for (const i of this.task) {
      if (i.pluginKey === pluginKey) {
        if (typeof i.job === "function") i.job()
        i.job = null
      } else {
        kept.push(i)
      }
    }
    this.task = kept
    scheduler.removePlugin(pluginKey)
  }

  /** 取消所有定时任务 */
  cancelTasks() {
    for (const i of this.task) {
      if (typeof i.job === "function") i.job()
      i.job = null
    }
    scheduler.stop()
  }

  /** 检查命令冷却cd */
  checkLimit(e) {
    /** 禁言中 */
    if (e.isGroup && e?.group?.mute_left > 0) return false
    if (!e.message || e.isPrivate) return true

    let config = cfg.getGroup(e.group_id)

    if (config.groupGlobalCD && this.groupGlobalCD[e.group_id]) {
      return false
    }
    if (config.singleCD && this.singleCD[`${e.group_id}.${e.user_id}`]) {
      return false
    }

    let { msgThrottle } = this

    let msgId = `${e.group_id}:${e.user_id}:${e.raw_message}:${e.time}`
    if (msgThrottle[msgId]) {
      return false
    }
    msgThrottle[msgId] = true
    setTimeout(() => {
      delete msgThrottle[msgId]
    }, 5000)

    return true
  }

  /** 设置冷却cd */
  setLimit(e) {
    if (!e.message || e.isPrivate) return
    let config = cfg.getGroup(e.group_id)

    if (config.groupGlobalCD) {
      this.groupGlobalCD[e.group_id] = true
      setTimeout(() => {
        delete this.groupGlobalCD[e.group_id]
      }, config.groupGlobalCD)
    }
    if (config.singleCD) {
      let key = `${e.group_id}.${e.user_id}`
      this.singleCD[key] = true
      setTimeout(() => {
        delete this.singleCD[key]
      }, config.singleCD)
    }
  }

  /** 是否只关注主动at */
  onlyReplyAt(e) {
    if (!e.message || e.isPrivate) return true

    let groupCfg = cfg.getGroup(e.group_id)

    /** 模式0，未开启前缀 */
    if (groupCfg.onlyReplyAt == 0 || !groupCfg.botAlias) return true

    /** 模式2，非主人需带前缀或at机器人 */
    if (groupCfg.onlyReplyAt == 2 && e.isMaster) return true

    /** at机器人 */
    if (e.atBot) return true

    /** 消息带前缀 */
    if (e.hasAlias) return true

    return false
  }

  /** 判断频道消息 */
  checkGuildMsg(e) {
    return cfg.getOther().disableGuildMsg && e.detail_type == "guild"
  }

  /** 判断黑白名单 */
  checkBlack(e) {
    const other = cfg.getOther()

    /** 黑名单qq */
    if (other.blackQQ?.length) {
      if (other.blackQQ.includes(Number(e.user_id) || String(e.user_id))) return false
      if (e.at && other.blackQQ.includes(Number(e.at) || String(e.at))) return false
    }
    /** 白名单qq */
    if (other.whiteQQ?.length)
      if (!other.whiteQQ.includes(Number(e.user_id) || String(e.user_id))) return false

    if (e.group_id) {
      /** 黑名单群 */
      if (
        other.blackGroup?.length &&
        other.blackGroup.find(a => a == `${e.self_id}:${e.group_id}` || a == e.group_id)
      )
        return false
      /** 白名单群 */
      if (
        other.whiteGroup?.length &&
        !other.whiteGroup.find(a => a == `${e.self_id}:${e.group_id}` || a == e.group_id)
      )
        return false
    }

    return true
  }

  /** 判断是否启用功能 */
  checkDisable(name, groupCfg, defaultCfg) {
    if (groupCfg.disable?.length && groupCfg.disable.includes(name)) return false
    let enableList = groupCfg.enable?.length ? groupCfg.enable : []
    // 继承默认配置相关逻辑
    if (
      (defaultCfg.isInheritDefault === 1 && (groupCfg.isInheritDefault === undefined || groupCfg.isInheritDefault === null || groupCfg.isInheritDefault === 1)) ||
      ((!defaultCfg.isInheritDefault || defaultCfg.isInheritDefault === 0) && groupCfg.isInheritDefault === 1)
    ) {
      if(defaultCfg.disable?.length && defaultCfg.disable.includes(name)) return false
      if(defaultCfg.enable?.length) enableList = enableList.concat(defaultCfg.enable)
    }
    if (enableList.length && !enableList.includes(name)) return false
    return true
  }

  async changePlugin(key, { label = null } = {}) {
    try {
      let appPath = key
      if (!(await fs.stat(`${this.dir}/${key}`)).isFile()) appPath = `${key}/index.js`

      /** 先完整卸载旧实例：中止 → 逆序回收 → 按归属清扫 → 兜底收回自建项 */
      /** 只有「这个文件从没装过」才静默；纯副作用文件没有实例，但仍要打回收日志 */
      const existed = this.instances.has(key) || this.moduleScopes.has(key)
      this.release(key, { silent: !existed, label })

      /** 重建模块作用域并带上归属：热重载后的顶层副作用同样要能被收回 */
      this.moduleScope(key)
      const app = await leakguard.run(key, () =>
        import(`../../${this.dir}/${appPath}?${moment().format("x")}`),
      )
      await this.registerModule({ name: key, path: `../../${this.dir}/${appPath}` }, app)
      /** 插件目录可能同时声明了适配器，重新加载后要重新注册 */
      if (!key.endsWith(".js")) await this.preloadAdapter(key)
      this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
      /** 只为新收集的任务建 job，已在跑的任务会被跳过 */
      this.createTask()
    } catch (error) {
      logger.error(`加载插件错误：${logger.red(key)}`)
      logger.error(decodeURI(error.stack))
    }
  }

  /** 监听热更新 */
  watch(dirName, appName) {
    this.watchDir(dirName)
    if (this.watcher[`${dirName}.${appName}`]) return

    const file = `./${this.dir}/${dirName}/${appName}`
    const watcher = chokidar.watch(file)
    const key = `${dirName}/${appName}`

    /** 监听修改 */
    watcher.on("change", path => {
      this.changePlugin(key, { label: `[修改插件][${dirName}][${appName}] 回收` })
    })

    /** 监听删除 */
    watcher.on("unlink", async path => {
      /** 停止更新监听 */
      this.watcher[`${dirName}.${appName}`]?.close()
      delete this.watcher[`${dirName}.${appName}`]
      this.release(key, { label: `[卸载插件][${dirName}][${appName}] 回收` })
    })
    this.watcher[`${dirName}.${appName}`] = watcher
  }

  /** 监听文件夹更新 */
  watchDir(dirName) {
    if (this.watcher[dirName]) return
    const watcher = chokidar.watch(`./${this.dir}/${dirName}/`)
    /** 热更新 */
    setTimeout(() => {
      /** 新增文件 */
      watcher.on("add", async PluPath => {
        const appName = path.basename(PluPath)
        if (!appName.endsWith(".js")) return
        logger.mark(`[新增插件][${dirName}][${appName}]`)
        const key = `${dirName}/${appName}`
        await this.importPlugin({
          name: key,
          path: `../../${this.dir}/${key}?${moment().format("X")}`,
        })
        /** 优先级排序 */
        this.priority = lodash.orderBy(this.priority, ["priority"], ["asc"])
        this.watch(dirName, appName)
        /** 只给新收集的任务建 job */
        this.createTask()
      })
    }, 10000)
    this.watcher[dirName] = watcher
  }
}
const loader = new PluginsLoader()

/** 进程退出时收尾：停调度器、按逆加载顺序回收插件、撤回全局改写 */
process.once("exit", () => {
  try {
    scheduler.stop()
    for (const key of [...loader.instances.keys()].reverse()) loader.release(key, { silent: true })
    leakguard.restore()
  } catch (err) {
    console.error(err)
  }
})

export default loader
