/**
 * 中立的消息段工厂
 *
 * 没有适配器时也要让插件拿到与客户端库一致的 `segment`：
 * 常用的 text / at / image / record / video / json / xml / share / markdown …
 * 一个都不能少，否则插件在消息处理里随手构造一个段就会抛 TypeError。
 * 段对象是扁平结构（`{ type, …字段 }`），适配器负责翻译成自己的协议。
 */

const text = value => ({ type: "text", text: String(value ?? "") })

/** qq 可以是 QQ 号，也可以是 "all" */
const at = (qq, text = "") => ({ type: "at", qq, ...(text ? { text } : {}) })

const face = id => ({ type: "face", id })

const sface = id => ({ type: "sface", id })

const bface = (file, text, id) => ({ type: "bface", file, text, id })

const image = (file, name = "") => ({ type: "image", file, ...(name ? { name } : {}) })

const flash = file => ({ type: "flash", file })

const record = file => ({ type: "record", file })

const video = file => ({ type: "video", file })

const json = data => ({ type: "json", data })

const xml = data => ({ type: "xml", data })

const share = (url, title = "", content = "", image = "") => ({ type: "share", url, title, content, image })

const music = data =>
  typeof data === "object" && data ? { type: "music", ...data } : { type: "music", id: data }

const location = (lat, lon, title = "", content = "") => ({ type: "location", lat, lon, title, content })

const markdown = content => ({ type: "markdown", content })

const keyboard = content => ({ type: "keyboard", content })

const button = content => ({ type: "button", content })

const dice = id => ({ type: "dice", id })

const rps = id => ({ type: "rps", id })

const poke = id => ({ type: "poke", id })

const file = (file, name = "") => ({ type: "file", file, name })

const mface = data => ({ type: "mface", ...data })

const forward = id => ({ type: "forward", id })

const node = content => ({ type: "node", ...content })

const reply = id => ({ type: "reply", id })

const fake = data => ({ type: "fake", ...data })

const mirai = data => ({ type: "mirai", data })

/** CQ 码原样交给适配器，没有适配器时按文本处理 */
const fromCqcode = code => ({ type: "text", text: String(code ?? "") })

const segment = {
  text,
  at,
  face,
  sface,
  bface,
  image,
  flash,
  record,
  video,
  json,
  xml,
  share,
  music,
  location,
  markdown,
  keyboard,
  button,
  dice,
  rps,
  poke,
  file,
  mface,
  forward,
  node,
  reply,
  fake,
  mirai,
  fromCqcode,
}

globalThis.segment ??= segment

export {
  text,
  at,
  face,
  sface,
  bface,
  image,
  flash,
  record,
  video,
  json,
  xml,
  share,
  music,
  location,
  markdown,
  keyboard,
  button,
  dice,
  rps,
  poke,
  file,
  mface,
  forward,
  node,
  reply,
  fake,
  mirai,
  fromCqcode,
}

export default segment
