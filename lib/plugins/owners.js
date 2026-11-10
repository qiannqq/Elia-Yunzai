import leakguard from "./leakguard.js"

/**
 * 插件归属表：owner（插件 key）→ 该插件的 DisposalScope
 *
 * 有了这张表和一份全局函数，老插件不必改成 ctx 写法也能登记：
 *
 *   const timer = setInterval(fn, 5000)
 *   registerDispose(() => clearInterval(timer))
 *
 * 归属来自 AsyncLocalStorage（leakguard.run 在执行插件代码时设立的），
 * 所以只要调用发生在「以该插件身份执行」的代码里（模块顶层、setup、init、
 * 事件回调、定时任务、中间件……）就能认到人。
 */
const scopes = new Map()

export function bindOwner(owner, scope) {
  if (!owner || !scope) return false
  scopes.set(owner, scope)
  return true
}

export function unbindOwner(owner, scope) {
  if (!owner) return false
  if (scope && scopes.get(owner) !== scope) return false
  return scopes.delete(owner)
}

export function scopeOf(owner = leakguard.current()) {
  if (!owner) return null
  return scopes.get(owner) ?? null
}

export function ownerCount() {
  return scopes.size
}

function report(text) {
  const logger = globalThis.logger
  if (logger?.warn) logger.warn(text)
  else if (logger?.error) logger.error(text)
  else console.warn(text)
}

/**
 * 登记一条清理函数，插件卸载时按登记顺序的**逆序**执行
 *
 * - 返回一个幂等的取消登记函数（提前撤销时用它）
 * - 作用域已经回收过（注册晚于卸载）则当场执行，避免半路创建的东西留下
 * - 认不到归属时只警告、不抛错：不能因为一行登记把整个插件带崩
 */
export function registerDispose(fn, label = "anonymous") {
  const noop = () => {}
  if (typeof fn !== "function") {
    report(`[登记] 清理项必须是函数，收到的是 ${typeof fn}（${label}）`)
    return noop
  }

  const owner = leakguard.current()
  const scope = owner ? scopes.get(owner) : null
  if (!scope) {
    report(`[登记] 没有找到插件归属（${owner || "无上下文"}），这条清理函数不会被回收：${label}`)
    return noop
  }
  if (scope.disposed) {
    try {
      fn()
    } catch (ignored) {}
    return noop
  }
  return scope.add(fn, label)
}

/**
 * 登记一个定时器/间隔器的清除动作
 * 只做「认得出是哪种句柄」这一件事，其余交给 registerDispose
 */
export function ownTimer(timer, label = "timer") {
  if (!timer) return timer
  const isInterval = timer._repeat != null
  registerDispose(() => (isInterval ? clearInterval(timer) : clearTimeout(timer)), label)
  return timer
}

/** 装上全局函数（幂等）。名字保留两个：短的那个给老插件，长的那个给读得懂意图的人 */
export function installGlobals(target = globalThis) {
  target.registerDispose = registerDispose
  target.onPluginUnload = registerDispose
  target.ownTimer = ownTimer
}

export default { bindOwner, unbindOwner, scopeOf, registerDispose, ownTimer, installGlobals }
