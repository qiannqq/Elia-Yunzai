/**
 * 兼容入口
 *
 * 早期插件直接引用过这个文件。内核已不再依赖 puppeteer，
 * 渲染统一走 lib/renderer/render.js，具体后端由 renderers/ 决定。
 */
export { renderer as default, screenshot, screenshots } from "../renderer/render.js"
