/**
 * 归属追踪与兜底回收
 *
 * 现实前提：不能假设插件作者会适配登记簿。所以这里不要求插件配合，而是按「归属」
 * 自动收回旧插件自己创建的定时器、事件监听和监听中的服务：
 *
 * 1. 用 AsyncLocalStorage 记下「当前正在执行哪个插件的代码」。加载器的 import、
 *    setup、init、规则回调、handler、任务回调都包一层，异步后续会自然继承归属。
 * 2. 在这个上下文里创建的 setTimeout / setInterval / setImmediate、登记的事件监听、
 *    开始 listen 的服务，都被记上一笔归属。
 * 3. 插件卸载时 sweep(owner) 把它们全清掉，并返回清了多少，由加载器打印。
 *
 * 只在确有归属时记录，内核自己的定时器与监听没有额外开销；
 * 所有对全局的改写都可通过 restore() 原样撤回，测试里默认就是这么干的。
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { EventEmitter } from "node:events"
import net from "node:net"

const als = new AsyncLocalStorage()

const state = {
  timers: new Map(),
  listeners: new Map(),
  servers: new Map(),
  counters: new Map(),
  originals: null,
}

/** 已经打过补丁的 Bot 实例（WeakSet：Bot 换一个就重新包一个） */
const patchedBots = new WeakSet()

/** 在某个插件归属下执行同步或异步逻辑 */
export function run(owner, fn) {
  if (!owner) return fn()
  return als.run(owner, fn)
}

/** 当前归属，没有则为 undefined */
export function current() {
  return als.getStore()
}

function bump(owner, kind, delta) {
  let record = state.counters.get(owner)
  if (!record) {
    record = { timers: 0, listeners: 0, servers: 0 }
    state.counters.set(owner, record)
  }
  record[kind] = Math.max(0, record[kind] + delta)
  return record
}

/** 某个归属当前还挂着的数量 */
export function stats(owner) {
  return state.counters.get(owner) || { timers: 0, listeners: 0, servers: 0 }
}

function rememberTimer(kind, handle) {
  const owner = als.getStore()
  if (!owner || !handle) return handle
  state.timers.set(handle, { owner, kind })
  bump(owner, "timers", 1)
  return handle
}

function forgetTimer(handle) {
  const record = state.timers.get(handle)
  if (!record) return
  state.timers.delete(handle)
  bump(record.owner, "timers", -1)
}

/**
 * process.stdin / stdout / stderr 是进程级共享流。
 *
 * readline 之类的内部实现会在上面挂一次性解码器，并带一个幂等哨兵：第一次挂过之后，
 * 后面新建 Interface 时不会再挂。要是卸载时把它摘了，新的实例就再也收不到数据
 * （实测：摘掉之后 `data` 监听归零，重载后的 readline 完全静默）。
 *
 * 所以这几个流上的监听一律不记账、不摘除 —— 它们的生命周期属于进程，不属于插件。
 */
let sharedStreams = null
let resolvingShared = false

/** 共享流上误记的监听一律勾掉：它们本来就不该算在插件头上 */
function pruneSharedRecords() {
  if (!sharedStreams) return
  for (const [emitter, set] of state.listeners) {
    if (!sharedStreams.has(emitter)) continue
    for (const record of set) bump(record.owner, "listeners", -1)
    state.listeners.delete(emitter)
  }
}

function collectSharedStreams() {
  resolvingShared = true
  try {
    sharedStreams = new Set([process.stdin, process.stdout, process.stderr])
  } finally {
    resolvingShared = false
  }
  pruneSharedRecords()
}

/**
 * 访问 process.stdin 会惰性创建 ReadStream，它的构造函数会挂监听 → 又回到这里。
 * 那几条记录是「探测」的副作用，不能算给当前插件，所以取完立刻勾掉。
 */
function isSharedStream(emitter) {
  if (resolvingShared) return false
  if (!sharedStreams) collectSharedStreams()
  return sharedStreams.has(emitter)
}

/** 安装时就取好，热路径上不再触发惰性构造 */
function primeSharedStreams() {
  if (!sharedStreams) collectSharedStreams()
}

