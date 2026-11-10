/**
 * 内核事件总线
 *
 * 事件名沿用 Yunzai-NG 的 CoreEventMap。
 * 同一事件按 priority 升序执行，同优先级按登记顺序；单个监听器抛错不影响其余。
 */
const REPORT = (event, err) => {
  const message = `[事件][${event}] 监听器执行出错`
  if (globalThis.logger?.error) {
    globalThis.logger.error(message)
    globalThis.logger.error(err)
  } else {
    console.error(message, err)
  }
}

export class CoreEvents {
  constructor() {
    /** event -> [{ fn, once, priority, owner }] */
    this.map = new Map()
  }

  /**
   * 登记一个监听器
   * @param event 事件名
   * @param fn 回调
   * @param options.owner 归属，卸载时按它批量摘除
   * @param options.priority 越小越先执行，默认 100
   * @param options.once 只执行一次
   * @returns Disposer
   */
  on(event, fn, { owner = null, priority = 100, once = false } = {}) {
    if (typeof fn !== "function") throw new Error(`事件 ${event} 的监听器必须是函数`)
    const record = { fn, once, priority, owner }
    const list = this.map.get(event)
    if (list) {
      list.push(record)
      list.sort((a, b) => a.priority - b.priority)
    } else {
      this.map.set(event, [record])
    }
    return () => this.off(event, fn)
  }

  once(event, fn, options = {}) {
    return this.on(event, fn, { ...options, once: true })
  }

  off(event, fn) {
    const list = this.map.get(event)
    if (!list) return false
    const index = fn ? list.findIndex(item => item.fn === fn) : -1
    if (index < 0) {
      if (!fn) {
        this.map.delete(event)
        return true
      }
      return false
    }
    list.splice(index, 1)
    if (!list.length) this.map.delete(event)
    return true
  }

  /**
   * 触发事件
   * @returns 实际被调用的监听器数量
   */
  emit(event, ...args) {
    const list = this.map.get(event)
    if (!list?.length) return 0
    /** 拷贝一份：监听器内部可能继续 on / off */
    const snapshot = [...list]
    let called = 0
    for (const record of snapshot) {
      if (record.once) this.off(event, record.fn)
      called++
      try {
        const ret = record.fn(...args)
        /** 异步监听器抛错也要兜住，避免变成 unhandledRejection */
        if (ret && typeof ret.then === "function") ret.then(null, err => REPORT(event, err))
      } catch (err) {
        REPORT(event, err)
      }
    }
    return called
  }

  /** 按归属批量摘除，返回摘掉的条数 */
  removeByOwner(owner) {
    if (!owner) return 0
    let removed = 0
    for (const [event, list] of [...this.map]) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].owner === owner) {
          list.splice(i, 1)
          removed++
        }
      }
      if (!list.length) this.map.delete(event)
    }
    return removed
  }

  /** 某个事件的监听器数量 */
  count(event) {
    return this.map.get(event)?.length || 0
  }

  clear() {
    this.map.clear()
  }
}

export default new CoreEvents()
