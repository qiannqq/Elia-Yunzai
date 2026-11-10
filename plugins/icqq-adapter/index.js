import plugin from "../../lib/plugins/plugin.js"

/**
 * icqq 适配器的插件外壳
 *
 * 适配器本体在 adapter.js，启动前由加载器 preload 并注册；
 * 这个类只让它在插件列表里可见、可随插件一起热重载。
 */
export default class icqqAdapter extends plugin {
  constructor() {
    super({
      name: "icqq-adapter",
      dsc: "icqq 适配器：登录与消息段",
      event: "message",
      priority: 5000,
      rule: [],
    })
  }

  async init() {
    logger.mark("[icqq-adapter] 适配器已注册，登录方式见 config/config/bot.yaml 的 adapter")
  }
}
