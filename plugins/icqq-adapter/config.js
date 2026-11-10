import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

/** 适配器自己的配置目录 */
export const DIR = path.join("plugins", "icqq-adapter", "config")
export const FILE = path.join(DIR, "config.yaml")
const DEF_FILE = path.join(DIR, "default.yaml")

const DEFAULTS = {
  // 是否启用 icqq 登录；关闭时内核照常启动，只加载插件
  enable: true,
  // 机器人账号
  qq: 0,
  // 登录密码，留空则扫码
  pwd: "",
  // 登录端口：1 安卓手机 / 2 aPad / 3 安卓手表 / 4 MacOS / 5 iPad / 6 Tim
  platform: 6,
  // 签名服务地址
  sign_api_addr: "",
  // 滑动验证 ticket 服务地址
  slider_ticket_addr: "https://HanXuan-GT.HF.Space/captcha/slider",
}

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) ?? {}
  } catch (err) {
    return {}
  }
}

function fromOldFiles() {
  const cfgDir = path.join("config", "config")
  const qq = readYaml(path.join(cfgDir, "qq.yaml"))
  const bot = readYaml(path.join(cfgDir, "bot.yaml"))
  const legacy = {}

  if (qq.qq) legacy.qq = Number(qq.qq)
  if (qq.pwd) legacy.pwd = String(qq.pwd)
  if (qq.platform) legacy.platform = Number(qq.platform)
  if (bot.sign_api_addr) legacy.sign_api_addr = String(bot.sign_api_addr)
  if (bot.slider_ticket_addr) legacy.slider_ticket_addr = String(bot.slider_ticket_addr)
  // 旧键 skip_login 反过来就是「是否启用登录」
  if (typeof bot.skip_login === "boolean") legacy.enable = !bot.skip_login

  return legacy
}

function ensure() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
  if (!fs.existsSync(DEF_FILE)) {
    fs.writeFileSync(DEF_FILE, YAML.stringify(DEFAULTS), "utf8")
  }
  if (!fs.existsSync(FILE)) {
    const merged = { ...DEFAULTS, ...fromOldFiles() }
    fs.writeFileSync(FILE, YAML.stringify(merged), "utf8")
  }
}

let cached = null

/** 读取配置；首次运行会生成，并从旧配置文件迁移 */
export function load({ reload = false } = {}) {
  if (cached && !reload) return cached
  ensure()
  cached = { ...DEFAULTS, ...readYaml(FILE) }
  return cached
}

/** 写回配置 */
export function save(patch = {}) {
  ensure()
  cached = { ...load(), ...patch }
  fs.writeFileSync(FILE, YAML.stringify(cached), "utf8")
  return cached
}

export default { DIR, FILE, load, save }
