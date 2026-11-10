import { normalizeAdapter } from "./contract.js"
import AdapterLoader from "./loader.js"
import segment from "./segment.js"

function registry() {
  if (!globalThis.AdapterRegistry) {
    const logger = globalThis.logger ?? console
    globalThis.AdapterRegistry = new AdapterLoader({ host: { logger, segment } })
  }
  return globalThis.AdapterRegistry
}

/**
 * 注册一个适配器
 *
 * 适配器随插件分发，模块在 preload 阶段被 import 时调用它即可：
 *   export default defineAdapter({ id, segment, create, login }, "my-adapter")
 */
export function defineAdapter(definition, owner = null) {
  const result = normalizeAdapter(definition)
  if (!result.ok) throw new Error(`适配器不合法：${result.reason}`)
  return registry().register(result.adapter, owner)
}

/** 全局便利方法，老写法在模块顶层直接调用 */
export function registerAdapter(definition, owner = null) {
  return defineAdapter(definition, owner)
}

globalThis.defineAdapter ??= defineAdapter
globalThis.registerAdapter ??= registerAdapter

export default defineAdapter
