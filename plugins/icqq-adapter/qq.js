import fs from "node:fs"
import path from "node:path"
import inquirer from "inquirer"
import YAML from "yaml"
import chalk from "chalk"
import cfg from "../../lib/config/config.js"
import common from "../../lib/common/common.js"
import { load, save } from "./config.js"

/**
 * 首次运行时收集账号信息，写入适配器自己的配置目录
 * Git Bash 运行 npm 命令会无法选择列表
 */
export default async function createQQ() {
  const conf = load()

  /** 未启用登录，且不是显式要求重新配置 */
  if (!conf.enable && !process.argv.includes("login")) return

  /** 已经配置过，且不是显式要求重新登录 */
  if (conf.qq && !process.argv.includes("login")) return

  /** 非交互环境不阻塞启动，配置留手填 */
  if (!process.stdin.isTTY) {
    ;(globalThis.logger ?? console).warn(
      "[icqq-adapter] 未配置账号，本次跳过登录；可在 plugins/icqq-adapter/config/config.yaml 中填写",
    )
    return
  }

  console.log(
    `欢迎使用${chalk.green("Elia-Yunzai v" + cfg.package.version)}\n请按提示完成 QQ 配置，配置保存在 plugins/icqq-adapter/config/config.yaml`,
  )

  const promptList = [
    {
      type: "Input",
      message: "请输入机器人QQ号(建议用小号)：",
      name: "qq",
      validate(value) {
        if (/^[1-9][0-9]{4,14}$/.test(value)) return true
        return "请输入正确的QQ号"
      },
    },
    {
      type: process.platform == "win32" ? "Input" : "password",
      message: "请输入登录密码(为空则扫码登录)：",
      name: "pwd",
    },
    {
      type: "list",
      message: "请选择登录端口：",
      name: "platform",
      default: "Tim",
      choices: ["Tim", "iPad", "安卓手机", "安卓手表", "MacOS", "aPad"],
      filter(val) {
        switch (val) {
          case "iPad":
            return 5
          case "MacOS":
            return 4
          case "安卓手机":
            return 1
          case "安卓手表":
            return 3
          case "aPad":
            return 2
          default:
            return 6
        }
      },
    },
  ]

  if (!process.argv.includes("login")) {
    promptList.push({
      type: "Input",
      message: "请输入主人QQ号：",
      name: "masterQQ",
    })
  }

  promptList.push({
    type: "input",
    message: "请输入签名API地址（可留空）：",
    name: "signAPI",
  })

  const ret = await inquirer.prompt(promptList)

  save({
    enable: true,
    qq: Number(ret.qq),
    pwd: ret.pwd ?? "",
    platform: Number(ret.platform),
    sign_api_addr: ret.signAPI || conf.sign_api_addr || "",
  })

  /** 主人写进内核的 other.yaml，其他插件会读 */
  if (ret.masterQQ) {
    const file = path.join("config", "config", "other.yaml")
    const other = fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, "utf8")) ?? {} : {}
    other.masterQQ = [Number(ret.masterQQ)]
    fs.writeFileSync(file, YAML.stringify(other), "utf8")
  }

  console.log(
    `\nQQ配置完成，正在登录\n后续修改账号可以运行命令： ${chalk.green("node app login")}\n`,
  )

  await common.sleep(2000)
}
