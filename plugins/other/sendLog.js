import plugin from "../../lib/plugins/plugin.js"
import common from "../../lib/common/common.js"
import puppeteer from '../../lib/puppeteer/puppeteer.js'
import fs from "node:fs"
import lodash from "lodash"
import moment from "moment"

export class sendLog extends plugin {
  constructor() {
    super({
      name: "发送日志",
      dsc: "发送最近100条运行日志",
      event: "message",
      rule: [
        {
          reg: "^#(控制台)?(运行|错误)*日志[0-9]*(.*)",
          fnc: "sendLog",
          permission: "master",
        },
      ],
    })

    this.lineNum = 100
    this.maxNum = 1000

    this.logFile = `logs/command.${moment().format("YYYY-MM-DD")}.log`
    this.errFile = "logs/error.log"
    this.consoleHtml = 'resources/cmd.html'

    this.colorMap = {
      '30': 'color-black',
      '31': 'color-red',
      '32': 'color-green',
      '33': 'color-yellow',
      '34': 'color-blue',
      '35': 'color-magenta',
      '36': 'color-cyan',
      '37': 'color-white',
      '90': 'color-gray',
      '91': 'color-red',
      '92': 'color-green',
      '93': 'color-yellow',
      '94': 'color-blue',
      '95': 'color-magenta',
      '96': 'color-cyan',
      '97': 'color-white'
    };
    this.logLevelList = {
      'MARK': '90',
      'ERRO': '91',
      'WARN': '93',
      'INFO': '32',
      'DEBU': '94',
    }
  }

  async sendLog() {
    let lineNum = this.e.msg.match(/\d+/g)
    if (lineNum) {
      this.lineNum = lineNum[0]
    } else {
      this.keyWord = this.e.msg.replace(/#(控制台)?|运行|错误|日志|\d/g, "")
    }

    let logFile = this.logFile
    let type = "运行"
    if (this.e.msg.includes("错误")) {
      logFile = this.errFile
      type = "错误"
    }

    if (this.e.msg.includes("控制台")) return this.sendConsoleLog()

    if (this.keyWord) type = this.keyWord

    const log = this.getLog(logFile)

    if (lodash.isEmpty(log)) return this.reply(`暂无相关日志：${type}`)

    return this.reply(
      await common.makeForwardMsg(this.e, [log.join("\n")], `最近${log.length}条${type}日志`),
    )
  }
  async sendConsoleLog() {
    let type = this.e.msg.includes("错误") ? "错误" : "运行"
    let logFile = this.logFile
    if(type == '错误') logFile = this.errFile

    let logContent
    try {
      logContent = fs.readFileSync(logFile, 'utf-8')
    } catch (error) {
      return this.reply(`读取${type}日志失败：${error.message}`)
    }

    if(this.lineNum > this.maxNum) this.lineNum = this.maxNum

    logContent = logContent.split('\n')
    logContent = logContent.slice(-this.lineNum)

    logContent = logContent.map((item) => {
      let logLevel = item.match(/\[(.*?)\]\[(.*?)\]/);
      if (logLevel && this.logLevelList[logLevel[2]]) {
        let reg = new RegExp(`\\[(.*?)\\]\\[${logLevel[2]}\\]`);
        item = item.replace(reg, `\x1b[${this.logLevelList[logLevel[2]]}m[${logLevel[1]}][${logLevel[2]}]\x1b[39m`);
      }
      return this.parseAnsiColors(item);
    })

    try {
      let img = await puppeteer.screenshot('renderC', {
        imgType: "jpeg",
        quality: 100,
        tplFile: this.consoleHtml,
        data: logContent,
      })
      await this.e.reply(img)
    } catch (renderErr) {
      logger.error(`[渲染控制台] 渲染失败: ${renderErr.message}`)
      return e.reply(`渲染失败: ${renderErr.message}`), true
    }
  }

  parseAnsiColors(text) {
    if (!text) return '';
    for (let a in this.colorMap) {
      let reg = new RegExp(`\x1b\\[${a}m`, 'g')
      text = text.replace(reg, `<span class="${this.colorMap[a]}">`)
    }
    if (/\x1b\[38;\d;\d+;\d+;\d+m/.test(text)) {
      let rgb = text.match(/\x1b\[38;\d;(\d+);(\d+);(\d+)m/)
      text = text.replace(/\x1b\[38;\d;\d+;\d+;\d+m/, `<span style="color: rgb(${rgb[1]}, ${rgb[2]}, ${rgb[3]})">`)
    }
    return text.replace(/\x1b\[39m/g, '</span>')
  }

  getLog(logFile) {
    let log = fs.readFileSync(logFile, { encoding: "utf-8" })
    log = log.split("\n")

    if (this.keyWord) {
      for (const i in log) if (!log[i].includes(this.keyWord)) delete log[i]
    } else {
      log = lodash.slice(log, (Number(this.lineNum) + 1) * -1)
    }
    log = log.reverse()

    const tmp = []
    for (let i of log) {
      if (!i) continue
      if (this.keyWord && tmp.length >= this.maxNum) return
      /* eslint-disable no-control-regex */
      i = i.replace(/\x1b[[0-9;]*m/g, "")
      i = i.replace(/\r|\n/, "")
      tmp.push(i)
    }
    return tmp
  }
}
