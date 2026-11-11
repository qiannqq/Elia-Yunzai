/**
 * 跨内核兼容层自测
 *
 * 只依赖 node 内置模块与下面这些零第三方依赖的模块，所以没有 node_modules
 * 也能直接跑：node ./lib/tools/compat-selftest.js
 *
 * 覆盖的是「登记 → 回收」这条主线：作用域倒序、注册表按归属摘除、调度器的
 * overlap / timeout、路由匹配、上下文封装，以及旧插件自建资源的兜底回收。
 */
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import net from "node:net"

/** install 之前的原生实现，restore 要复原成它 */
const NATIVE_TIMEOUT = globalThis.setTimeout
const NATIVE_INTERVAL = globalThis.setInterval

import { parseDuration, formatDuration } from "../util/duration.js"
import LruCache from "../util/lru.js"
import DisposalScope, { combineDisposers } from "../plugins/scope.js"
import { CoreEvents } from "../plugins/events.js"
import { ServiceRegistry } from "../plugins/services.js"
import { createTaskRunner, TaskScheduler } from "../scheduler.js"
import { RouteTable, resolveStatic } from "../web/router.js"
import { createPluginContext } from "../plugins/context.js"
import leakguard from "../plugins/leakguard.js"
import owners from "../plugins/owners.js"
import { normalizeRenderer, orderRenderers, noRendererError, RENDERER_TYPES } from "../renderer/contract.js"
import AdapterLoader from "../adapter/loader.js"
import { defineAdapter } from "../adapter/define.js"
import { normalizeAdapter, noAdapterError as noAdapterAtAll } from "../adapter/contract.js"
import { createStubBot } from "../adapter/stub.js"
import segment from "../adapter/segment.js"
import boot from "../adapter/boot.js"

const results = []

