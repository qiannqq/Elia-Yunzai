/**
 * 中立的消息段工厂
 *
 * 内核只按扁平段 `{ type, ... }` 拼消息，具体平台如何解释由适配器决定。
 */

function image(file, name) {
  return { type: "image", file, ...(name ? { name } : {}) }
}

function at(qq, text = "") {
  return { type: "at", qq: Number(qq), text }
}

function text(value) {
  return { type: "text", text: String(value) }
}

function face(id) {
  return { type: "face", id: Number(id) }
}

function reply(id) {
  return { type: "reply", id }
}

const segment = { image, at, text, face, reply, button: () => "" }

globalThis.segment ??= segment

export { image, at, text, face, reply }
export default segment
