import setLog from "./log.js"
import redisInit from "./redis.js"
import { checkRun } from "./check.js"
import fs from "node:fs"

async function UpdateTitle() {
  /** 设置标题 */
  process.title = 'Elia-Yunzai 伊莉雅'
}

/** 设置时区 */
process.env.TZ = "Asia/Shanghai"

process.on("SIGHUP", () => process.exit())

/** 捕获未处理的错误 */
process.on("uncaughtException", error => {
  if (typeof logger == "undefined") console.log(error)
  else logger.error(error)
})

/** 捕获未处理的Promise错误 */
process.on("unhandledRejection", (error, promise) => {
  if (typeof logger == "undefined") console.log(error)
  else logger.error(error)
})

/** 退出事件 */
process.on("exit", async code => {
  if (typeof redis != "undefined" && typeof test == "undefined") await redis.save()

  if (typeof logger == "undefined") console.log("Elia-Yunzai 已停止运行")
  else logger.mark(logger.magenta("Elia-Yunzai 已停止运行"))
})

await checkInit()

/** 初始化事件 */
async function checkInit() {
  /** 日志设置 */
  await setLog()

  logger.mark("Elia-Yunzai 启动中...")

  /** 依赖缺失只提示，不阻断启动；此时可能没有 log4js，直接用 console */
  if (!fs.existsSync("./node_modules")) {
    console.log("[EliaYz] 没有找到 node_modules，插件与渲染后端可能无法加载")
  }

  await redisInit()

  await checkRun()

  //** 更新标题 */
  await UpdateTitle()
}
