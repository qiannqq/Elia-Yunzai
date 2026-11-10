/**
 * 内存版 redis
 *
 * 只有 redis 不可用时才会被装上：保留内核用到的几个命令，
 * 数据不落盘、重启即丢，但启动与插件加载不会因此中断。
 */
export function createMemoryRedis() {
  const store = new Map()
  const expiring = new Map()

  const alive = key => {
    const at = expiring.get(key)
    if (at === undefined) return store.has(key)
    if (Date.now() < at) return store.has(key)
    store.delete(key)
    expiring.delete(key)
    return false
  }

  const get = async key => (alive(key) ? store.get(key) : null)
  const set = async (key, value, options = {}) => {
    store.set(key, String(value))
    if (options?.EX) expiring.set(key, Date.now() + options.EX * 1000)
    return "OK"
  }

  const api = {
    async get(key) {
      return get(key)
    },
    async set(key, value, options) {
      return set(key, value, options)
    },
    async del(...keys) {
      let count = 0
      for (const key of keys.flat()) {
        if (store.delete(key)) count++
        expiring.delete(key)
      }
      return count
    },
    async exists(key) {
      return alive(key) ? 1 : 0
    },
    async keys(pattern = "*") {
      const reg = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
      return [...store.keys()].filter(key => alive(key) && reg.test(key))
    },
    async incr(key) {
      const value = Number(await get(key) ?? 0) + 1
      await set(key, value)
      return value
    },
    async decr(key) {
      const value = Number(await get(key) ?? 0) - 1
      await set(key, value)
      return value
    },
    async expire(key, seconds) {
      if (!alive(key)) return 0
      expiring.set(key, Date.now() + seconds * 1000)
      return 1
    },
    async ttl(key) {
      const at = expiring.get(key)
      if (at === undefined) return alive(key) ? -1 : -2
      return Math.max(0, Math.round((at - Date.now()) / 1000))
    },
    async save() {
      return "OK"
    },
    async flushdb() {
      store.clear()
      expiring.clear()
      return "OK"
    },
    async quit() {
      return "OK"
    },
    async disconnect() {},
    async connect() {},
    on() {
      return api
    },
    once() {
      return api
    },
    duplicate() {
      return api
    },
  }

  return new Proxy(api, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver)
      if (typeof property === "symbol") return undefined
      /** thenable 会让 await 把这里当成 Promise，必须返回 undefined */
      if (property === "then" || property === "catch" || property === "finally") return undefined
      return async () => null
    },
  })
}

export default createMemoryRedis
