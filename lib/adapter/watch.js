/**
 * 适配器接入日志
 *
 * 内核不接管适配器，只在 Bot.adapter 出现新账号时打一条日志。
 * 账号对象由适配器自己挂到 Bot[uin] 上，这里只读。
 */

function currentList(bot) {
  return Array.isArray(bot?.adapter) ? bot.adapter : []
}

export function watchAdapters(bot, { interval = 1000, logger = null } = {}) {
  const seen = new Set()
  for (const id of currentList(bot)) seen.add(id)

  const tick = () => {
    const log = logger ?? globalThis.logger
    for (const id of currentList(bot)) {
      if (seen.has(id)) continue
      const account = bot[id]
      /** 账号对象可能晚于 uin 出现，下一轮再看 */
      if (!account) continue
      seen.add(id)
      const nickname = account.nickname ?? "未知"
      const uin = account.uin ?? id
      const version = account.version?.name || "未知"
      const tag = typeof log?.blue === "function" ? log.blue("[Adapter]") : "[Adapter]"
      const write = log?.mark ?? log?.info ?? console.log
      write.call(log, `${tag} ${nickname}(${uin}) 适配器接入 ${version}`)
    }
  }

  const timer = setInterval(tick, interval)
  timer.unref?.()
  tick()

  return {
    tick,
    dispose() {
      clearInterval(timer)
    },
  }
}

export default watchAdapters
