import { EventEmitter } from "node:events"

/**
 * 没有可用适配器时的占位 Bot
 *
 * 插件与标准输入会直接使用 Bot 的常用方法，这里把它们都补齐：
 * 事件三件套（on / once / emit）、列表、发送、以及未知方法的兜底。
 * 兜底只告警不抛错，避免一个缺失的方法把整个插件目录带崩。
 */
export function createStubBot({ uin = 88888, warn = null } = {}) {
  const emitter = new EventEmitter()
  const said = new Set()

  const notSupported =
    name =>
    (...args) => {
      if (!said.has(name)) {
        said.add(name)
        const log = warn ?? globalThis.logger?.warn?.bind(globalThis.logger) ?? console.warn
        log(`[Bot] 当前没有可用适配器，${name} 不会真正发送消息`)
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
      contact.getMemberMap = () => new Map()
      contact.getMemberList = async () => []
    }
    return contact
  }

  const pick = (type, id) => makeContact(type, id)

  const base = {
    uin,
    adapter: ["stub"],
    nickname: "Elia-Yunzai",
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),
    status: 0,
    isOnline: () => false,
    isOffline: () => true,
    isOnlineSync: () => false,
    getPlatform: () => "stub",

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

    pickGroup: group_id => pick("group", group_id),
    pickFriend: user_id => pick("friend", user_id),
    pickUser: user_id => pick("friend", user_id),
    pickMember: (group_id, user_id) => pick("member", user_id),

    sendMsg: notSupported("sendMsg"),
    sendPrivateMsg: notSupported("sendPrivateMsg"),
    sendGroupMsg: notSupported("sendGroupMsg"),
    sendFriendMsg: notSupported("sendFriendMsg"),
    sendTempMsg: notSupported("sendTempMsg"),

    getGroupList: async () => new Map(),
    getFriendList: async () => new Map(),
    getGroupMemberList: async () => new Map(),
    getGroupInfo: async () => null,
    getGroupMemberInfo: async () => null,
    getStrangerInfo: async () => null,
    getGroupNotice: async () => [],
    getSystemMsg: async () => [],

    setGroupBan: notSupported("setGroupBan"),
    setGroupKick: notSupported("setGroupKick"),
    setGroupWholeBan: notSupported("setGroupWholeBan"),
    setGroupAdmin: notSupported("setGroupAdmin"),
    setGroupCard: notSupported("setGroupCard"),
    setGroupLeave: notSupported("setGroupLeave"),
    setGroupName: notSupported("setGroupName"),
    setGroupSpecialTitle: notSupported("setGroupSpecialTitle"),
    deleteFriend: notSupported("deleteFriend"),
    addGroupNotice: notSupported("addGroupNotice"),

    login: notSupported("login"),
    logout: notSupported("logout"),
    terminate: notSupported("terminate"),
    reload: notSupported("reload"),
  }

  base.on = base.on.bind(base)
  base[uin] = base

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "then" || typeof property === "symbol") return undefined
      if (property in target) return Reflect.get(target, property, receiver)
      if (property === "toJSON") return () => ({ uin })
      return notSupported(String(property))
    },
  })
}

export default createStubBot
