/**
 * 内核兼容层
 *
 * 内核本身不认识任何具体插件，原先写死在 lib 里的米游社相关能力由这里接回去：
 * - 消息预处理：星铁 / 绝区零命令前缀，e.isSr / e.isGs
 * - 渲染数据：_miao_path / _tpl_path / defaultLayout / elemLayout
 * - runtime 服务：gsCfg / MysInfo / NoteUser / MysUser / MysApi 及 e.user
 *
 * 是否安装 miao-plugin、genshin 都不影响内核启动，只是少掉对应的那部分能力。
 */
import fs from "node:fs"
import plugin from "../../lib/plugins/plugin.js"
import { installMsgPrefix } from "./msg-game-prefix.js"
import { installRenderData } from "./render-miao-data.js"
import { installGenshinRuntime } from "./runtime-genshin.js"

export default class genshinCompat extends plugin {
  constructor() {
    super({
      name: "genshin-compat",
      dsc: "内核兼容层：把米游社相关能力接回 runtime",
      event: "message",
      priority: 1,
      rule: [],
    })
  }

  /**
   * @param ctx 内核给的插件上下文，登记的清理函数会随卸载一起回收
   */
  async init(ctx) {
    const hasMiao = fs.existsSync("./plugins/miao-plugin")
    const hasGenshin = fs.existsSync("./plugins/genshin")

    installRenderData(ctx)
    if (hasMiao || hasGenshin) installMsgPrefix(ctx)
    if (hasGenshin) await installGenshinRuntime(ctx)

    logger.mark(
      `[genshin-compat] 已装载：miao-plugin ${hasMiao ? "有" : "无"}，genshin ${hasGenshin ? "有" : "无"}`,
    )
  }
}
