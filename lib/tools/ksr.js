import { spawn } from "child_process"
import log4js from "log4js"
import http from "http"
import crypto from "crypto"
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

/**
 * 每次 ksr 启动时随机生成的重启令牌，仅存在于内存中，不落盘、不写入配置文件。
 * 通过环境变量传递给由 ksr 亲自拉起的 Bot 子进程，只有持有该令牌的进程才能
 * 通过 /restart、/exit 接口操作 Bot。外部后门即便 curl 本地端口，因无法对
 * 一次性 nonce 给出正确的 HMAC 签名，也无法重启或关停 Bot。
 */
const restartToken = crypto.randomBytes(32).toString("hex")
const challengeTtl = 10000
const challengeStore = new Map()

const pruneChallenges = () => {
  const now = Date.now()
  for (const [nonce, expireAt] of challengeStore) {
    if (expireAt <= now) challengeStore.delete(nonce)
  }
}

const issueChallenge = () => {
  pruneChallenges()
  // 防止异常情况下 nonce 无限堆积
  if (challengeStore.size > 1000) challengeStore.clear()
  const nonce = crypto.randomBytes(16).toString("hex")
  challengeStore.set(nonce, Date.now() + challengeTtl)
  return nonce
}

const verifyChallenge = searchParams => {
  const nonce = searchParams.get("nonce")
  const sign = searchParams.get("sign")
  if (!nonce || !sign) return false

  const expireAt = challengeStore.get(nonce)
  // nonce 一次性使用，无论成功与否立即作废
  challengeStore.delete(nonce)
  if (!expireAt || expireAt <= Date.now()) return false

  const expected = crypto.createHmac("sha256", restartToken).update(nonce).digest("hex")
  let signBuf
  let expectedBuf
  try {
    signBuf = Buffer.from(sign, "hex")
    expectedBuf = Buffer.from(expected, "hex")
  } catch {
    return false
  }
  if (signBuf.length !== expectedBuf.length) return false
  return crypto.timingSafeEqual(signBuf, expectedBuf)
}

let serverProcess
let lifecycleAction = ""
let requestInProgress = ""

const waitForProcessClose = async currentProcess => {
  await new Promise((resolve, reject) => {
    let settled = false
    let forceKillTimer

    const finish = error => {
      if (settled) return
      settled = true
      clearTimeout(forceKillTimer)
      if (error) reject(error)
      else resolve()
    }

    currentProcess.once("close", () => finish())
    currentProcess.once("error", error => finish(error))

    if (currentProcess.exitCode != null || currentProcess.signalCode != null) {
      finish()
      return
    }

    logger.info("Stopping Bot child process...")
    if (!currentProcess.kill()) {
      finish()
      return
    }

    forceKillTimer = setTimeout(() => {
      if (currentProcess.exitCode != null || currentProcess.signalCode != null) return
      logger.warn("Bot child process did not exit after SIGTERM, sending SIGKILL")
      try {
        currentProcess.kill("SIGKILL")
      } catch (error) {
        finish(error)
      }
    }, 5000)
  })
}

const stopServer = async (action = "") => {
  if (!serverProcess) return

  lifecycleAction = action
  const currentProcess = serverProcess

  await waitForProcessClose(currentProcess)

  serverProcess = undefined
}

const startServer = async () => {
  logger.info("Starting Bot...")
  lifecycleAction = ""
  serverProcess = spawn(process.execPath, ["app.js"], {
    stdio: "inherit",
    env: { ...process.env, KSR_RESTART_TOKEN: restartToken },
  })
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
  const requestUrl = new URL(req.url, "http://localhost")
  const pathname = requestUrl.pathname

  if (pathname === restartApiPath) {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end(`${restartApiReadyText}\n`)
  } else if (pathname === `/challenge`) {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end(`${issueChallenge()}\n`)
  } else if (pathname === `/restart`) {
    if (!verifyChallenge(requestUrl.searchParams)) {
      logger.warn("Rejected unauthenticated ksr restart request")
      res.writeHead(403, { "Content-Type": "text/plain" })
      res.end("Forbidden\n")
      return
    }

    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("OK\n")

    if (requestInProgress === "restart") {
      logger.info("Ignoring duplicate ksr restart request")
      return
    }

    requestInProgress = "restart"
    try {
      logger.info("Received ksr restart request")
      await stopServer("restart")
      await startServer()
    } catch (error) {
      logger.error(error)
    } finally {
      requestInProgress = ""
    }
  } else if (pathname === `/exit`) {
    if (!verifyChallenge(requestUrl.searchParams)) {
      logger.warn("Rejected unauthenticated ksr exit request")
      res.writeHead(403, { "Content-Type": "text/plain" })
      res.end("Forbidden\n")
      return
    }

    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("OK\n")

    if (requestInProgress === "exit") {
      logger.info("Ignoring duplicate ksr exit request")
      return
    }

    requestInProgress = "exit"
    try {
      logger.info("Received ksr exit request")
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
