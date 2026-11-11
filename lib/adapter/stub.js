import { EventEmitter } from "node:events"

/**
 * 没有可用适配器时的占位 Bot
 *
 * 插件与标准输入会直接使用 Bot 的常用方法，这里把它们都补齐：
 * 事件三件套（on / once / emit）、列表、发送、以及未知方法的兜底。
 * 兜底只告警不抛错，避免一个缺失的方法把整个插件目录带崩。
 *
 * 旧式适配器不注册适配器表，而是把自己的实例挂到
 * Bot[uin] 上（并把群、好友同时写进 Bot.gl / Bot.fl）。这类实例出现
 * 之后，占位 Bot 会把 uin、列表与发送方法转交给它，插件照旧读全局 Bot。
 */

const DELEGATED = [
  "pickGroup",
  "pickFriend",
  "pickUser",
  "pickMember",
  "sendMsg",
  "sendPrivateMsg",
  "sendGroupMsg",
  "sendFriendMsg",
  "sendTempMsg",
  "getGroupList",
  "getFriendList",
  "getGroupMap",
  "getFriendMap",
  "getGroupMemberList",
  "getGroupInfo",
  "getGroupMemberInfo",
  "getStrangerInfo",
  "getGroupNotice",
  "getSystemMsg",
  "setGroupBan",
  "setGroupKick",
  "setGroupWholeBan",
  "setGroupAdmin",
  "setGroupCard",
  "setGroupLeave",
  "setGroupName",
  "setGroupSpecialTitle",
  "deleteFriend",
  "addGroupNotice",
  "login",
  "logout",
  "terminate",
  "reload",
]

/** 旧式适配器实例：数字 uin + 群/好友表 */
function isLegacyBot(value) {
  if (!value || typeof value !== "object") return false
  if (!Number.isInteger(value.uin)) return false
  return value.fl instanceof Map || value.gl instanceof Map || typeof value.pickUser === "function"
}

