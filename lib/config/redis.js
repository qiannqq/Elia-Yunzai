import cfg from "./config.js"
import common from "../common/common.js"
import { createClient } from "redis"
import { spawn } from "node:child_process"

/**
 * 初始化全局redis客户端
 */
export default async function redisInit() {
  const rc = cfg.redis
  const redisUn = rc.username || ""
  let redisPw = rc.password ? `:${rc.password}` : ""
  if (rc.username || rc.password) redisPw += "@"
  const redisUrl = `redis://${redisUn}${redisPw}${rc.host}:${rc.port}/${rc.db}`
  let client = createClient({ url: redisUrl })

  const cmd = [cfg.redis.path || 'redis-server', '--port', cfg.redis.port]
  try {
    logger.info(`正在连接 ${logger.blue(redisUrl)}`)
    await client.connect()
  } catch (err) {
    logger.error(`Redis 错误：${logger.red(err)}`)

    logger.info("正在启动 Redis...")
    await spwanRedis(cmd)
    await common.sleep(1000)

    try {
      client = createClient({ url: redisUrl })
      await client.connect()
    } catch (err) {
      logger.error(`Redis 错误：${logger.red(err)}`)
      logger.error(`请先启动 Redis`)
      process.exit()
    }
  }

  client.on("error", async err => {
    try {
      logger.error(`Redis 错误：${logger.red(err)}`)
      await spwanRedis(cmd)
      await common.sleep(1000)
      client = createClient({ url: redisUrl })
      await client.connect()
    } catch (error) {
      logger.error(`Redis 启动失败`, error)
      logger.error(`请先启动 Redis`)
      process.exit()
    }
  })

  /** 全局变量 redis */
  global.redis = client
  logger.info("Redis 连接成功")
  return client
}

async function aarch64() {
  if (process.platform == "win32") return ""
  /** 判断arch */
  const arch = await execSync("uname -m")
  if (arch.stdout && arch.stdout.includes("aarch64")) {
    /** 判断redis版本 */
    let v = await execSync("redis-server -v")
    if (v.stdout) {
      v = v.stdout.match(/v=(\d)./)
      /** 忽略arm警告 */
      if (v && v[1] >= 6) return " --ignore-warnings ARM64-COW-BUG"
    }
  }
  return ""
}

async function spwanRedis(cmd) {
  const redisProcess = spawn(cmd[0], cmd.slice(1))
  .on('error', (err) => {
    logger.error(`Redis 启动失败：${logger.red(err)}`)
    logger.error(`请先启动Redis`)
    process.exit()
  })
  .on('exit', (code) => { })
  redisProcess.stdout.on("data", data => {
    logger.info(String(data).trim())
  })
  redisProcess.stderr.on("data", data => {
    logger.error(String(data).trim())
  })
}

function execSync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      resolve({ error, stdout, stderr })
    })
  })
}
