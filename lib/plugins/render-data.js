/**
 * 渲染数据合并
 *
 * 与运行时、渲染器解耦的纯函数，便于单测。
 * 合并顺序固定为：内核默认 → 插件提供者 → 调用方 data → 内核终值。
 * 内核终值（_plugin / _htmlPath / pluResPath / tplFile / saveId / pageGotoParams）不允许被覆盖。
 */

/** lodash.repeat 的最小替代，避免为一行逻辑引入依赖 */
function repeat(str, n) {
  let ret = ""
  for (let i = 0; i < n; i++) ret += str
  return ret
}

/**
 * @param ctx.plugin 插件目录名
 * @param ctx.segments 模板路径拆分后的片段
 * @param ctx.data 调用方传入的渲染数据
 * @param ctx.config 全局配置，用于取 package.version
 * @param providers KeyedRegistry.values() 的结果
 */
export function buildRenderData(ctx, providers = []) {
  const { plugin, segments = [], data = {}, config } = ctx
  const pluResPath = `../../../${repeat("../", segments.length)}plugins/${plugin}/resources/`

  /** 内核默认值 */
  const base = {
    sys: { scale: 1 },
    copyright: `Created By Elia-Yunzai<span class="version">${config?.package?.version || ""}</span> `,
    _res_path: pluResPath,
    pluResPath,
  }

  /** 插件提供者 */
  const extra = {}
  const providerCtx = { ...ctx, data }
  for (const { key, value } of providers) {
    if (typeof value !== "function") continue
    try {
      const ret = value(providerCtx)
      if (ret && typeof ret === "object") Object.assign(extra, ret)
    } catch (err) {
      if (typeof globalThis.logger === "undefined") {
        console.error(`[Runtime][renderData:${key}]`, err)
      } else {
        globalThis.logger.error(`[Runtime][renderData:${key}]`, err)
      }
    }
  }

  /** 调用方数据覆盖提供者与默认值 */
  const merged = { ...base, ...extra, ...data }

  return {
    ...merged,
    _plugin: plugin,
    _htmlPath: segments.join("/"),
    pluResPath,
    tplFile: `./plugins/${plugin}/resources/${segments.join("/")}.html`,
    saveId: data.saveId || data.save_id || segments[segments.length - 1],
    pageGotoParams: {
      waitUntil: "networkidle2",
    },
  }
}
