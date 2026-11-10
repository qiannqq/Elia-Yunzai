/**
 * plugin的runtime，可通过e.runtime访问
 *
 * 内核只提供通用能力：配置、common、渲染入口与 handler。
 * 与具体插件相关的能力由插件通过 provide / onInit / renderData 注册进来，
 * 内核源码不 import 任何插件。
 */
import fs from "node:fs"
import config from "../config/config.js"
import common from "../common/common.js"
import renderer from "../renderer/render.js"
import Handler from "./handler.js"
import KeyedRegistry from "./registry.js"
import { buildRenderData } from "./render-data.js"

/** 已注册的服务：name -> { factory, key } */
const services = new Map()
/** 原型上已安装 getter 的名字 */
const bound = new Set()
/** 每条消息的初始化钩子 */
const initHooks = new KeyedRegistry()
/** 渲染数据提供者 */
const renderDataProviders = new KeyedRegistry()

function logError(scope, err) {
  if (typeof globalThis.logger === "undefined") console.error(`[Runtime][${scope}]`, err)
  else globalThis.logger.error(`[Runtime][${scope}]`, err)
}

export default class Runtime {
  constructor(e) {
    this.e = e
    this._svc = new Map()

    this.handler = {
      has: Handler.has,
      call: Handler.call,
      callAll: Handler.callAll,
    }
  }

  get cfg() {
    return config
  }

  get common() {
    return common
  }

  get renderer() {
    return renderer
  }

  /** 兼容旧插件：历史上这个能力叫 puppeteer */
  get puppeteer() {
    return renderer
  }

  /**
   * 注册一个服务，之后可通过 e.runtime.<name> 访问
   *
   * 懒加载：实例首次访问时求值并缓存，之后同一实例复用。
   * @param name 服务名
   * @param factory 值，或 (runtime) => 值
   * @param key 去重键，默认与 name 相同
   * @param owner 归属插件，插件卸载时按它批量注销
   * @returns Disposer，调用即注销（只注销自己那一份）
   */
  static provide(name, factory, key = name, owner = key) {
    const old = services.get(name)
    if (old && old.key !== key) {
      logError("provide", `服务 ${name} 被 ${old.key} 与 ${key} 重复注册，后者生效`)
    }
    services.set(name, { factory, key, owner })
    if (!bound.has(name)) {
      bound.add(name)
      Object.defineProperty(Runtime.prototype, name, {
        configurable: true,
        get() {
          if (!services.has(name)) return undefined
          if (!this._svc.has(name)) {
            const { factory: fn } = services.get(name)
            this._svc.set(name, typeof fn === "function" ? fn(this) : fn)
          }
          return this._svc.get(name)
        },
      })
    }
    return () => Runtime.unprovide(name, key)
  }

  /**
   * 注销一个服务
   * @param name 服务名
   * @param key 只有当前登记的 key 与它相同时才注销；不传则无条件注销
   */
  static unprovide(name, key = null) {
    const record = services.get(name)
    if (key && record && record.key !== key) return false
    services.delete(name)
    bound.delete(name)
    delete Runtime.prototype[name]
    return true
  }

  /**
   * 按归属注销全部扩展点
   * 插件卸载时由加载器调用，热重载后不会残留旧的服务与渲染数据提供者
   * @returns 注销掉的条数
   */
  static forgetOwner(owner) {
    if (!owner) return 0
    let removed = 0
    for (const [name, record] of [...services]) {
      if (record.owner === owner) {
        Runtime.unprovide(name, record.key)
        removed++
      }
    }
    removed += initHooks.deleteByOwner(owner)
    removed += renderDataProviders.deleteByOwner(owner)
    return removed
  }

  /** 已注册的服务名，用于诊断 */
  static get serviceKeys() {
    return [...services.keys()]
  }

  /**
   * 注册每条消息的初始化钩子
   * @param fn (runtime) => void | Promise<void>
   * @param key 去重键
   * @param owner 归属插件
   * @returns Disposer
   */
  static onInit(fn, key = fn, owner = key) {
    initHooks.set(key, fn, 5000, owner)
    return () => Runtime.offInit(key)
  }

  static offInit(key) {
    return initHooks.delete(key)
  }

  /** 按归属摘除初始化钩子 */
  static offInitByOwner(owner) {
    return initHooks.deleteByOwner(owner)
  }

  /**
   * 注册渲染数据提供者
   * @param fn (ctx) => object，ctx = { runtime, e, plugin, segments, data, config }
   * @param key 去重键
   * @param owner 归属插件
   * @returns Disposer
   */
  static renderData(fn, key = fn, owner = key) {
    renderDataProviders.set(key, fn, 5000, owner)
    return () => Runtime.offRenderData(key)
  }

  static offRenderData(key) {
    return renderDataProviders.delete(key)
  }

  /** 按归属摘除渲染数据提供者 */
  static offRenderDataByOwner(owner) {
    return renderDataProviders.deleteByOwner(owner)
  }

  static async init(e) {
    let runtime = new Runtime(e)
    e.runtime = runtime
    for (const { key, value: fn } of initHooks.values()) {
      try {
        await fn(runtime)
      } catch (err) {
        logError(`onInit:${key}`, err)
      }
    }
    return runtime
  }

  /**
   *
   * @param plugin plugin key
   * @param path html文件路径，相对于plugin resources目录
   * @param data 渲染数据
   * @param cfg 渲染配置
   * @param cfg.retType 返回值类型
   * * default/空：自动发送图片，返回true
   * * msgId：自动发送图片，返回msg id
   * * base64: 不自动发送图像，返回图像base64数据
   * @param cfg.beforeRender({data}) 可改写渲染的data数据
   * @returns {Promise<boolean>}
   */
  async render(plugin, path, data = {}, cfg = {}) {
    // 处理传入的path
    path = path.replace(/.html$/, "")
    let paths = path.split("/").filter(p => !!p)
    path = paths.join("/")
    // 创建目录
    const mkdir = check => {
      let currDir = `${process.cwd()}/temp`
      for (let p of check.split("/")) {
        currDir = `${currDir}/${p}`
        if (!fs.existsSync(currDir)) {
          fs.mkdirSync(currDir)
        }
      }
      return currDir
    }
    mkdir(`html/${plugin}/${path}`)

    data = buildRenderData(
      { plugin, segments: paths, data, config, e: this.e, runtime: this },
      renderDataProviders.values(),
    )

    // 处理beforeRender
    if (cfg.beforeRender) {
      data = cfg.beforeRender({ data }) || data
    }
    // 保存模板数据
    if (process.argv.includes("dev")) {
      // debug下保存当前页面的渲染数据，方便模板编写与调试
      // 由于只用于调试，开发者只关注自己当时开发的文件即可，暂不考虑app及plugin的命名冲突
      let saveDir = mkdir(`ViewData/${plugin}`)
      let file = `${saveDir}/${data._htmlPath.split("/").join("_")}.json`
      fs.writeFileSync(file, JSON.stringify(data))
    }
    // 截图
    let base64 = await renderer.screenshot(`${plugin}/${path}`, data)
    if (cfg.retType === "base64") {
      return base64
    }
    let ret = true
    if (base64) {
      if (cfg.recallMsg) {
        ret = await this.e.reply(base64, false, {})
      } else {
        ret = await this.e.reply(base64)
      }
    }
    return cfg.retType === "msgId" ? ret : true
  }
}
