export * from "./common/common.js"
import ConfigController from "./config/config.js"
export { ConfigController }
import cfg from "./config/config.js"
import segmentFactory from "./adapter/segment.js"

/** 兼容旧写法：交给当前适配器去准备登录 */
export async function createLogin() {
  const registry = globalThis.AdapterRegistry
  const adapter = registry?.resolve?.(cfg.bot.adapter)
  if (!adapter?.prepare) return
  await adapter.prepare({ cfg, logger: globalThis.logger ?? console, segment: segmentFactory, loader: registry })
}
import Handler from "./plugins/handler.js"
export { Handler }
export * from "./plugins/index.js"
import Plugin from "./plugins/plugin.js"
export { Plugin }
import Loader from "./plugins/loader.js"
export { Loader }
import Runtime from "./plugins/runtime.js"
export { Runtime }
import renderService, { screenshot, screenshots } from "./renderer/render.js"
export { renderService as puppeteer, screenshot, screenshots }
import Renderer from "./renderer/Renderer.js"
export { Renderer }
export { defineAdapter, registerAdapter } from "./adapter/define.js"
export { default as AdapterLoader } from "./adapter/loader.js"
export { default as adapterSegment } from "./adapter/segment.js"
import renderer from "./renderer/loader.js"
export { renderer }
export const Bot = new Proxy(
  {},
  {
    get(_, property) {
      return global.Bot[property]
    },
  },
)
export const Redis = new Proxy(
  {},
  {
    get(_, property) {
      return global.redis[property]
    },
  },
)

/**
 * 使用方法

import { Plugin } from '#yunzai'
class Word extends Plugin{
  constructor(){
    super({})
  }
  async post(){
    this.e.reply("post")
  }
}

 */
