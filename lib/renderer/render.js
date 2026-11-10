import Renderer from "./loader.js"
import segment from "../adapter/segment.js"

/**
 * 渲染入口
 *
 * 内核只认「渲染并截图」这一个动作，具体后端由 renderers/ 决定。
 * 老插件的 screenshot / screenshots 调用方式不变。
 */

function resolve() {
  return Renderer.getRenderer()
}

async function screenshot(name, data) {
  const img = await resolve().render(name, data)
  return img ? (globalThis.segment ?? segment).image(img) : img
}

async function screenshots(name, data) {
  data.multiPage = true
  const imgs = (await resolve().render(name, data)) || []
  const ret = []
  for (const img of imgs) {
    ret.push(img ? (globalThis.segment ?? segment).image(img) : img)
  }
  return ret.length > 0 ? ret : false
}

/** 兼容：老代码会取 getRenderer() 后直接调用这两个方法 */
Renderer.screenshot = screenshot
Renderer.screenshots = screenshots

export default Renderer
export { screenshot, screenshots, Renderer as renderer }
