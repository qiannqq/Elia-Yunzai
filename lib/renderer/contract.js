/**
 * 渲染后端契约
 *
 * 一个渲染后端是一个对象：{ id, type, render(name, data), support_script? }。
 * 这里只做校验与排序，不依赖任何第三方模块，便于单测。
 */
export const RENDERER_TYPES = ["image"]

/** 校验并规范化一个渲染器对象；不合格时返回原因。原地补齐字段，保持对象同一性。 */
export function normalizeRenderer(value) {
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "渲染器必须是对象" }
  }
  const id = typeof value.id === "string" ? value.id.trim() : ""
  if (!id) return { ok: false, reason: "缺少 id" }

  const type = value.type || "image"
  if (!RENDERER_TYPES.includes(type)) {
    return { ok: false, reason: `type 只支持 ${RENDERER_TYPES.join(", ")}` }
  }
  if (typeof value.render !== "function") {
    return { ok: false, reason: "render 不是函数" }
  }

  value.id = id
  value.type = type
  value.support_script = Boolean(value.support_script)
  return { ok: true, renderer: value }
}

/** 按模板是否需要脚本分成两组：需要脚本的排在前面，不需要的排在后面。 */
export function orderRenderers(list = []) {
  return {
    script: [...list.filter(i => i.support_script), ...list.filter(i => !i.support_script)],
    noscript: [...list.filter(i => !i.support_script), ...list.filter(i => i.support_script)],
  }
}

/** 一个后端都没有时的统一错误。 */
export function noRendererError() {
  const err = new Error(
    "没有可用的渲染后端。请在 renderers/ 下安装 puppeteer 或 shotium，或者用 ctx.renderer() 注册一个",
  )
  err.code = "ERR_NO_RENDERER"
  return err
}
