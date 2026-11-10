import Puppeteer from "./lib/puppeteer.js"

/**
 * puppeteer 渲染后端
 *
 * @param config config.yaml 的内容，缺省为空对象
 * @param host 内核注入的 { Renderer, cfg, logger }
 */
export default function (config, host) {
  return new Puppeteer(config || {}, host || {})
}
