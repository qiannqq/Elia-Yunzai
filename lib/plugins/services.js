/**
 * 跨插件服务表
 *
 * 与 Yunzai-NG 的 plugin/services.ts 同一套语义：
 * - 键名有固定形状，避免插件随手写 "a b" 这种没法排查的名字
 * - 每个键记住归属，插件卸载时按归属整批摘掉
 * - waitFor 在支持方装载之前也能等，超时返回 undefined 而不是抛错
 */
const KEY_RE = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+)*$/i

export class ServiceRegistry {
  constructor() {
    /** key -> { value, owner } */
    this.map = new Map()
    /** key -> Set<{ resolve, timer }> */
    this.waiters = new Map()
  }

  get size() {
    return this.map.size
  }

  /** 校验键名形状 */
  static checkKey(key) {
    if (typeof key !== "string" || !KEY_RE.test(key)) {
      throw new Error(
        `服务键名不合法：${String(key)}，应形如 demo:status、render.layout、a-b`,
      )
    }
    return key
  }

  /**
   * 登记一个服务
   * @param key 服务键
   * @param value 值
   * @param owner 归属，默认与键相同
   * @returns Disposer，撤销后该键立即变回未提供
   */
  provide(key, value, owner = key) {
    ServiceRegistry.checkKey(key)
    this.map.set(key, { value, owner })
    this.settle(key, value)
    return () => {
      /** 只摘自己那一份：后来的提供者不该被前一位的 Disposer 误删 */
      if (this.map.get(key)?.value === value) this.remove(key)
    }
  }

  get(key) {
    return this.map.get(key)?.value
  }

  has(key) {
    return this.map.has(key)
  }

  require(key, hint = "") {
    if (!this.map.has(key)) {
      throw new Error(`缺少必需的服务：${key}${hint ? `（${hint}）` : ""}`)
    }
    return this.map.get(key).value
  }

  /**
   * 等待某个服务出现
   * @param key 服务键
   * @param timeout 超时毫秒，默认 30 秒，0 表示不限
   */
  async waitFor(key, timeout = 30000) {
    if (this.map.has(key)) return this.map.get(key).value
    return await new Promise(resolve => {
      const waiter = { resolve, timer: null }
      if (timeout > 0) {
        waiter.timer = setTimeout(() => {
          this.waiters.get(key)?.delete(waiter)
          resolve(undefined)
        }, timeout)
        waiter.timer.unref?.()
      }
      if (!this.waiters.has(key)) this.waiters.set(key, new Set())
      this.waiters.get(key).add(waiter)
    })
  }

  /** 有服务到位时唤醒等待者 */
  settle(key, value) {
    const set = this.waiters.get(key)
    if (!set?.size) return
    for (const waiter of [...set]) {
      if (waiter.timer) clearTimeout(waiter.timer)
      waiter.resolve(value)
    }
    set.clear()
    this.waiters.delete(key)
  }

  remove(key) {
    this.map.delete(key)
    /** 提供方走了，等待者按「等不到」处理，与 NG 一致 */
    const set = this.waiters.get(key)
    if (set?.size) {
      for (const waiter of [...set]) {
        if (waiter.timer) clearTimeout(waiter.timer)
        waiter.resolve(undefined)
      }
      set.clear()
      this.waiters.delete(key)
    }
  }

  /** 按归属批量摘除 */
  removeByOwner(owner) {
    if (!owner) return 0
    let removed = 0
    for (const [key, record] of [...this.map]) {
      if (record.owner === owner) {
        this.remove(key)
        removed++
      }
    }
    return removed
  }

  keys() {
    return [...this.map.keys()]
  }

  clear() {
    for (const key of [...this.map.keys()]) this.remove(key)
  }
}

export default new ServiceRegistry()
