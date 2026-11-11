/**
 * 中立的消息段工厂
 *
 * 没有适配器时也要让插件拿到与客户端库一致的 `segment`：键名、参数与字段
 * 都保持同形，否则插件在消息处理里随手构造一个段就会抛 TypeError
 * （例如记录、视频两个段会被无条件构造）。
 *
 * 段对象是扁平结构（`{ type, …字段 }`），适配器负责翻译成自己的协议。
 */

const text = text => ({ type: "text", text })

const face = id => ({ type: "face", id })

const sface = (id, text) => ({ type: "sface", id, text })

const bface = (file, text) => ({ type: "bface", file, text })

const rps = id => ({ type: "rps", id })

const dice = id => ({ type: "dice", id })

/** qq 可以是 QQ 号或 "all"；频道里传 tiny_id */
const at = (qq, text, dummy) => {
  if (typeof qq === "number" || qq === "all") return { type: "at", qq, text, dummy }
  return { type: "at", qq: 0, id: String(qq), text, dummy }
}

const image = (file, cache, timeout, headers) => ({ type: "image", file, cache, timeout, headers })

const flash = (file, cache, timeout, headers) => ({ type: "flash", file, cache, timeout, headers })

const record = (file, data = {}) => ({ type: "record", file, ...data })

const video = (file, data = {}) => ({ type: "video", file, ...data })

const json = data => ({ type: "json", data })

const xml = (data, id) => ({ type: "xml", data, id })

const markdown = content => ({ type: "markdown", content })

const button = content => ({ type: "button", content })

const mirai = data => ({ type: "mirai", data })

/**
 * 音乐卡片需要联网取信息，没有适配器时只给出占位段，
 * 由适配器决定是解析还是忽略。
 */
const music = async (id, platform = "qq") => ({ type: "music", id, platform })

const fake = (user_id, message, nickname, time) => ({ type: "node", user_id, nickname, message, time })

const share = (url, title, image, content) => ({ type: "share", url, title, image, content })

const location = (lat, lng, address, id) => ({ type: "location", lat, lng, address, id })

const poke = id => ({ type: "poke", id })

const UNESCAPE = { "&#91;": "[", "&#93;": "]", "&amp;": "&" }
const UNESCAPE_INSIDE = { ...UNESCAPE, "&#44;": "," }

const unescape = (text, table) => String(text).replace(/&#44;|&#91;|&#93;|&amp;/g, match => table[match] ?? "")

const parseField = value => {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** 把 `[CQ:type,key=value]` 解析成消息链 */
const fromCqcode = (str = "") => {
  const source = String(str)
  const elems = []
  let cursor = 0
  for (const match of source.matchAll(/\[CQ:[^\]]+\]/g)) {
    const before = source.slice(cursor, match.index)
    if (before) elems.push({ type: "text", text: unescape(before, UNESCAPE) })

    const inner = match[0].slice(4, -1)
    const element = { type: "" }
    for (const [index, pair] of inner.split(",").entries()) {
      const split = pair.indexOf("=")
      /** 第一个字段没有键，就是段名 */
      if (split === -1) {
        if (index === 0) element.type = pair
        continue
      }
      const key = pair.slice(0, split)
      const value = pair.slice(split + 1)
      if (key === "type") element.type = value
      else element[key] = parseField(unescape(value, UNESCAPE_INSIDE))
    }
    if (element.type) elems.push(element)
    cursor = match.index + match[0].length
  }
  const rest = source.slice(cursor)
  if (rest) elems.push({ type: "text", text: unescape(rest, UNESCAPE) })
  return elems
}

const segment = {
  text,
  face,
  sface,
  bface,
  rps,
  dice,
  at,
  image,
  flash,
  record,
  video,
  json,
  xml,
  markdown,
  button,
  mirai,
  music,
  fake,
  share,
  location,
  poke,
  fromCqcode,
}

globalThis.segment ??= segment

export {
  text,
  face,
  sface,
  bface,
  rps,
  dice,
  at,
  image,
  flash,
  record,
  video,
  json,
  xml,
  markdown,
  button,
  mirai,
  music,
  fake,
  share,
  location,
  poke,
  fromCqcode,
}

export default segment
