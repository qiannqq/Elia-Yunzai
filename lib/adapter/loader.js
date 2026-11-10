import { normalizeAdapter } from "./contract.js"
import segment from "./segment.js"

function log() {
  return globalThis.logger ?? console
}

/**
 * 适配器注册表
 *
 * 适配器随插件分发，由插件模块在 import（preload）阶段注册；
 * 这个类只负责保存、按归属摘除与按名字解析。
 */
export class AdapterLoader {
  constructor({ host = null } = {}) {
    this.adapters = new Map()
    this.owners = new Map()
    this.extraHost = host
  }

  get host() {
    return this.extraHost ?? { logger: log(), segment }
  }

  register(provider, owner = null) {
    const result = normalizeAdapter(provider)
    if (!result.ok) {
      log().warn(`[适配器] 注册失败：${result.reason}`)
      return null
    }
    const { adapter } = result
    if (this.adapters.has(adapter.id)) {
      log().warn(`[适配器] id 重复：${adapter.id}，后注册的生效`)
      this.owners.delete(adapter.id)
    }
    this.adapters.set(adapter.id, adapter)
    if (owner) this.owners.set(adapter.id, owner)
    return adapter
  }

  unregister(id, owner = null) {
    const current = this.owners.get(id)
    if (owner && current && current !== owner) return false
    this.owners.delete(id)
    return this.adapters.delete(id)
  }

  removeByOwner(owner) {
    let count = 0
    for (const [id, value] of this.owners) {
      if (value !== owner) continue
      this.owners.delete(id)
      this.adapters.delete(id)
      count++
    }
    return count
  }

  get(id) {
    return this.adapters.get(id)
  }

  has(id) {
    return this.adapters.has(id)
  }

  /** 取指定适配器；没配置时取唯一可用的那个 */
  resolve(name = null) {
    if (name) return this.adapters.get(name) ?? null
    if (this.adapters.size === 1) return [...this.adapters.values()][0]
    return null
  }

  list() {
    return [...this.adapters.values()].map(adapter => ({
      id: adapter.id,
      owner: this.owners.get(adapter.id) ?? null,
    }))
  }

  get size() {
    return this.adapters.size
  }
}

export default AdapterLoader