function rememberListener(emitter, event, fn) {
  const owner = als.getStore()
  if (!owner) return
  if (isSharedStream(emitter)) return
  let set = state.listeners.get(emitter)
  if (!set) {
    set = new Set()
    state.listeners.set(emitter, set)
  }
  /** Bot 实例与 EventEmitter 原型都会被包装，同一个监听会被记两次，这里合并成一条 */
  for (const record of set) {
    if (record.event === event && record.fn === fn) return
  }
  set.add({ event, fn, owner })
  bump(owner, "listeners", 1)
}

function forgetListener(emitter, event, fn) {
  const set = state.listeners.get(emitter)
  if (!set) return
  for (const record of set) {
    if (record.event === event && record.fn === fn) {
      set.delete(record)
      bump(record.owner, "listeners", -1)
    }
  }
  if (!set.size) state.listeners.delete(emitter)
}

/** removeAllListeners 之后按事件（或全部）销账 */
function forgetAllListeners(emitter, event) {
  const set = state.listeners.get(emitter)
  if (!set) return
  for (const record of [...set]) {
    if (event !== undefined && record.event !== event) continue
    set.delete(record)
    bump(record.owner, "listeners", -1)
  }
  if (!set.size) state.listeners.delete(emitter)
}

/**
 * 从 emitter 上摘掉一个监听，返回是否真的摘到了
 *
 * triptrap（icqq 的 Bot 用的就是它）没有 removeListener，事件存在
 * `matchers: Map<matcherFn, listener>` 里；而它的 `off(matcher)` 是按**事件**清空，
 * 拿它来摘单个监听会顺手删掉别的插件 —— 所以这里优先按 listener 身份删 matchers。
 */
function detach(emitter, event, fn) {
  if (!emitter) return false

  if (emitter.matchers instanceof Map) {
    let removed = false
    for (const [matcherFn, listener] of [...emitter.matchers]) {
      if (listener !== fn) continue
      emitter.matchers.delete(matcherFn)
      removed = true
    }
    return removed
  }

  if (typeof emitter.removeListener === "function") {
    try {
      emitter.removeListener(event, fn)
      return true
    } catch (ignored) {}
  }

  if (typeof emitter.off === "function") {
    try {
      emitter.off(event, fn)
      return true
    } catch (ignored) {}
  }

  return false
}

/** 把延迟函数的回调包一层：一次性定时器触发后不再占记录 */
function wrapOnce(kind, fn) {
  const ref = { handle: null }
  const wrapped = function (...args) {
    if (kind !== "interval") forgetTimer(ref.handle)
    return fn.apply(this, args)
  }
  return { wrapped, ref }
}

function patchTimers() {
  const originals = state.originals
  const guard = fn =>
    typeof fn === "function" ? fn : () => {}

  globalThis.setTimeout = function (fn, ms, ...args) {
    if (typeof fn !== "function" || !als.getStore()) return originals.setTimeout.call(this, fn, ms, ...args)
    const { wrapped, ref } = wrapOnce("timeout", guard(fn))
    const handle = originals.setTimeout.call(this, wrapped, ms, ...args)
    ref.handle = handle
    rememberTimer("timeout", handle)
    return handle
  }

  globalThis.setInterval = function (fn, ms, ...args) {
    if (typeof fn !== "function" || !als.getStore()) return originals.setInterval.call(this, fn, ms, ...args)
    const { wrapped, ref } = wrapOnce("interval", guard(fn))
    const handle = originals.setInterval.call(this, wrapped, ms, ...args)
    ref.handle = handle
    rememberTimer("interval", handle)
    return handle
  }

  globalThis.setImmediate = function (fn, ...args) {
    if (typeof fn !== "function" || !als.getStore()) return originals.setImmediate.call(this, fn, ...args)
    const { wrapped, ref } = wrapOnce("immediate", guard(fn))
    const handle = originals.setImmediate.call(this, wrapped, ...args)
    ref.handle = handle
    rememberTimer("immediate", handle)
    return handle
  }

  globalThis.clearTimeout = function (handle) {
    forgetTimer(handle)
    return originals.clearTimeout.call(this, handle)
  }

  globalThis.clearInterval = function (handle) {
    forgetTimer(handle)
    return originals.clearInterval.call(this, handle)
  }

  globalThis.clearImmediate = function (handle) {
    forgetTimer(handle)
    return originals.clearImmediate.call(this, handle)
  }
}

