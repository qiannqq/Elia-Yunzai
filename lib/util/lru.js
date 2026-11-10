/**
 * 带 TTL 的 LRU 缓存
 *
 * 语义与 Yunzai-NG 的 util/lru.ts 一致：
 * - get 命中后把条目挪到队尾（最近使用），过期即删除
 * - ttl 为 0 表示不过期
 * - fetch 对同一个 key 只允许一个在途请求（单飞），避免缓存击穿
 */
export default class LruCache {
  /**
   * @param options.max 最大条目数，至少为 1
   * @param options.ttl 默认存活时间（毫秒），0 表示不过期
   */
  constructor({ max = 1000, ttl = 0 } = {}) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`cache.max 必须是正整数，收到：${max}`)
    }
    this.max = max
    this.ttl = Number(ttl) || 0
    this.map = new Map()
    this.pending = new Map()
    this.hits = 0
    this.misses = 0
  }

  get size() {
    return this.map.size
  }

  get stats() {
    return { hits: this.hits, misses: this.misses, size: this.map.size, max: this.max }
  }

  /** 条目是否已过期 */
  expired(entry) {
    return entry.exp !== null && entry.exp <= Date.now()
  }

  get(key) {
    const entry = this.map.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }
    if (this.expired(entry)) {
      this.map.delete(key)
      this.misses++
      return undefined
    }
    /** 命中后挪到队尾，保证淘汰的是最久未使用的 */
    this.map.delete(key)
    this.map.set(key, entry)
    this.hits++
    return entry.value
  }

  has(key) {
    const entry = this.map.get(key)
    if (!entry) return false
    if (this.expired(entry)) {
      this.map.delete(key)
      return false
    }
    return true
  }

  set(key, value, ttl = this.ttl) {
    if (this.map.has(key)) this.map.delete(key)
    const alive = Number(ttl) || 0
    this.map.set(key, { value, exp: alive > 0 ? Date.now() + alive : null })
    this.evict()
    return this
  }

  delete(key) {
    return this.map.delete(key)
  }

  clear() {
    this.map.clear()
    this.pending.clear()
  }

  /**
   * 取缓存，未命中就调用 loader 并写回
   * @param key 缓存键
   * @param loader (key) => Promise<V>
   */
  async fetch(key, loader) {
    const hit = this.get(key)
    if (hit !== undefined) return hit
    if (this.pending.has(key)) return this.pending.get(key)
    const task = (async () => {
      try {
        const value = await loader(key)
        this.set(key, value)
        return value
      } finally {
        this.pending.delete(key)
      }
    })()
    this.pending.set(key, task)
    return task
  }

  evict() {
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
    }
  }
}
