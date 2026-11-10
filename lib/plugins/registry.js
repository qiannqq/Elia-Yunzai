/**
 * 带优先级的键值注册表
 *
 * 插件通过它把能力注册回内核：同 key 覆盖、按 priority 升序调用、同优先级按注册顺序。
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
   */
  set(key, value, priority = 5000) {
    this.map.set(key, { key, value, priority })
    this.sorted = null
    return this
  }

  get(key) {
    return this.map.get(key)?.value
  }

  has(key) {
    return this.map.has(key)
  }

  delete(key) {
    this.sorted = null
    return this.map.delete(key)
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

  [Symbol.iterator]() {
    return this.values()[Symbol.iterator]()
  }
}
