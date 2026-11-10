/**
 * 星铁 / 绝区零命令前缀标准化
 *
 * 内核不再认识具体游戏，这段逻辑由本插件以消息预处理器的方式注册回去：
 * 命中时把 e.msg 标准化为 #星铁 / #绝区零 开头，并维护 e.game。
 */
import loader from "../../lib/plugins/loader.js"

/** 星铁命令前缀 */
const srReg = /^#?(\*|星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道)+/
/** 绝区零命令前缀 */
const zzzReg = /^#?(%|％|绝区零|绝区)+/

/** 登记归 this 插件所有，卸载时按 owner 摘除 */
const OWNER = "genshin-compat"
const KEY = "genshin-compat:game-prefix"

export function installMsgPrefix(ctx) {
  loader.useMsgPreprocessor(
    e => {
      // e.isSr = true，且命令标准化为 #星铁 开头
      Object.defineProperty(e, "isSr", {
        get: () => e.game === "sr",
        set: v => (e.game = v ? "sr" : "gs"),
      })
      Object.defineProperty(e, "isGs", {
        get: () => e.game === "gs",
        set: v => (e.game = v ? "gs" : "sr"),
      })
      if (srReg.test(e.msg)) {
        e.game = "sr"
        e.msg = e.msg.replace(srReg, "#星铁")
      } else if (zzzReg.test(e.msg)) {
        e.game = "zzz"
        // 只替换开头部分
        e.msg = e.msg.replace(zzzReg, "#绝区零")
      }
    },
    { key: KEY, priority: 100, owner: OWNER },
  )
  ctx?.onDispose(() => loader.offMsgPreprocessor(KEY))
}
