/**
 * 带优先级的键值注册表
 *
 * 插件通过它把能力注册回内核：同 key 覆盖、按 priority 升序调用、同优先级按注册顺序。
 * 每条记录可以带一个 owner（插件 key），卸载时按 owner 批量摘除，避免热重载后残留。
 * 不依赖任何外部模块，便于单独测试。
 */
export default class KeyedRegistry {
  constructor() {
    this.map = new Map()
    this.sorted = null
  }

  /**
   * @param key 去重键，同名覆盖
   * @param value 任意值，通常为函数
   * @param priority 越小越先执行
   * @param owner 归属插件，卸载时按它批量摘除
   */
  set(key, value, priority = 5000, owner = undefined) {
    this.map.set(key, { key, value, priority, owner })
    this.sorted = null
    return this
  }

  get(key) {
    return this.map.get(key)?.value
  }

  /** 取整条记录，需要看 owner / priority 时用 */
  getEntry(key) {
    return this.map.get(key)
  }

  has(key) {
    return this.map.has(key)
  }

  delete(key) {
    this.sorted = null
    return this.map.delete(key)
  }

  /** 按归属批量摘除，返回摘掉的条数 */
  deleteByOwner(owner) {
    if (!owner) return 0
    let removed = 0
    for (const [key, entry] of [...this.map]) {
      if (entry.owner === owner) {
        this.map.delete(key)
        removed++
      }
    }
    if (removed) this.sorted = null
    return removed
  }

  clear() {
    this.map.clear()
    this.sorted = null
  }

  get size() {
    return this.map.size
  }

  /** 按 priority 升序排列后的条目 */
  values() {
    if (!this.sorted) {
      this.sorted = [...this.map.values()].sort((a, b) => a.priority - b.priority)
    }
    return this.sorted
  }

  /** 所有 key，便于诊断 */
  keys() {
    return [...this.map.keys()]
  }

  [Symbol.iterator]() {
    return this.values()[Symbol.iterator]()
  }
}
