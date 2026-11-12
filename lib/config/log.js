import fs from "node:fs"

/**
 * 设置日志样式
 *
 * log4js 与 chalk 在无 node_modules 时不可用，这里改为按需加载，
 * 加载失败则退回 console，保证内核仍能启动并输出信息。
 */
export default async function setLog() {
  let log4js
  let chalk
  let cfg
  try {
    log4js = (await import("log4js")).default
    chalk = (await import("chalk")).default
    cfg = (await import("./config.js")).default
  } catch {
    consoleFallback()
    return
  }

  let file = "./logs"
  if (!fs.existsSync(file)) {
    fs.mkdirSync(file)
  }

  /** 调整error日志等级 */
  // log4js.levels.levels[5].level = Number.MAX_VALUE
  // log4js.levels.levels.sort((a, b) => a.level - b.level)

  log4js.configure({
    appenders: {
      console: {
        type: "console",
        layout: {
          type: "pattern",
          pattern: "%[[EliaYz][%d{hh:mm:ss.SSS}][%4.4p]%] %m",
        },
      },
      command: {
        type: "dateFile", // 可以是console,dateFile,file,Logstash等
        filename: "logs/command", // 将会按照filename和pattern拼接文件名
        pattern: "yyyy-MM-dd.log",
        numBackups: 15,
        alwaysIncludePattern: true,
        layout: {
          type: "pattern",
          pattern: "[%d{hh:mm:ss.SSS}][%4.4p] %m",
        },
      },
      error: {
        type: "file",
        filename: "logs/error.log",
        alwaysIncludePattern: true,
        layout: {
          type: "pattern",
          pattern: "[%d{hh:mm:ss.SSS}][%4.4p] %m",
        },
      },
    },
    categories: {
      default: { appenders: ["console", 'command'], level: cfg.bot.log_level },
      command: { appenders: ["console", "command"], level: "warn" },
      error: { appenders: ["console", "command", "error"], level: "error" },
    },
  })

  const defaultLogger = log4js.getLogger("message")
  const commandLogger = log4js.getLogger("command")
  const errorLogger = log4js.getLogger("error")

  /* eslint-disable no-useless-call */
  /** 全局变量 logger */
  global.logger = {
    trace() {
      defaultLogger.trace.call(defaultLogger, ...arguments)
    },
    debug() {
      defaultLogger.debug.call(defaultLogger, ...arguments)
    },
    info() {
      defaultLogger.info.call(defaultLogger, ...arguments)
    },
    // warn及以上的日志采用error策略
    warn() {
      commandLogger.warn.call(defaultLogger, ...arguments)
    },
    error() {
      errorLogger.error.call(errorLogger, ...arguments)
    },
    fatal() {
      errorLogger.fatal.call(errorLogger, ...arguments)
    },
    mark() {
      errorLogger.mark.call(commandLogger, ...arguments)
    },
  }

  logColor(chalk)
}

/** 无 log4js 时的最小实现 */
function consoleFallback() {
  const write = (level, args) => {
    const time = new Date().toTimeString().slice(0, 8)
    console.log(`[EliaYz][${time}][${level}]`, ...args)
  }
  global.logger = {
    trace: (...args) => write("TRCE", args),
    debug: (...args) => write("DEBU", args),
    info: (...args) => write("INFO", args),
    warn: (...args) => write("WARN", args),
    error: (...args) => write("ERRO", args),
    fatal: (...args) => write("FATA", args),
    mark: (...args) => write("MARK", args),
  }
  logColor(null)
}

const ANSI = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36 }

/**
 * 给 logger 挂上颜色函数
 *
 * chalk 在时用同名方法（chalk 本体不是某个颜色，直接赋过去会得到不带样式的字符串）；
 * 没有 chalk 时退回 ANSI 转义，NO_COLOR 下退化为纯文本。
 */
export function logColor(chalk) {
  const plain = value => String(value)
  const paint = name => {
    const fn = chalk?.[name]
    if (typeof fn === "function") return fn
    const code = ANSI[name]
    return process.env.NO_COLOR ? plain : value => `\u001b[${code}m${value}\u001b[39m`
  }
  for (const name of Object.keys(ANSI)) logger[name] = paint(name)
  logger.chalk = chalk ?? Object.fromEntries(Object.keys(ANSI).map(name => [name, paint(name)]))
}
