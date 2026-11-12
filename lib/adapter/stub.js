import { EventEmitter } from "node:events"

/**
 * 没有可用适配器时的占位 Bot
 *
 * 这是一个普通对象，不包装 Proxy，也不接管旧式适配器实例。
 * 适配器自己维护 Bot、Bot[uin] 与全局 Bot.gl / Bot.fl / Bot.gml，
 * 内核只提供插件与标准输入会用到的基础字段和兜底实现。
 *
 * 因此这里的每个字段都是可写的数据属性：适配器赋值即覆盖，
 * 内核不会把它换回自己的那一份，也不会把实例上的 Map 提到全局。
 */

export function createStubBot({ uin = 88888, warn = null } = {}) {
  const emitter = new EventEmitter()
  const said = new Set()
  const log = warn ?? globalThis.logger?.warn?.bind(globalThis.logger) ?? console.warn

  const notSupported =
    name =>
    (...args) => {
      if (!said.has(name)) {
        said.add(name)
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
      contact.pickMember = uid => makeContact("member", uid)
      contact.getMemberMap = () => base.gml.get(id) ?? new Map()
      contact.getMemberList = async () => [...(base.gml.get(id) ?? new Map()).values()]
    }
    return contact
  }

  const base = {
    uin,
    nickname: "Elia-Yunzai",
    /** 适配器会自己 push 真实账号 */
    adapter: [],
    status: 0,
    avatar: "",
    cookies: {},
    bkn: "",
    sig: { seq: 0 },
    apk: {},
    tiny_id: "",
    guilds: new Map(),
    /** 全局的群、好友、群成员表：所有账号共用这一份 */
    fl: new Map(),
    gl: new Map(),
    gml: new Map(),

    /** 可选的钩子，未设置时按 undefined 处理 */
    prioritizePlugin: undefined,
    InterceptEvent: undefined,
    initCfg: undefined,
    icqq: undefined, // kernel-purity-ignore

    on(...args) {
      emitter.on(...args)
      return base
    },
    addListener(...args) {
      emitter.addListener(...args)
      return base
    },
    prependListener(...args) {
      emitter.prependListener(...args)
      return base
    },
    once(...args) {
      emitter.once(...args)
      return base
    },
    prependOnceListener(...args) {
      emitter.prependOnceListener(...args)
      return base
    },
    off(...args) {
      emitter.off(...args)
      return base
    },
    removeListener(...args) {
      emitter.removeListener(...args)
      return base
    },
    removeAllListeners(...args) {
      emitter.removeAllListeners(...args)
      return base
    },
    emit(...args) {
      return emitter.emit(...args)
    },
    listeners(event) {
      return emitter.listeners(event)
    },
    listenerCount(event) {
      return emitter.listenerCount(event)
    },
    eventNames() {
      return emitter.eventNames()
    },
    setMaxListeners(count) {
      emitter.setMaxListeners(count)
      return base
    },

    isOnline() {
      return false
    },
    isOffline() {
      return true
    },
    isOnlineSync() {
      return false
    },
    getPlatform() {
      return "stub"
    },

    pickGroup(id) {
      return makeContact("group", id)
    },
    pickFriend(id) {
      return makeContact("friend", id)
    },
    pickUser(id) {
      return makeContact("user", id)
    },
    pickMember(groupId, userId) {
      return makeContact("member", userId)
    },

    sendMsg: notSupported("sendMsg"),
    sendPrivateMsg: notSupported("sendPrivateMsg"),
    sendGroupMsg: notSupported("sendGroupMsg"),
    sendFriendMsg: notSupported("sendFriendMsg"),
    sendTempMsg: notSupported("sendTempMsg"),

    getGroupList() {
      return base.gl
    },
    getFriendList() {
      return base.fl
    },
    getGroupMap() {
      return base.gl
    },
    getFriendMap() {
      return base.fl
    },
    async getGroupMemberList() {
      return []
    },
    async getGroupInfo() {
      return null
    },
    async getGroupMemberInfo() {
      return null
    },
    async getStrangerInfo() {
      return null
    },
    async getGroupNotice() {
      return []
    },
    async getSystemMsg() {
      return []
    },

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

  base[uin] = base
  return base
}

export default createStubBot