function patchEmitter() {
  const proto = EventEmitter.prototype
  const originals = state.originals.emitter
  const originalOn = originals.on

  proto.on = proto.addListener = function (event, fn) {
    const ret = originalOn.call(this, event, fn)
    rememberListener(this, event, fn)
    return ret
  }

  proto.once = function (event, fn) {
    const ret = originals.once.call(this, event, fn)
    /** Node 会把 fn 包一层，但 removeListener(event, fn) 仍能匹配，记录原始 fn 即可 */
    rememberListener(this, event, fn)
    return ret
  }

  proto.removeListener = proto.off = function (event, fn) {
    const ret = originals.removeListener.call(this, event, fn)
    forgetListener(this, event, fn)
    return ret
  }

  proto.removeAllListeners = function (event) {
    const ret = originals.removeAllListeners.call(this, event)
    forgetAllListeners(this, event)
    return ret
  }
}

function patchServer() {
  const proto = net.Server.prototype
  const originalListen = proto.listen
  proto.listen = function (...args) {
    const owner = als.getStore()
    if (owner) {
      state.servers.set(this, { owner })
      bump(owner, "servers", 1)
    }
    return originalListen.apply(this, args)
  }
}

/**
 * Bot 是全局单例，插件的监听基本都挂在它身上。
 * 原型改写只能管到继承来的 on；icqq 若在实例上自带同名方法（或者插件把 Bot 换成了别的实现），
 * 就会从记账里漏过去 —— 重载一次多一份，这正是「影分身」的来源。
 * 所以这里直接给实例本身打补丁，真实 Bot 一被赋值就包一层。
 *
 * 注意 icqq 的 Bot 并不是 Node 的 EventEmitter：BaseClient 继承 triptrap.Trapper，
 * 事件存在 `matchers: Map<matcherFn, listener>` 里，只有 `trap/trapOnce/offTrap`，
 * 连 `removeListener` 都没有。所以三组方法都要包，摘除时按 listener 身份直接改 matchers。
 */
const LISTEN_METHODS = ["on", "addListener", "prependListener", "trap"]
const UNLISTEN_METHODS = ["removeListener", "off", "offTrap"]

function patchBot(bot) {
  if (!bot || (typeof bot !== "object" && typeof bot !== "function")) return bot
  if (patchedBots.has(bot)) return bot
  patchedBots.add(bot)

  /** Bot 若是被冻结/密封的对象，包装失败也不能把登录带崩：能包几个算几个 */
  const define = (name, original, wrapper) => {
    if (typeof original !== "function") return
    try {
      Object.defineProperty(bot, name, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: wrapper(original),
      })
    } catch (ignored) {}
  }

  for (const name of LISTEN_METHODS) {
    define(name, bot[name], original => function (event, fn, ...rest) {
      const ret = original.call(this, event, fn, ...rest)
      rememberListener(this, event, fn)
      return ret
    })
  }

  /**
   * once 不用单独包：Node 的 once 内部会走 on，triptrap 的 trapOnce 内部会走 trap，
   * 两条路都已经在上面记过账了 —— 再记一次会变成「监听 2 个、实际只有 1 个」。
   */
  for (const name of UNLISTEN_METHODS) {
    define(name, bot[name], original => function (event, fn, ...rest) {
      const ret = original.call(this, event, fn, ...rest)
      /** triptrap 的 off/offTrap 只认 matcher：不传 listener 时等于「这个事件的都摘」 */
      if (typeof fn === "function") forgetListener(this, event, fn)
      else forgetAllListeners(this, event)
      return ret
    })
  }

  define("removeAllListeners", bot.removeAllListeners, original => function (event) {
    const ret = original.call(this, event)
    forgetAllListeners(this, event)
    return ret
  })

  return bot
}

