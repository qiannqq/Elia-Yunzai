import { spawn } from "child_process"
import log4js from "log4js"
import http from "http"
import YAML from "yaml"
import fs from "fs"

/* keep ssh run */

log4js.configure({
  appenders: { console: { type: "console" } },
  categories: { default: { appenders: ["console"], level: "debug" } },
})
const logger = log4js.getLogger("app")
const restartApiPath = "/__elia_yunzai_restart_api__"
const restartApiReadyText = "ELIA_YUNZAI_KSR"

let serverProcess
let lifecycleAction = ""

const stopServer = async (action = "") => {
  if (!serverProcess) return

  lifecycleAction = action
  const currentProcess = serverProcess

  await new Promise(resolve => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }

    currentProcess.once("close", finish)

    if (currentProcess.exitCode != null || currentProcess.signalCode != null) {
      finish()
      return
    }

    if (!currentProcess.kill()) {
      finish()
    }
  })

  serverProcess = undefined
}

const startServer = async () => {
  logger.info("Starting Bot...")
  lifecycleAction = ""
  serverProcess = spawn(process.execPath, ["app.js"], { stdio: "inherit" })
  serverProcess.on("close", (code, signal) => {
    logger.info(`Bot process exited with code ${code}${signal ? ` signal ${signal}` : ""}`)
    if (lifecycleAction) return
    if (code == null) return
    process.exit(code)
  })
}
startServer()

const serverHttpexit = http.createServer(async (req, res) => {
  let remoteIP = req.socket.remoteAddress
  if (remoteIP.startsWith("::ffff:")) {
    remoteIP = remoteIP.slice(7)
  }
  if (remoteIP !== `::1` && remoteIP !== `127.0.0.1`) {
    console.log(remoteIP)
    res.writeHead(403, { "Content-Type": "text/plain" })
    res.end("Access Forbidden\n")
    return
  }
  if (req.url === restartApiPath) {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end(`${restartApiReadyText}\n`)
  } else if (req.url === `/restart`) {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("OK\n")
    try {
      await stopServer("restart")
      await startServer()
    } catch (error) {
      logger.error(error)
    }
  } else if (req.url === `/exit`) {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("OK\n")
    try {
      await stopServer("exit")
    } finally {
      process.exit()
    }
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("Not Found\n")
  }
})
let restart_port
try {
  restart_port = YAML.parse(fs.readFileSync(`./config/config/bot.yaml`, `utf-8`))
  restart_port = restart_port.restart_port || 27881
} catch {}

logger.info(`restart_api run on port ${restart_port || 27881}`)
serverHttpexit.listen(restart_port || 27881, () => {})
