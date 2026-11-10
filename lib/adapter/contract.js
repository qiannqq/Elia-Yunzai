/**
 * 适配器契约
 *
 * 一个适配器是一个对象：
 *   { id, prepare?(host), create(config, host), login?(bot, host), segment? }
 * `create` 必须返回一个 Bot 实例：带 `uin`，能 `on(event, handler)`，
 * 其余能力（pickGroup、pickUser、fl、gl…）由适配器自己补齐。
 */

const ID_RE = /^[a-z][a-z0-9._-]*$/i

export function normalizeAdapter(value) {
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "适配器必须是一个对象" }
  }
  const id = typeof value.id === "string" ? value.id.trim() : ""
  if (!ID_RE.test(id)) {
    return { ok: false, reason: "缺少合法的 id（小写字母开头，可含 . _ -）" }
  }
  if (typeof value.create !== "function") {
    return { ok: false, reason: "缺少 create(config, host)" }
  }
  if (value.login !== undefined && typeof value.login !== "function") {
    return { ok: false, reason: "login 必须是函数" }
  }
  return { ok: true, adapter: value }
}

export function noAdapterError(name) {
  const detail = name ? `：${name}` : ""
  const err = new Error(
    `没有可用的适配器${detail}。请在插件的 adapter.js 中提供，或在 config/config/bot.yaml 里设置 bot.adapter`,
  )
  err.code = "ERR_NO_ADAPTER"
  return err
}