export function createStubBot({ uin = 88888, warn = null, onAdopt = null } = {}) {
  const emitter = new EventEmitter()
  const said = new Set()
  let adopted = null
  let fallbackUin = uin

  const log = warn ?? globalThis.logger?.warn?.bind(globalThis.logger) ?? console.warn

  const notSupported =
    name =>
    (...args) => {
      if (!said.has(name)) {
        said.add(name)
        log(`[Bot] ${adopted ? `适配器 ${adopted.uin} 未实现` : "当前没有可用适配器"}，${name} 不会真正发送消息`)
      }
      return null
    }

  const makeContact = (type, id) => {
    const contact = {
      [type === "group" ? "group_id" : "user_id"]: id,
      sendMsg: notSupported(`${type}.sendMsg`),
      recallMsg: notSupported(`${type}.recallMsg`),
      getInfo: async () => null,
      getAvatarUrl: () => "",
    }
    if (type === "group") {
      contact.pickMember = uid => pick("member", uid)
      contact.getMemberMap = () => base.gml.get(id) ?? new Map()
      contact.getMemberList = async () => [...(base.gml.get(id) ?? new Map()).values()]
    }
    return contact
  }

  const pick = (type, id) => {
    const target = resolve()
    const fn = target?.[`pick${type[0].toUpperCase()}${type.slice(1)}`]
    if (typeof fn === "function") return fn.call(target, id)
    return makeContact(type, id)
  }

  /** 找挂到 Bot[uin] 上的旧式适配器实例 */
  const resolve = () => {
    if (adopted && base[adopted.uin] === adopted) return adopted
    adopted = null
    for (const key of Object.keys(base)) {
      /** 只看数字键，避免读 uin / nickname 这些 getter 时递归 */
      if (!/^\d+$/.test(key)) continue
      const value = base[key]
      if (value === base || !isLegacyBot(value)) continue
      if (Number(key) !== value.uin) continue
      adopted = value
      said.clear()
      onAdopt?.(value)
      return adopted
    }
    return null
  }

  const base = {
    adapter: ["stub"],
    status: 0,
    /** 客户端库的常规字段，插件会直接读 */
    avatar: "",
    cookies: {},
    bkn: "",
    sig: { seq: 0 },
    apk: {},
    tiny_id: "",
    guilds: new Map(),
    /** 可选的钩子，未设置时按 undefined 处理，不要落进未知方法的兜底 */
    prioritizePlugin: undefined,
    InterceptEvent: undefined,
    initCfg: undefined,
    icqq: undefined, // kernel-purity-ignore 客户端库的接口名

    on: (...args) => emitter.on(...args) && base,
    addListener: (...args) => emitter.addListener(...args) && base,
    prependListener: (...args) => emitter.prependListener(...args) && base,
    once: (...args) => emitter.once(...args) && base,
    prependOnceListener: (...args) => emitter.prependOnceListener(...args) && base,
    off: (...args) => emitter.off(...args) && base,
    removeListener: (...args) => emitter.removeListener(...args) && base,
    removeAllListeners: (...args) => emitter.removeAllListeners(...args) && base,
    emit: (...args) => emitter.emit(...args),
    listeners: event => emitter.listeners(event),
    listenerCount: event => emitter.listenerCount(event),
    eventNames: () => emitter.eventNames(),
    setMaxListeners: n => emitter.setMaxListeners(n) && base,
  }

  /** 身份与列表跟着适配器走，事件留在占位 Bot 上 */
  Object.defineProperties(base, {
    uin: {
      get: () => resolve()?.uin ?? fallbackUin,
      set: value => {
        fallbackUin = value
      },
      configurable: true,
    },
    nickname: { get: () => resolve()?.nickname ?? "Elia-Yunzai", configurable: true },
    fl: { get: () => resolve()?.fl ?? base._fl, configurable: true },
    gl: { get: () => resolve()?.gl ?? base._gl, configurable: true },
    gml: { get: () => resolve()?.gml ?? base._gml, configurable: true },
    isOnline: { value: () => (resolve() ? resolve().isOnline?.() ?? true : false), configurable: true },
    isOffline: { value: () => !base.isOnline(), configurable: true },
    isOnlineSync: { value: () => (!resolve() ? false : resolve().isOnlineSync?.() ?? true), configurable: true },
    getPlatform: { value: () => resolve()?.getPlatform?.() ?? "stub", configurable: true },
  })

  base._fl = new Map()
  base._gl = new Map()
  base._gml = new Map()
  base[uin] = base

  /** 适配器会自己维护的客户端字段 */
  const DATA_FIELDS = new Set(["avatar", "cookies", "bkn", "sig", "apk", "tiny_id", "guilds", "status"])

  /** 适配器没实现的查询，按客户端库的契约回落到本地表 */
  const FALLBACK = {
    getGroupList: () => base.gl,
    getFriendList: () => base.fl,
    getGroupMap: () => base.gl,
    getFriendMap: () => base.fl,
    getGroupMemberList: async () => [],
  }

  for (const name of DELEGATED) {
    Object.defineProperty(base, name, {
      configurable: true,
      value: (...args) => {
        const target = resolve()
        const fn = target?.[name]
        if (typeof fn === "function") return fn.apply(target, args)
        if (FALLBACK[name]) return FALLBACK[name](...args)
        return notSupported(name)(...args)
      },
    })
  }

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "then" || typeof property === "symbol") return undefined
      if (property === "toJSON") return () => ({ uin: target.uin })

      const legacy = resolve()
      /** 客户端字段会被适配器更新（cookie、bkn），优先取实例上的那一份 */
      if (legacy && DATA_FIELDS.has(property) && legacy[property] !== undefined) return legacy[property]
      if (property in target) return Reflect.get(target, property, receiver)

      const value = legacy?.[property]
      if (value !== undefined) return typeof value === "function" ? value.bind(legacy) : value
      return notSupported(String(property))
    },
    set(target, property, value) {
      target[property] = value
      return true
    },
  })
}

export default createStubBot
