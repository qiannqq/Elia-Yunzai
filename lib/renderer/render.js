import Renderer from "./loader.js"

/**
 * 渲染入口
 *
 * 内核只认「渲染并截图」这一个动作，具体后端由 renderers/ 决定。
 * 老插件里的 puppeteer.screenshot / puppeteer.screenshots 仍然可用。
 */
const renderer = Renderer.getRenderer()

async function screenshot(name, data) {
  const img = await renderer.render(name, data)
  return img ? segment.image(img) : img
}

async function screenshots(name, data) {
  data.multiPage = true
  const imgs = (await renderer.render(name, data)) || []
  const ret = []
  for (const img of imgs) {
    ret.push(img ? segment.image(img) : img)
  }
  return ret.length > 0 ? ret : false
}

renderer.screenshot = screenshot
renderer.screenshots = screenshots

export default renderer
export { screenshot, screenshots, renderer }
