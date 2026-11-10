import fs from "node:fs"
import yaml from "yaml"
import cfg from "../config/config.js"
import Renderer from "./Renderer.js"
import { normalizeRenderer, orderRenderers, noRendererError } from "./contract.js"

/** 全局变量 Renderer */
global.Renderer = Renderer

const log = () => globalThis.logger ?? console

/**
 * 渲染后端加载器
 *
 * 只负责发现、注册与排序，具体实现由 renderers/<name>/index.js 提供。
 * 一个后端是一个目录：index.js 导出 (config, host) => renderer。
 */
class RendererLoader {
  constructor() {
    this.renderers = new Map()
    /** id -> 注册者（插件热重载时按归属摘除） */
    this.owners = new Map()
    this.dir = "renderers"
    this.script_renderers = []
    this.noscript_renderers = []
    // TODO 渲染器热加载
    this.watcher = {}
  }

  static async init() {
    const render = new RendererLoader()
    await render.load()
    return render
  }

  /** 供后端工厂使用的宿主能力，避免后端反向 import 内核 */
  get host() {
    return { Renderer, cfg, logger: log() }
  }

  async load() {
    if (!fs.existsSync(this.dir)) {
      log().warn?.(`没有找到 ${this.dir}/ 目录，渲染后端为空`)
      this.consolidate()
      return this
    }
    const subFolders = fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
    for (const subFolder of subFolders) {
      const name = subFolder.name
      if (!fs.existsSync(`${this.dir}/${name}/index.js`)) continue
      try {
        const factory = (await import(`../../${this.dir}/${name}/index.js`)).default
        if (typeof factory !== "function") {
          log().warn?.(`渲染后端 ${name} 不可用：入口没有导出工厂函数`)
          continue
        }
        const configFile = `${this.dir}/${name}/config.yaml`
        const rendererCfg = fs.existsSync(configFile)
          ? yaml.parse(fs.readFileSync(configFile, "utf8")) || {}
          : {}
        const renderer = await factory(rendererCfg, this.host)
        const result = normalizeRenderer(renderer)
        if (!result.ok) {
          log().warn?.(`渲染后端 ${name} 不可用：${result.reason}`)
          continue
        }
        this.renderers.set(result.renderer.id, result.renderer)
        this.owners.delete(result.renderer.id)
        log().info?.(`加载渲染后端 ${result.renderer.id}`)
      } catch (err) {
        log().error?.(`渲染后端 ${name} 加载失败：${err?.message ?? err}`)
        if (err?.code === "ERR_MODULE_NOT_FOUND") {
          log().error?.(`请先在 ${this.dir}/${name} 目录下安装依赖，再重启`)
        }
      }
    }
    this.consolidate()
    return this
  }

  /** 重新计算两套优先级顺序 */
  consolidate() {
    const { script, noscript } = orderRenderers([...this.renderers.values()])
    this.script_renderers = script
    this.noscript_renderers = noscript
  }

  /** 运行期注册一个后端；owner 用于插件卸载时回收 */
  register(provider, owner = null) {
    const result = normalizeRenderer(provider)
    if (!result.ok) {
      log().warn?.(`渲染后端注册失败：${result.reason}`)
      return null
    }
    const renderer = result.renderer
    if (this.renderers.has(renderer.id)) {
      log().warn?.(`渲染后端 ${renderer.id} 被重复注册，后者生效`)
    }
    this.renderers.set(renderer.id, renderer)
    if (owner) this.owners.set(renderer.id, owner)
    else this.owners.delete(renderer.id)
    this.consolidate()
    return renderer
  }

  unregister(id) {
    const existed = this.renderers.delete(id)
    this.owners.delete(id)
    if (existed) this.consolidate()
    return existed
  }

  /** 摘掉某个 owner 注册的全部后端，返回条数 */
  removeByOwner(owner) {
    let count = 0
    for (const [id, holder] of [...this.owners]) {
      if (holder !== owner) continue
      if (this.renderers.delete(id)) count++
      this.owners.delete(id)
    }
    if (count) this.consolidate()
    return count
  }

  has(id) {
    return this.renderers.has(id)
  }

  list() {
    return [...this.renderers.values()].map(i => ({
      id: i.id,
      type: i.type,
      support_script: i.support_script,
      owner: this.owners.get(i.id) ?? null,
    }))
  }

  getRenderer(name = cfg.renderer?.name) {
    return this.renderers.get(name) || this
  }

  async render(name, data) {
    const html = Renderer.readTpl(data.tplFile)
    if (!html) return false
    const order = html.includes("</script>") ? this.script_renderers : this.noscript_renderers
    if (!order.length) throw noRendererError()
    let lastError = null
    for (const i of order) {
      try {
        const res = await i.render(name, data)
        if (res) return res
      } catch (err) {
        lastError = err
        log().error?.(`渲染后端 ${i.id} 渲染错误`, err)
      }
    }
    if (lastError) throw lastError
    return false
  }
}

const rendererLoader = await RendererLoader.init()
/** 供 context / 插件加载器在卸载时按归属摘除运行期注册的后端 */
globalThis.RendererRegistry = rendererLoader

export default rendererLoader
