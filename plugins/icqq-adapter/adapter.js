import { Client, segment } from "icqq"
import { defineAdapter } from "../../lib/adapter/define.js"
import createQQ from "./qq.js"
import { install as installLogin } from "./login.js"
import { load } from "./config.js"

/**
 * icqq 适配器
 *
 * 以插件形式随仓库分发：模块被 preload 时注册到适配器注册表，
 * 启动流程按 `bot.adapter` 取用；账号与登录开关都在
 * plugins/icqq-adapter/config/config.yaml。
 */
export default defineAdapter(
  {
    id: "icqq",
    segment,

    /** 首次启动时收集账号配置，并从旧的 qq.yaml / bot.yaml 迁移 */
    async prepare() {
      await createQQ()
    },

    create(botConfig) {
      const conf = load()
      const bot = new Client({
        ...botConfig,
        platform: conf.platform,
        data_dir: `${process.cwd()}/data/icqq/${conf.qq || "default"}`,
      })
      installLogin(bot)
      return bot
    },

    async login(bot) {
      const conf = load()
      if (!conf.enable || !conf.qq) {
        bot.uin = 88888
        bot[bot.uin] = bot
        ;(globalThis.logger ?? console).mark("[icqq-adapter] 未启用登录，仅加载插件")
        return false
      }
      return bot.login(conf.qq, conf.pwd)
    },
  },
  "icqq-adapter",
)
