/**
 * 米游社相关的运行时能力
 *
 * 内核不再 import 这些 model，改由本插件在检测到 genshin 插件后注册回 runtime：
 * - gsCfg / MysInfo / NoteUser / MysUser 与 MysApi 相关方法
 * - e.user 代理，以及 uid / hasCk 快捷方式
 *
 * 未安装 genshin 时整体跳过，runtime 上不会出现这些字段。
 */
import Runtime from "../../lib/plugins/runtime.js"

let gsCfg, MysApi, MysInfo, NoteUser, MysUser

async function loadModels() {
  gsCfg = (await import("../../plugins/genshin/model/gsCfg.js")).default
  MysApi = (await import("../../plugins/genshin/model/mys/mysApi.js")).default
  MysInfo = (await import("../../plugins/genshin/model/mys/mysInfo.js")).default
  NoteUser = (await import("../../plugins/genshin/model/mys/NoteUser.js")).default
  MysUser = (await import("../../plugins/genshin/model/mys/MysUser.js")).default
}

/**
 * 每条消息的初始化：缓存 MysInfo、生成 e.user 代理与快捷字段
 */
async function initUser(runtime) {
  const e = runtime.e
  await MysInfo.initCache()

  const user = await NoteUser.create(e)
  if (user) {
    e.user = new Proxy(user, {
      get(self, key, receiver) {
        let game = e.game
        let fnMap = {
          uid: "getUid",
          uidList: "getUidList",
          mysUser: "getMysUser",
          ckUidList: "getCkUidList",
        }
        if (fnMap[key]) {
          return self[fnMap[key]](game)
        }
        if (key === "uidData") {
          return self.getUidData("", game)
        }
        if (
          ["getUid", "getUidList", "getMysUser", "getCkUidList", "getUidMapList", "getGameDs"].includes(
            key,
          )
        ) {
          return (_game, arg2) => {
            return self[key](_game || game, arg2)
          }
        }
        if (["getUidData", "hasUid", "addRegUid", "delRegUid", "setMainUid"].includes(key)) {
          return (uid, _game = "") => {
            return self[key](uid, _game || game)
          }
        }
        return self[key]
      },
    })
  }

  // 与旧版 runtime 的 getter 等价，改为实例属性，取值走 e.user
  Object.defineProperty(runtime, "user", {
    configurable: true,
    get: () => e.user,
  })
  Object.defineProperty(runtime, "uid", {
    configurable: true,
    get: () => e.user?.uid,
  })
  Object.defineProperty(runtime, "hasCk", {
    configurable: true,
    get: () => e.user?.hasCk,
  })
}

export async function installGenshinRuntime() {
  try {
    await loadModels()
  } catch (err) {
    logger.error("[genshin-compat] 加载 genshin model 失败，已跳过米游社能力")
    logger.error(err)
    return false
  }

  const key = "genshin-compat"

  Runtime.provide("gsCfg", () => gsCfg, key)
  Runtime.provide("MysInfo", () => MysInfo, key)
  Runtime.provide("NoteUser", () => NoteUser, key)
  Runtime.provide("MysUser", () => MysUser, key)

  /**
   * 获取MysInfo实例
   *
   * @param targetType all: 所有用户均可， cookie：查询用户必须具备Cookie
   * @returns {Promise<boolean|MysInfo>}
   */
  Runtime.provide(
    "getMysInfo",
    runtime => async (targetType = "all") => {
      runtime._mysInfo ||= {}
      if (!runtime._mysInfo[targetType]) {
        runtime._mysInfo[targetType] = await MysInfo.init(
          runtime.e,
          targetType === "cookie" ? "detail" : "roleIndex",
        )
      }
      return runtime._mysInfo[targetType]
    },
    key,
  )

  Runtime.provide("getUid", runtime => async () => await MysInfo.getUid(runtime.e), key)

  /**
   * 获取MysApi实例
   *
   * @param targetType all: 所有用户均可， cookie：查询用户必须具备Cookie
   * @param option MysApi option
   * @param isSr 是否为星穹铁道
   * @returns {Promise<boolean|MysApi>}
   */
  Runtime.provide(
    "getMysApi",
    runtime => async (targetType = "all", option = {}, isSr = false) => {
      let mys = await runtime.getMysInfo(targetType)
      if (mys.uid && mys?.ckInfo?.ck) {
        if (isSr) option.game = "sr"
        return new MysApi(mys.uid, mys.ckInfo.ck, option, isSr)
      }
      return false
    },
    key,
  )

  /**
   * 生成MysApi实例
   * @param uid
   * @param ck
   * @param option
   * @param isSr 是否为星穹铁道
   * @returns {MysApi}
   */
  Runtime.provide(
    "createMysApi",
    () => (uid, ck, option, isSr = false) => {
      if (isSr) option.game = "sr"
      return new MysApi(uid, ck, option, isSr)
    },
    key,
  )

  Runtime.onInit(initUser, key)
  return true
}