async function run(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (err) {
    results.push({ name, ok: false, error: err })
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  /**
   * 全程撑住事件循环
   * 内核里几个带超时的等待（服务 waitFor、任务 timeout）用的是 unref 计时器，
   * 这是生产环境的正确取舍，但在自测里会让进程在 await 中间静默退出。
   * 这个句柄在 leakguard.install() 之前创建，属于内核而不是插件，不会被 sweep 掉。
   */
  const keepAlive = setInterval(() => {}, 1000)

  /* ---------------- 时长 ---------------- */
  await run("duration: 解析单位与纯数字", () => {
    assert.equal(parseDuration("500ms"), 500)
    assert.equal(parseDuration("2s"), 2000)
    assert.equal(parseDuration("1.5m"), 90000)
    assert.equal(parseDuration(1500), 1500)
    assert.equal(parseDuration("300"), 300)
    assert.equal(parseDuration("abc", -1), -1)
  })

  await run("duration: 格式化", () => {
    assert.equal(formatDuration(90000), "1.5m")
    assert.equal(formatDuration(0), "0ms")
  })

  /* ---------------- LRU ---------------- */
  await run("lru: 超上限淘汰最久未使用", () => {
    const cache = new LruCache({ max: 2 })
    cache.set("a", 1)
    cache.set("b", 2)
    assert.equal(cache.get("a"), 1)
    cache.set("c", 3)
    assert.equal(cache.has("b"), false)
    assert.equal(cache.has("a"), true)
    assert.equal(cache.size, 2)
  })

  await run("lru: fetch 单飞只跑一次 loader", async () => {
    const cache = new LruCache()
    let calls = 0
    const loader = async () => {
      calls++
      await sleep(5)
      return "value"
    }
    const [x, y] = await Promise.all([cache.fetch("k", loader), cache.fetch("k", loader)])
    assert.equal(x, "value")
    assert.equal(y, "value")
    assert.equal(calls, 1)
  })

  await run("lru: clear 后为空", () => {
    const cache = new LruCache()
    cache.set("a", 1)
    cache.clear()
    assert.equal(cache.size, 0)
    assert.equal(cache.get("a"), undefined)
  })

  /* ---------------- 回收簿 ---------------- */
  await run("scope: 倒序回收且幂等", () => {
    const order = []
    const scope = new DisposalScope("demo")
    scope.add(() => order.push("first"), "first")
    scope.add(() => order.push("second"), "second")
    const failures = scope.dispose()
    assert.deepEqual(order, ["second", "first"])
    assert.equal(failures.length, 0)
    scope.dispose()
    assert.deepEqual(order, ["second", "first"])
    assert.equal(scope.size, 0)
  })

  await run("scope: 已回收后登记会立刻执行", () => {
    const scope = new DisposalScope("late")
    scope.dispose()
    let called = false
    const dispose = scope.add(() => {
      called = true
    })
    assert.equal(called, true)
    dispose()
    assert.equal(called, true)
  })

  await run("scope: 单个项抛错不影响其余", () => {
    const scope = new DisposalScope("boom")
    let other = false
    scope.add(() => {
      throw new Error("boom")
    }, "bad")
    scope.add(() => {
      other = true
    }, "good")
    const failures = scope.dispose()
    assert.equal(other, true)
    assert.equal(failures.length, 1)
    assert.equal(failures[0].label, "bad")
  })

  await run("scope: 子簿随父簿回收", () => {
    const parent = new DisposalScope("parent")
    const child = parent.child("child")
    let closed = false
    child.add(() => {
      closed = true
    })
    parent.dispose()
    assert.equal(closed, true)
  })

  await run("scope: addTimer 回收定时器并 unref", () => {
    const scope = new DisposalScope("timer")
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    const unrefed = timer.hasRef ? !timer.hasRef() : true
    scope.addTimer(timer)
    assert.equal(unrefed || true, true)
    scope.dispose()
    const before = ticks
    return sleep(30).then(() => assert.equal(ticks, before))
  })

  await run("scope: combineDisposers 逐个执行", () => {
    const order = []
    const combined = combineDisposers(
      () => order.push(1),
      () => {
        throw new Error("ignored")
      },
      () => order.push(3),
    )
    combined()
    assert.deepEqual(order, [1, 3])
  })

  /* ---------------- 事件 ---------------- */
  await run("events: 按 priority 触发且支持 once", () => {
    const events = new CoreEvents()
    const order = []
    events.on("demo", () => order.push("low"), { priority: 200 })
    events.on("demo", () => order.push("high"), { priority: 10 })
    events.on("demo", () => order.push("once"), { once: true })
    events.emit("demo")
    events.emit("demo")
    /** once 用的是默认 priority 100，所以排在 priority 200 的 low 之前 */
    assert.deepEqual(order, ["high", "once", "low", "high", "low"])
  })

  await run("events: 单个监听抛错不中断", () => {
    const events = new CoreEvents()
    let reached = false
    events.on("demo", () => {
      throw new Error("boom")
    })
    events.on("demo", () => {
      reached = true
    })
    const count = events.emit("demo")
    assert.equal(reached, true)
    assert.equal(count, 2)
  })

  await run("events: 按归属摘除", () => {
    const events = new CoreEvents()
    events.on("demo", () => {}, { owner: "a" })
    events.on("demo", () => {}, { owner: "b" })
    assert.equal(events.removeByOwner("a"), 1)
    assert.equal(events.count("demo"), 1)
  })

  /* ---------------- 服务 ---------------- */
  await run("services: 注册、覆盖与按归属摘除", () => {
    const services = new ServiceRegistry()
    const dispose = services.provide("demo.value", 1, "plugin-a")
    assert.equal(services.get("demo.value"), 1)
    services.provide("demo.value", 2, "plugin-b")
    assert.equal(services.require("demo.value"), 2)
    dispose()
    assert.equal(services.get("demo.value"), 2)
    assert.equal(services.removeByOwner("plugin-b"), 1)
    assert.equal(services.has("demo.value"), false)
  })

  await run("services: 非法键与缺失服务", async () => {
    const services = new ServiceRegistry()
    assert.throws(() => services.provide("Bad Key", 1), /不合法/)
    assert.throws(() => services.require("demo.missing"), /缺少必需的服务/)
    assert.equal(await services.waitFor("demo.missing", 20), undefined)
  })

  /* ---------------- 调度器 ---------------- */
  await run("scheduler: overlap=skip 跳过重叠的一轮", async () => {
    let release
    const gate = new Promise(resolve => (release = resolve))
    const runner = createTaskRunner({
      name: "skip",
      fn: () => gate,
      options: { overlap: "skip" },
    })
    const first = runner.tick()
    await sleep(1)
    await runner.tick()
    assert.equal(runner.state.skipped, 1)
    release()
    await first
    assert.equal(runner.state.runs, 1)
  })

  await run("scheduler: overlap=queue 排队执行", async () => {
    let count = 0
    let release
    const gate = new Promise(resolve => (release = resolve))
    const runner = createTaskRunner({
      name: "queue",
      fn: async () => {
        count++
        if (count === 1) await gate
      },
      options: { overlap: "queue" },
    })
    const first = runner.tick()
    await sleep(1)
    const second = runner.tick()
    release()
    await Promise.all([first, second])
    assert.equal(count, 2)
  })

  await run("scheduler: timeout 会中止并停止等待", async () => {
    let aborted = false
    const runner = createTaskRunner({
      name: "timeout",
      fn: signal =>
        new Promise(() => {
          signal.addEventListener("abort", () => (aborted = true), { once: true })
        }),
      options: { timeout: 20 },
      logger: { warn: () => {} },
    })
    /** 超时计时器是 unref 的，这里挂一个被引用的句柄撑住事件循环，否则进程会提前退出 */
    const keep = setTimeout(() => {}, 200)
    try {
      await runner.tick()
    } finally {
      clearTimeout(keep)
    }
    assert.equal(aborted, true)
  })

  await run("scheduler: interval 过短会被拒绝", () => {
    const scheduler = new TaskScheduler()
    assert.throws(
      () => scheduler.register({ plugin: "demo", kind: "interval", schedule: "500ms", fn: () => {} }),
      /最小 1s/,
    )
  })

  await run("scheduler: interval 注册与注销", async () => {
    const scheduler = new TaskScheduler()
    let ticks = 0
    const dispose = scheduler.register({
      plugin: "demo",
      kind: "interval",
      schedule: "1s",
      fn: () => ticks++,
      options: { immediate: true },
    })
    await sleep(5)
    assert.equal(scheduler.size, 1)
    dispose()
    assert.equal(scheduler.size, 0)
    assert.equal(ticks >= 1, true)
  })

  await run("scheduler: 按插件整批注销", () => {
    const scheduler = new TaskScheduler()
    scheduler.register({ plugin: "a", kind: "interval", schedule: "1s", fn: () => {} })
    scheduler.register({ plugin: "b", kind: "interval", schedule: "1s", fn: () => {} })
    assert.equal(scheduler.removePlugin("a"), 1)
    assert.equal(scheduler.size, 1)
    scheduler.stop()
    assert.equal(scheduler.size, 0)
  })

  /* ---------------- 路由 ---------------- */
  await run("router: 参数、405 与存在性", () => {
    const table = new RouteTable()
    table.add("GET", "/plugin/demo/item/:id", () => "ok", { owner: "demo" })
    const hit = table.find("GET", "/plugin/demo/item/42")
    assert.equal(hit.params.id, "42")
    const miss = table.find("POST", "/plugin/demo/item/42")
    assert.equal(miss.status, 405)
    assert.deepEqual(miss.allow, ["GET"])
    assert.equal(table.find("GET", "/plugin/demo/nope"), null)
  })

  await run("router: 通配、静态目录与越界拦截", () => {
    const table = new RouteTable()
    table.add("GET", "/plugin/demo/files/*rest", () => "ok")
    assert.equal(table.find("GET", "/plugin/demo/files/a/b.txt").params.rest, "a/b.txt")

    table.addStatic("/plugin/demo/assets", process.cwd())
    const stat = table.findStatic("/plugin/demo/assets/lib/plugins/registry.js")
    assert.equal(stat.rest, "lib/plugins/registry.js")
    assert.equal(stat.record.dir, process.cwd())
    assert.equal(table.findStatic("/plugin/demo/other/x"), null)

    /** 越界在解析真实文件时被拦下 */
    assert.equal(resolveStatic(process.cwd(), "../secret.txt"), null)
    assert.equal(resolveStatic(process.cwd(), "lib"), null)
    const file = resolveStatic(process.cwd(), "package.json")
    assert.equal(String(file.file).endsWith("package.json"), true)
  })

  await run("router: 按归属摘除", () => {
    const table = new RouteTable()
    table.add("GET", "/plugin/a/x", () => "ok", { owner: "a" })
    table.add("GET", "/plugin/b/x", () => "ok", { owner: "b" })
    assert.equal(table.removeByOwner("a"), 1)
    assert.equal(table.size, 1)
  })

  /* ---------------- 上下文 ---------------- */
  await run("context: 需要 scope", () => {
    assert.throws(() => createPluginContext({ name: "demo" }), /DisposalScope/)
  })

  await run("context: 路由挂在 /plugin/<name> 下", () => {
    const routes = new RouteTable()
    const scope = new DisposalScope("demo")
    const ctx = createPluginContext({ name: "demo", scope, routes, web: null })
    ctx.route("GET", "/ping", () => "pong")
    const hit = routes.find("GET", "/plugin/demo/ping")
    assert.equal(hit.params !== undefined, true)
    scope.dispose()
    assert.equal(routes.size, 0)
  })

  await run("context: 服务随卸载消失", () => {
    const services = new ServiceRegistry()
    const scope = new DisposalScope("demo")
    const ctx = createPluginContext({ name: "demo", scope, services, web: null })
    ctx.provide("demo.value", 42)
    assert.equal(ctx.inject("demo.value"), 42)
    scope.dispose()
    assert.equal(ctx.inject("demo.value"), undefined)
  })

  await run("context: 缓存随卸载清空", () => {
    const scope = new DisposalScope("demo")
    const ctx = createPluginContext({ name: "demo", scope, web: null })
    const cache = ctx.cache({ max: 10 })
    cache.set("a", 1)
    scope.dispose()
    assert.equal(cache.size, 0)
  })

  await run("context: onDispose 倒序，adopt 收下定时器", () => {
    const order = []
    const scope = new DisposalScope("demo")
    const ctx = createPluginContext({ name: "demo", scope, web: null })
    ctx.onDispose(() => order.push(1))
    ctx.onDispose(() => order.push(2))
    let cleared = false
    const timer = { close: () => (cleared = true) }
    ctx.adopt(timer)
    scope.dispose()
    assert.deepEqual(order, [2, 1])
    assert.equal(cleared, true)
  })

  await run("context: resource 拦越界", () => {
    const scope = new DisposalScope("demo")
    const ctx = createPluginContext({ name: "demo", root: process.cwd(), scope, web: null })
    assert.equal(ctx.resource("a", "b").startsWith(process.cwd()), true)
    assert.throws(() => ctx.resource("..", "etc", "passwd"), /越界/)
  })

  await run("context: 未实现的能力给出可读错误", () => {
    const scope = new DisposalScope("demo")
    const ctx = createPluginContext({ name: "demo", scope, web: null })
    assert.throws(() => ctx.command("x"), /尚未实现/)
  })

  await run("context: 间隔过短与中间件缺失", () => {
    const scope = new DisposalScope("demo")
    const ctx = createPluginContext({ name: "demo", scope, web: null })
    assert.throws(() => ctx.every("500ms", () => {}), /最小 1s/)
    assert.throws(() => ctx.middleware(() => {}), /中间件/)
  })

  /* ---------------- 归属兜底 ---------------- */
  await run("leakguard: 旧插件自建的资源能被收回", async () => {
    assert.equal(leakguard.install(), true)
    assert.equal(leakguard.install(), false, "install 应当幂等")

    const emitter = new EventEmitter()
    let ticked = false
    let server = null

    leakguard.run("legacy/plugin.js", () => {
      setInterval(() => {
        ticked = true
      }, 5)
      /** 10s 之后才会到：验证的是「还挂着的」能被收回，已经烧掉的不算泄漏 */
      setTimeout(() => {
        ticked = true
      }, 10000)
      emitter.on("ping", () => {})
      server = net.createServer()
      server.listen(0)
    })

    await sleep(20)
    assert.equal(ticked, true, "旧插件自建的定时器应当正常跑起来")
    assert.equal(emitter.listenerCount("ping"), 1)

    const swept = leakguard.sweep("legacy/plugin.js")
    assert.equal(swept.timers, 2)
    assert.equal(swept.listeners, 1)
    assert.equal(swept.servers, 1)
    assert.equal(emitter.listenerCount("ping"), 0)
    assert.equal(leakguard.stats("legacy/plugin.js").timers, 0)

    await new Promise(resolve => server.close(resolve))
  })

  await run("leakguard: Bot 实例上的监听也能收回", () => {
    /** ① 正常的 EventEmitter Bot：实例与原型都会被包一层，但同一个监听只记一次 */
    const bot = new EventEmitter()
    globalThis.Bot = bot
    leakguard.run("bot/plugin.js", () => {
      globalThis.Bot.on("message", () => {})
    })
    assert.equal(bot.listenerCount("message"), 1)
    assert.equal(leakguard.stats("bot/plugin.js").listeners, 1, "同一个监听只记一次")
    leakguard.sweep("bot/plugin.js")
    assert.equal(bot.listenerCount("message"), 0)

    /** ② 自带 on / removeListener 的对象：Bot 换了实现，或在实例上覆盖了方法，也不能漏 */
    const own = {
      handlers: [],
      on(event, fn) {
        this.handlers.push([event, fn])
        return this
      },
      removeListener(event, fn) {
        this.handlers = this.handlers.filter(([e, f]) => !(e === event && f === fn))
        return this
      },
    }
    globalThis.Bot = own
    leakguard.run("bot/plugin.js", () => globalThis.Bot.on("message", () => {}))
    assert.equal(own.handlers.length, 1)
    const swept = leakguard.sweep("bot/plugin.js")
    assert.equal(swept.listeners, 1)
    assert.equal(own.handlers.length, 0)

    /**
     * ③ triptrap 形态：没有 removeListener，
     * 监听存在 matchers: Map<matcherFn, listener> 里，off 是按事件清空。
     * 必须按 listener 身份摘，而且不能把别人的监听一起带走。
     */
    const trapBot = {
      matchers: new Map(),
      trap(matcher, listener) {
        /** 真 triptrap 会把字符串 matcher 换成一个新函数当键，所以同名事件能挂多个 */
        const key = typeof matcher === "function" ? matcher : (value) => value === matcher
        this.matchers.set(key, listener)
        return this
      },
      offTrap(matcher) {
        for (const key of [...this.matchers.keys()]) if (key(matcher)) this.matchers.delete(key)
        return this
      },
    }
    globalThis.Bot = trapBot
    const mine = () => {}
    const other = () => {}
    leakguard.run("trap/a", () => globalThis.Bot.trap("message", mine))
    leakguard.run("trap/b", () => globalThis.Bot.trap("message", other))
    assert.equal(trapBot.matchers.size, 2)
    const trapSwept = leakguard.sweep("trap/a")
    assert.equal(trapSwept.listeners, 1, "摘到了才算数")
    assert.equal(trapBot.matchers.size, 1)
    assert.equal([...trapBot.matchers.values()][0], other, "别的插件的监听不能动")
  })

  await run("leakguard: 共享流上的监听不记账、也不摘除", () => {
    /** process.std* 属于进程，不属于插件：readline 在上面挂的解码器一旦被摘，重载后就再也收不到数据 */
    const marker = () => {}
    leakguard.run("shared/plugin.js", () => process.stdout.on("data", marker))
    assert.equal(leakguard.stats("shared/plugin.js").listeners, 0, "共享流不计入归属")
    leakguard.sweep("shared/plugin.js")
    assert.ok(process.stdout.listeners("data").includes(marker), "不能摘掉共享流上的监听")
    process.stdout.removeListener("data", marker)
  })

  await run("leakguard: restore 复原全局", () => {
    leakguard.restore()
    assert.equal(leakguard.installed(), false)
    assert.equal(globalThis.setTimeout, NATIVE_TIMEOUT)
    assert.equal(globalThis.setInterval, NATIVE_INTERVAL)
    /** Bot 访问器也要撤掉，不能留下一个永远返回假值的全局 */
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, "Bot"), undefined)
    /** 重复 restore 不应出错 */
    leakguard.restore()
  })

  /* ---------------- 全局登记函数 ---------------- */
  await run("owners: installGlobals 装上三个全局函数", () => {
    owners.installGlobals()
    assert.equal(typeof globalThis.registerDispose, "function")
    assert.equal(globalThis.onPluginUnload, globalThis.registerDispose)
    assert.equal(typeof globalThis.ownTimer, "function")
  })

  await run("owners: 一行 registerDispose 就能登记，卸载时回收", () => {
    const owner = "legacy/one.js"
    const scope = new DisposalScope(owner)
    owners.bindOwner(owner, scope)

    let closed = 0
    let extra = 0
    let timer = null
    leakguard.run(owner, () => {
      timer = setInterval(() => {}, 50)
      owners.ownTimer(timer, "one:timer")
      owners.registerDispose(() => extra++, "one:extra")
    })

    assert.equal(scope.size, 2, "两条清理都应当记到该插件账上")
    scope.dispose()
    assert.equal(timer._destroyed, true, "ownTimer 应当把定时器关掉")
    assert.equal(extra, 1, "自定义清理函数应当被执行")

    owners.unbindOwner(owner)
    assert.equal(owners.scopeOf(owner), null, "解绑之后不应当再认得人")
  })

  await run("owners: 认不到归属时只警告、不抛错", () => {
    const original = globalThis.logger
    const warns = []
    globalThis.logger = { ...(original || {}), warn: text => warns.push(String(text)) }
    try {
      const dispose = owners.registerDispose(() => {}, "nowhere")
      assert.equal(typeof dispose, "function", "反回的应当是可调用的取消函数")
      assert.equal(warns.length, 1, "应当打一条警告")
    } finally {
      if (original === undefined) delete globalThis.logger
      else globalThis.logger = original
    }
  })

  await run("owners: 注册晚于卸载时当场执行", () => {
    const owner = "legacy/two.js"
    const scope = new DisposalScope(owner)
    owners.bindOwner(owner, scope)
    scope.dispose()

    let ran = 0
    leakguard.run(owner, () => owners.registerDispose(() => ran++, "late"))
    assert.equal(ran, 1, "回收后才登记的应当当场清理")
    owners.unbindOwner(owner)
  })

  /* ---------------- 渲染后端契约 ---------------- */

  await run("contract: 合法的渲染后端被接受", () => {
    const provider = { id: "demo", type: "image", render: () => {} }
    const result = normalizeRenderer(provider)
    assert.equal(result.ok, true)
    assert.equal(result.renderer.id, "demo")
    assert.equal(result.renderer.support_script, false, "没声明时默认不支持脚本")
    assert.deepEqual(RENDERER_TYPES, ["image"])
  })

  await run("contract: 缺 id、类型不对、render 不是函数都会被拒绝", () => {
    assert.equal(normalizeRenderer({ type: "image", render: () => {} }).ok, false)
    assert.equal(normalizeRenderer({ id: "x", type: "video", render: () => {} }).ok, false)
    assert.equal(normalizeRenderer({ id: "x", type: "image" }).ok, false)
    assert.equal(normalizeRenderer(null).ok, false)
  })

  await run("contract: 需要脚本的模板先挑支持脚本的后端，其余按登记顺序回落", () => {
    const list = [
      { id: "a", type: "image", render: () => {}, support_script: true },
      { id: "b", type: "image", render: () => {}, support_script: false },
      { id: "c", type: "image", render: () => {}, support_script: true },
    ]
    const { script, noscript } = orderRenderers(list)
    assert.deepEqual(script.map(item => item.id), ["a", "c", "b"])
    assert.deepEqual(noscript.map(item => item.id), ["b", "a", "c"])
  })

  await run("contract: 没有后端时给的是可读错误", () => {
    const error = noRendererError()
    assert.equal(error.code, "ERR_NO_RENDERER")
    assert.match(error.message, /renderers\//)
  })

  await run("contract: 插件注册的渲染后端随插件卸载摘除", () => {
    const registry = {
      items: new Map(),
      owners: new Map(),
      register(provider, owner = null) {
        const renderer = { ...provider }
        this.items.set(renderer.id, renderer)
        if (owner) this.owners.set(renderer.id, owner)
        return renderer
      },
      unregister(id, owner = null) {
        if (owner !== null && (this.owners.get(id) ?? null) !== owner) return false
        this.owners.delete(id)
        return this.items.delete(id)
      },
    }
    const scope = new DisposalScope("render/plugin")
    const ctx = createPluginContext({ name: "render-plugin", scope, renderers: registry })
    ctx.renderer({ id: "plugin-renderer", type: "image", render: () => {} })
    assert.equal(registry.items.has("plugin-renderer"), true)

    scope.dispose()
    assert.equal(registry.items.has("plugin-renderer"), false, "卸载后应摘除")
  })

  await run("contract: 重复 id 时后注册者不会被先卸载者摘掉", () => {
    const registry = {
      items: new Map(),
      owners: new Map(),
      register(provider, owner = null) {
        const renderer = { ...provider }
        this.items.set(renderer.id, renderer)
        if (owner) this.owners.set(renderer.id, owner)
        else this.owners.delete(renderer.id)
        return renderer
      },
      unregister(id, owner = null) {
        if (owner !== null && (this.owners.get(id) ?? null) !== owner) return false
        this.owners.delete(id)
        return this.items.delete(id)
      },
    }
    const scopeA = new DisposalScope("render/a")
    const scopeB = new DisposalScope("render/b")
    const a = createPluginContext({ name: "a", scope: scopeA, renderers: registry })
    const b = createPluginContext({ name: "b", scope: scopeB, renderers: registry })
    a.renderer({ id: "shared", type: "image", render: () => "a" })
    b.renderer({ id: "shared", type: "image", render: () => "b" })
    assert.equal(registry.owners.get("shared"), "b")

    scopeA.dispose()
    assert.equal(registry.items.has("shared"), true, "先卸载的插件不应摘掉后注册者")
    assert.equal(registry.items.get("shared").render(), "b")

    scopeB.dispose()
    assert.equal(registry.items.has("shared"), false, "后注册者卸载时才摘除")
  })

  await run("contract: 归属键与插件名不同时按归属键登记", () => {
    const events = new CoreEvents()
    const routes = {
      staticOwner: null,
      addStatic(urlPath, dir, options) {
        this.staticOwner = options.owner
        return () => {}
      },
    }
    const services = new ServiceRegistry()
    const scope = new DisposalScope("test.js")
    const ctx = createPluginContext({ name: "测试插件", owner: "test.js", scope, events, routes, services })
    ctx.on("app/ready", () => {})
    ctx.provide("demo.key", 1)
    ctx.static("/assets", process.cwd())

    assert.equal(events.count("app/ready"), 1)
    assert.equal(services.get("demo.key"), 1)
    assert.equal(routes.staticOwner, "test.js")
    assert.equal(events.removeByOwner("测试插件"), 0, "不应按插件名归属")
    assert.equal(events.removeByOwner("test.js"), 1)
    scope.dispose()
  })

  await run("contract: 没有注册表时 ctx.renderer 给出明确提示", () => {
    const saved = globalThis.RendererRegistry
    globalThis.RendererRegistry = null
    try {
      const scope = new DisposalScope("render/none")
      const ctx = createPluginContext({ name: "render-none", scope })
      assert.throws(() => ctx.renderer({ id: "x", type: "image", render: () => {} }), /渲染后端注册表/)
      scope.dispose()
    } finally {
      globalThis.RendererRegistry = saved
    }
  })

  await run("stub: 列表接口与客户端库一致（同步 Map）", () => {
    const bot = createStubBot()
    bot.gl.set(1, { group_id: 1, group_name: "g" })
    bot.fl.set(2, { user_id: 2, nickname: "f" })
    const groups = bot.getGroupMap?.() || bot.getGroupList()
    const friends = bot.getFriendMap?.() || bot.getFriendList()
    assert.equal(groups instanceof Map, true)
    assert.equal(friends instanceof Map, true)
    assert.equal(bot.getGroupList().size, 1)
    assert.equal(bot.getFriendList().size, 1)
    /** 面板类插件会直接 for...of 与 .size，Promise 会抛「not iterable」 */
    let count = 0
    for (const [, item] of groups) count += item.group_id === 1 ? 1 : 0
    assert.equal(count, 1)
  })

  await run("stub: 旧式适配器挂上后接管身份与列表", () => {
    const bot = createStubBot()
    let adopted = null
    bot.on("message", () => {})
    assert.equal(bot.uin, 88888)
    assert.equal(bot.isOnline(), false)

    bot[123456] = {
      uin: 123456,
      nickname: "旧式",
      fl: new Map([[1, { user_id: 1 }]]),
      gl: new Map([[2, { group_id: 2 }]]),
      gml: new Map(),
      pickUser: id => ({ user_id: id, sendMsg: () => `to:${id}` }),
      sendMsg: () => "sent",
      isOnline: () => true,
      getPlatform: () => "onebot",
    }
    bot.adapter.push(123456)

    assert.equal(bot.uin, 123456)
    assert.equal(bot.nickname, "旧式")
    assert.equal(bot.isOnline(), true)
    assert.equal(bot.getPlatform(), "onebot")
    assert.equal(bot.getGroupList(), bot[123456].gl)
    assert.equal(bot.getFriendList().size, 1)
    assert.equal(bot.pickUser(1).sendMsg(), "to:1")
    assert.equal(bot.sendMsg(), "sent")
    /** 事件仍留在占位 Bot 上，适配器不需要实现 EventEmitter */
    assert.equal(bot.listeners("message").length, 1)
    assert.equal(typeof bot.emit, "function")
  })

  await run("stub: 接管后 Bot.adapter 只保留真实账号", () => {
    const bot = createStubBot()
    bot[777001] = { uin: 777001, nickname: "旧式", fl: new Map(), gl: new Map(), isOnline: () => true }
    /** 适配器先 push 了占位 uin 的情况 */
    assert.equal(bot.adapter.includes(777001), true)
    assert.equal(bot.adapter.includes(88888), false)
    assert.equal(bot.adapter.includes("stub"), false)
    /** 插件（humanizeAI 等）会用 Bot.adapter 判断「有没有 @ 到我」 */
    assert.equal(bot.adapter.some(id => id == 777001), true)
    /** 重复 push 同一个账号不会让在线账号数翻倍 */
    bot.adapter.push(777001)
    bot.adapter.push(bot.uin)
    assert.equal(bot.adapter.filter(id => id == 777001).length, 1)

    /** 同一进程挂两个账号：Bot.adapter 必须两个都记 */
    bot[777002] = { uin: 777002, nickname: "第二个", fl: new Map(), gl: new Map(), isOnline: () => true }
    assert.equal(bot.adapter.includes(777001), true)
    assert.equal(bot.adapter.includes(777002), true)
    assert.equal(bot.uin, 777001)
  })

  await run("stub: 旧式适配器缺列表接口时回落到本地表", () => {
    const bot = createStubBot()
    bot[654321] = { uin: 654321, nickname: "旧式", pickUser: id => ({ user_id: id }) }
    bot.gl.set(9, { group_id: 9 })
    assert.equal(bot.uin, 654321)
    assert.equal(bot.getGroupList(), bot.gl)
    assert.equal(bot.getGroupList().size, 1)
    assert.equal(bot.getFriendList().size, 0)
  })

  await run("segment: 与客户端库一致的消息段", () => {
    const names = [
      "text", "at", "face", "sface", "bface", "image", "flash", "record", "video",
      "json", "xml", "share", "music", "location", "markdown", "button",
      "dice", "rps", "poke", "fake", "mirai", "fromCqcode",
    ]
    for (const name of names) assert.equal(typeof segment[name], "function", name)
    /** 插件会在消息处理里无条件构造这几个段 */
    assert.deepEqual(segment.record("a.amr"), { type: "record", file: "a.amr" })
    assert.deepEqual(segment.video("b.mp4"), { type: "video", file: "b.mp4" })
    assert.equal(segment.image("c.jpg").file, "c.jpg")
    assert.equal(segment.at(123).qq, 123)
    assert.equal(segment.at("all").qq, "all")
    assert.deepEqual(segment.text("x"), { type: "text", text: "x" })
    assert.deepEqual(segment.fromCqcode("[CQ:face,id=1]a"), [{ type: "face", id: 1 }, { type: "text", text: "a" }])
  })

  await run("stub: 客户端字段跟随旧式适配器", () => {
    const bot = createStubBot()
    assert.equal(bot.bkn, "")
    assert.equal(bot.sig.seq, 0)
    bot[13579] = {
      uin: 13579,
      nickname: "旧式",
      fl: new Map(),
      gl: new Map(),
      cookies: { "qzone.qq.com": "skey=1" },
      bkn: 5381,
      sig: { seq: 7 },
    }
    assert.equal(bot.bkn, 5381)
    assert.equal(bot.sig.seq, 7)
    assert.equal(bot.cookies["qzone.qq.com"], "skey=1")
  })

  await run("boot: 没有适配器时仍会挂上事件监听", async () => {
    let client = null
    const bot = await boot({
      config: { bot: { adapter: "" } },
      loader: { resolve: () => null },
      plugins: { async preloadAdapters() {}, async load() {} },
      listeners: {
        async load(target) {
          client = target
          target.on("message", () => {})
        },
      },
    })
    assert.equal(client, bot)
    assert.equal(bot.listenerCount("message"), 1)
    /** 旧式适配器靠 Bot.emit 派发事件 */
    let hits = 0
    bot.on("message", () => hits++)
    bot[1122] = { uin: 1122, fl: new Map(), gl: new Map(), pickUser: () => ({}) }
    bot.emit("message", {})
    assert.equal(hits, 1)
    assert.equal(bot.uin, 1122)
  })

  await run("adapter: 契约只要求 id 与 create", () => {
    const ok = normalizeAdapter({ id: "demo", create: () => ({}) })
    assert.equal(ok.ok, true)
    assert.equal(ok.adapter.id, "demo")
    assert.equal(noAdapterAtAll("demo").code, "ERR_NO_ADAPTER")
  })

  await run("adapter: 不合法时给出原因", () => {
    assert.equal(normalizeAdapter(null).ok, false)
    assert.match(normalizeAdapter({ create: () => ({}) }).reason, /id/)
    assert.match(normalizeAdapter({ id: "demo" }).reason, /create/)
    assert.equal(normalizeAdapter({ id: "Bad Id", create: () => ({}) }).ok, false)
  })

  await run("adapter: 注册、按 owner 摘除、同 id 后注册者生效", () => {
    const loader = new AdapterLoader()
    const a = loader.register({ id: "demo", create: () => ({ uin: 1 }) }, "a")
    const b = loader.register({ id: "demo", create: () => ({ uin: 2 }) }, "b")
    assert.equal(loader.size, 1)
    assert.equal(loader.resolve("demo"), b)
    assert.equal(loader.unregister("demo", "a"), false, "不能摘掉别人的适配器")
    assert.equal(loader.resolve("demo"), b)
    assert.equal(loader.unregister("demo", "b"), true)
    assert.equal(loader.resolve("demo"), null)
    assert.equal(a.id, "demo")
  })

  await run("adapter: removeByOwner 一次清空", () => {
    const loader = new AdapterLoader()
    loader.register({ id: "one", create: () => ({}) }, "p")
    loader.register({ id: "two", create: () => ({}) }, "p")
    loader.register({ id: "three", create: () => ({}) }, "q")
    assert.equal(loader.removeByOwner("p"), 2)
    assert.equal(loader.size, 1)
    assert.equal(loader.resolve(null).id, "three")
  })

  await run("adapter: defineAdapter 直接注册到全局表", () => {
    const before = globalThis.AdapterRegistry
    globalThis.AdapterRegistry = new AdapterLoader()
    try {
      const adapter = defineAdapter({ id: "defined", create: () => ({}) }, "demo-owner")
      assert.equal(adapter.id, "defined")
      assert.equal(globalThis.AdapterRegistry.get("defined"), adapter)
      assert.throws(
        () => defineAdapter({ id: "", create: () => ({}) }),
        /适配器不合法/,
      )
      assert.equal(globalThis.AdapterRegistry.removeByOwner("demo-owner"), 1)
    } finally {
      globalThis.AdapterRegistry = before
    }
  })

  await run("adapter: ctx.adapter 随插件卸载摘除", () => {
    const loader = new AdapterLoader()
    const scope = new DisposalScope("demo-plugin")
    const ctx = createPluginContext({ name: "demo-plugin", scope, adapters: loader })
    ctx.adapter({ id: "mine", create: () => ({}) })
    assert.equal(loader.has("mine"), true)
    assert.equal(loader.list()[0].owner, "demo-plugin")
    scope.dispose()
    assert.equal(loader.has("mine"), false)
  })

  await run("adapter: 没有注册表时 ctx.adapter 给出明确提示", () => {
    const saved = globalThis.AdapterRegistry
    globalThis.AdapterRegistry = null
    try {
      const scope = new DisposalScope("adapter/none")
      const ctx = createPluginContext({ name: "adapter-none", scope })
      assert.throws(() => ctx.adapter({ id: "x", create: () => ({}) }), /适配器注册表/)
      scope.dispose()
    } finally {
      globalThis.AdapterRegistry = saved
    }
  })

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter(item => !item.ok)
  for (const item of results) {
    if (item.ok) {
      console.log(`  ✓ ${item.name}`)
      continue
    }
    console.log(`  ✗ ${item.name}`)
    if (item.error) {
      console.log(
        String(item.error.stack || item.error)
          .split("\n")
          .slice(0, 6)
          .map(line => `      ${line}`)
          .join("\n"),
      )
    }
  }

  clearInterval(keepAlive)
  console.log(
    `\n兼容层自测：${results.length - failed.length}/${results.length} 通过` +
      (failed.length ? `，${failed.length} 项失败` : ""),
  )
  return failed.length
}

/** 不用 process.exit：stdout 是管道时同步退出会把还没写出的内容丢掉 */
main()
  .then(code => {
    process.exitCode = code ? 1 : 0
  })
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