/** Bot 是 `global.Bot = bot` 这种直赋值，所以截住赋值本身 */
function patchBotGlobal() {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "Bot")
  state.originals.bot = desc
  let value = desc && "value" in desc ? desc.value : undefined
  if (value) patchBot(value)
  Object.defineProperty(globalThis, "Bot", {
    configurable: true,
    enumerable: true,
    get() {
      return value
    },
    set(next) {
      value = next
      patchBot(next)
    },
  })
}

/** 安装（幂等） */
export function install() {
  if (state.originals) return false
  state.originals = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    setImmediate: globalThis.setImmediate,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
    clearImmediate: globalThis.clearImmediate,
    emitter: {
      on: EventEmitter.prototype.on,
      once: EventEmitter.prototype.once,
      removeListener: EventEmitter.prototype.removeListener,
      removeAllListeners: EventEmitter.prototype.removeAllListeners,
    },
    listen: net.Server.prototype.listen,
  }
  primeSharedStreams()
  patchTimers()
  patchEmitter()
  patchServer()
  patchBotGlobal()
  return true
}

/** 撤回全部改写（测试与卸载内核时用） */
export function restore() {
  if (!state.originals) return false
  const o = state.originals
  globalThis.setTimeout = o.setTimeout
  globalThis.setInterval = o.setInterval
  globalThis.setImmediate = o.setImmediate
  globalThis.clearTimeout = o.clearTimeout
  globalThis.clearInterval = o.clearInterval
  globalThis.clearImmediate = o.clearImmediate
  EventEmitter.prototype.on = o.emitter.on
  EventEmitter.prototype.addListener = o.emitter.on
  EventEmitter.prototype.once = o.emitter.once
  EventEmitter.prototype.removeListener = o.emitter.removeListener
  EventEmitter.prototype.off = o.emitter.removeListener
  EventEmitter.prototype.removeAllListeners = o.emitter.removeAllListeners
  net.Server.prototype.listen = o.listen
  /** 撤回 Bot 访问器：有原描述符就还原，没有就把这个键删掉 */
  if (o.bot) Object.defineProperty(globalThis, "Bot", o.bot)
  else delete globalThis.Bot
  state.originals = null
  state.timers.clear()
  state.listeners.clear()
  state.servers.clear()
  state.counters.clear()
  return true
}

/** 是否已安装 */
export function installed() {
  return !!state.originals
}

/**
 * 按归属回收自建资源
 * @returns {{ timers: number, listeners: number, servers: number }}
 */
export function sweep(owner) {
  const result = { timers: 0, listeners: 0, servers: 0 }
  if (!owner) return result

  for (const [handle, record] of [...state.timers]) {
    if (record.owner !== owner) continue
    try {
      if (record.kind === "interval") clearInterval(handle)
      else if (record.kind === "immediate") clearImmediate(handle)
      else clearTimeout(handle)
      result.timers++
    } catch (ignored) {}
    forgetTimer(handle)
  }

  for (const [emitter, set] of [...state.listeners]) {
    for (const record of [...set]) {
      if (record.owner !== owner) continue
      try {
        /** 摘不到就不算数：日志里的数字必须是真卸掉的 */
        if (detach(emitter, record.event, record.fn)) result.listeners++
      } catch (ignored) {}
      /** detach 可能已经通过改写过的 removeListener 销过账，这里只在还留着时补一次 */
      if (set.has(record)) {
        set.delete(record)
        bump(record.owner, "listeners", -1)
      }
    }
    if (!set.size) state.listeners.delete(emitter)
  }

  for (const [server, record] of [...state.servers]) {
    if (record.owner !== owner) continue
    try {
      server.close?.()
      server.unref?.()
      result.servers++
    } catch (ignored) {}
    state.servers.delete(server)
    bump(owner, "servers", -1)
  }

  state.counters.delete(owner)
  return result
}

/** 诊断快照 */
export function snapshot() {
  return {
    installed: !!state.originals,
    timers: state.timers.size,
    listeners: state.listeners.size,
    servers: state.servers.size,
  }
}

export default { install, restore, installed, run, current, sweep, stats, snapshot }
