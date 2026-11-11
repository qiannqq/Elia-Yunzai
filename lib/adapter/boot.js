import cfg from "../config/config.js"
import AdapterLoader from "./loader.js"
import segment from "./segment.js"
import createStubBot from "./stub.js"

function log() {
  return globalThis.logger ?? console
}

function mark(message) {
  const logger = log()
  ;(logger.mark ?? logger.info ?? console.log).call(logger, message)
}

/**
 * 启动流程
 *
 * 解析适配器 → prepare → create → 挂 global.Bot / global.segment
 * → 加载监听事件 → 登录（适配器返回 false 表示不登录，直接加载插件）
 */
export async function boot({ loader = null, listeners = null, plugins = null, config = cfg } = {}) {
  const listenerLoader = listeners ?? (await import("../listener/loader.js")).default
  const pluginLoader = plugins ?? (await import("../plugins/loader.js")).default
  const host = { cfg: config, logger: log(), segment }

  /** 适配器随插件分发，先让插件把各自声明的适配器注册进来 */
  await pluginLoader.preloadAdapters?.()

  const registry = loader ?? globalThis.AdapterRegistry ?? new AdapterLoader({ host })
  if (!globalThis.AdapterRegistry) globalThis.AdapterRegistry = registry

  const name = config.bot.adapter
  const adapter = registry.resolve(name)

  if (!adapter) {
    mark("[适配器] 没有注册适配器，使用占位 Bot；旧式适配器挂上后会自动接管")
    global.Bot = createStubBot({
      uin: 88888,
      onAdopt: bot => mark(`[适配器] 已接管 ${bot.nickname ?? "未知"}(${bot.uin})`),
    })
    global.segment = globalThis.segment ?? segment
    /** 旧式适配器通过 Bot.emit 派发事件，监听器必须挂在占位 Bot 上 */
    await listenerLoader.load(global.Bot)
    await pluginLoader.load()
    return global.Bot
  }

  host.loader = registry
  await adapter.prepare?.(host)

  const bot = await adapter.create(config.bot, host)
  if (!bot || typeof bot !== "object") {
    throw new Error(`适配器 ${adapter.id} 没有返回 Bot 实例`)
  }

  /** 适配器没给 uin 时先占位，登录成功后由适配器更新 */
  if (bot.uin === undefined || bot.uin === null) bot.uin = 88888
  bot[bot.uin] = bot
  if (!Array.isArray(bot.adapter)) bot.adapter = []

  global.Bot = bot
  global.segment = adapter.segment ?? segment

  await listenerLoader.load(bot)

  const login =
    adapter.login ?? ((target, ctx) => target.login(ctx.cfg?.qq, ctx.cfg?.pwd))
  const started = await login(bot, host)
  bot[bot.uin] = bot

  /** 适配器选择不登录时，插件照常加载，等价于原来的跳过登录 */
  if (started === false) {
    await pluginLoader.load()
  }

  return bot
}

export default boot
