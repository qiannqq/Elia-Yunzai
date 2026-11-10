import YAML from "yaml"
import fs from "node:fs"
import path from "node:path"
import chokidar from "chokidar"
import DEFAULTS from "./defaults.js"

const DEF_DIR = path.join("config", "default_config")
const CFG_DIR = path.join("config", "config")

/** 配置文件 */
class Cfg {
  constructor() {
    this.config = {}

    /** 监听文件 */
    this.watcher = { config: {}, defSet: {} }

    this.initCfg()
  }

  /** 初始化配置：目录、默认配置与用户配置都由内核自己补齐 */
  initCfg() {
    for (const dir of [DEF_DIR, CFG_DIR]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }
    for (const name of Object.keys(DEFAULTS)) this.ensureFile(name)
    for (const dir of ["plugins", "renderers", "data", "resources", "temp"]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }
  }

  /** 默认配置或用户配置缺失时，按内置默认值生成 */
  ensureFile(name) {
    const def = path.join(DEF_DIR, `${name}.yaml`)
    const cfg = path.join(CFG_DIR, `${name}.yaml`)
    if (!DEFAULTS[name]) return
    if (!fs.existsSync(def)) fs.writeFileSync(def, DEFAULTS[name], "utf8")
    if (!fs.existsSync(cfg)) fs.copyFileSync(def, cfg)
  }

  /** 机器人配置，具体键由适配器与插件解释 */
  get bot() {
    let bot = this.getConfig("bot")
    let defbot = this.getdefSet("bot")
    bot = { ...defbot, ...bot }

    if (!bot.ffmpeg_path) delete bot.ffmpeg_path
    if (!bot.ffprobe_path) delete bot.ffprobe_path

    return bot
  }

  get other() {
    return this.getConfig("other")
  }

  get redis() {
    return this.getConfig("redis")
  }

  get renderer() {
    return this.getConfig("renderer")
  }

  get notice() {
    return this.getConfig("notice")
  }

  get db() {
    return this.getConfig("db")
  }

  /** 主人qq */
  get masterQQ() {
    let masterQQ = this.getConfig("other").masterQQ || []

    if (Array.isArray(masterQQ)) {
      masterQQ.forEach(qq => {
        qq = String(qq)
      })
    } else {
      masterQQ = [String(masterQQ)]
    }
    return masterQQ
  }

  /** package.json，宿主没有提供时给一份空壳 */
  get package() {
    if (this._package) return this._package

    try {
      this._package = JSON.parse(fs.readFileSync("package.json", "utf8"))
    } catch (err) {
      this._package = { name: "elia-yunzai", version: "" }
    }
    return this._package
  }

  /** 群配置 */
  getGroup(groupId = "") {
    let config = this.getConfig("group")
    let defCfg = this.getdefSet("group")
    if (config[groupId]) {
      return { ...defCfg.default, ...config.default, ...config[groupId] }
    }
    return { ...defCfg.default, ...config.default }
  }

  /** other配置 */
  getOther() {
    let def = this.getdefSet("other")
    let config = this.getConfig("other")
    return { ...def, ...config }
  }

  /** notice配置 */
  getNotice() {
    let def = this.getdefSet("notice")
    let config = this.getConfig("notice")
    return { ...def, ...config }
  }

  /**
   * @param app  功能
   * @param name 配置文件名称
   */
  getdefSet(name) {
    return this.getYaml("default_config", name)
  }

  /** 用户配置 */
  getConfig(name) {
    return this.getYaml("config", name)
  }

  /**
   * 获取配置yaml
   * @param type 默认跑配置-defSet，用户配置-config
   * @param name 名称
   */
  getYaml(type, name) {
    const dir = type === "config" ? CFG_DIR : DEF_DIR
    const file = path.join(dir, `${name}.yaml`)
    const key = `${type}.${name}`
    if (this.config[key]) return this.config[key]

    if (!fs.existsSync(file)) this.ensureFile(name)

    if (fs.existsSync(file)) {
      this.config[key] = YAML.parse(fs.readFileSync(file, "utf8")) ?? {}
      this.watch(file, name, type)
    } else {
      this.config[key] = YAML.parse(DEFAULTS[name] ?? "") ?? {}
    }

    return this.config[key]
  }

  /** 监听配置文件 */
  watch(file, name, type = "default_config") {
    let key = `${type}.${name}`

    if (this.watcher[key]) return

    const watcher = chokidar.watch(file)
    watcher.on("change", path => {
      delete this.config[key]
      if (typeof Bot == "undefined") return
      logger.mark(`[修改配置文件][${type}][${name}]`)
      if (this[`change_${name}`]) {
        this[`change_${name}`]()
      }
    })

    this.watcher[key] = watcher
  }

  async change_bot() {
    /** 修改日志等级 */
    let log = await import("./log.js")
    log.default()
  }
}

export default new Cfg()
