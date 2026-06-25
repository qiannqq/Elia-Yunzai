import plugin from '../../lib/plugins/plugin.js'
import { createRequire } from 'module'
import fetch from 'node-fetch'
import crypto from 'node:crypto'
import fs from 'fs'
import YAML from 'yaml'
import common from '../../lib/common/common.js'

const require = createRequire(import.meta.url)
const { exec, spawn } = require('child_process')

const restartApiPath = '/__elia_yunzai_restart_api__'
const restartApiReadyText = 'ELIA_YUNZAI_KSR'

/**
 * 由 ksr 拉起 Bot 时通过环境变量注入的重启令牌。
 * 只有持有该令牌的框架进程才能向 ksr 发起重启/关机，外部后门无法伪造。
 */
const ksrRestartToken = process.env.KSR_RESTART_TOKEN

const hasKsrRestartApi = async (port) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1000)

  try {
    const response = await fetch(`http://localhost:${port}${restartApiPath}`, { signal: controller.signal })
    const result = (await response.text()).trim()
    return response.ok && result === restartApiReadyText
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 向 ksr 申请一次性 nonce，并用重启令牌计算 HMAC 签名，拼出带签名的操作地址。
 * 令牌缺失或取不到 nonce 时直接抛错，避免在未授权情况下误触发重启/关机。
 */
const buildKsrActionUrl = async (port, action) => {
  if (!ksrRestartToken) {
    throw new Error('缺少 ksr 重启令牌，当前进程可能不是由 ksr 启动，已阻止该操作')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)

  try {
    const response = await fetch(`http://localhost:${port}/challenge`, { signal: controller.signal })
    if (!response.ok) throw new Error(`获取 ksr 校验失败：HTTP ${response.status}`)

    const nonce = (await response.text()).trim()
    if (!nonce) throw new Error('获取 ksr 校验失败：空 nonce')

    const sign = crypto.createHmac('sha256', ksrRestartToken).update(nonce).digest('hex')
    return `http://localhost:${port}/${action}?nonce=${nonce}&sign=${sign}`
  } finally {
    clearTimeout(timer)
  }
}

export class Restart extends plugin {
  constructor(e = '') {
    super({
      name: '重启',
      dsc: '#重启',
      event: 'message',
      priority: 10,
      rule: [{
        reg: '^#重启$',
        fnc: 'restart',
        permission: 'master'
      }, {
        reg: '^#(停机|关机)$',
        fnc: 'stop',
        permission: 'master'
      }]
    })

    if (e) this.e = e

    this.key = 'Yz:restart'
    this.lockKey = 'Yz:restart:lock'
  }

  runPm2Action(action) {
    const localPm2 = `${process.cwd()}/node_modules/pm2/bin/pm2`
    const hasLocalPm2 = fs.existsSync(localPm2)
    const command = hasLocalPm2 ? process.execPath : (process.platform === 'win32' ? 'pm2.cmd' : 'pm2')
    const args = hasLocalPm2 ? [localPm2, action, './config/pm2/pm2.json'] : [action, './config/pm2/pm2.json']

    const child = spawn(command, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore'
    })

    child.unref()
  }

  async clearActionLock() {
    await redis.del(this.lockKey)
  }

  async acquireActionLock(action) {
    const result = await redis.set(this.lockKey, action, { EX: 30, NX: true })
    if (result) return true

    logger.mark(`${this.e.logFnc} ${action}任务执行中，忽略重复请求`)
    await this.e.reply(`${action}任务执行中，请勿重复操作`)
    return false
  }

  async init() {
    await this.clearActionLock()

    let restart = await redis.get(this.key)
    if (restart) {
      restart = JSON.parse(restart)
      const uin = restart?.uin || Bot.uin
      let time = restart.time || new Date().getTime()
      time = (new Date().getTime() - time) / 1000

      let msg = `重启成功：耗时${time.toFixed(2)}秒`
      try {
        /** 等待Bot初始化，超出60秒则放弃回复 */
        for (let i = 0; i < 60; i++) {
          if (restart.isGroup) {
            if (Bot[uin]?.pickGroup(restart.id)) {
              Bot[uin].pickGroup(restart.id).sendMsg(msg)
              break
            }
          } else {
            if (Bot[uin]?.pickUser(restart.id)) {
              Bot[uin].pickUser(restart.id).sendMsg(msg)
              break
            }
          }
          await common.sleep(1000)
        }
      } catch (error) {
        /** 不发了，发不出去... */
        logger.debug(error)
      }
      redis.del(this.key)
    }
  }

  async restart() {
    let restart_port
    try {
      restart_port = YAML.parse(fs.readFileSync(`./config/config/bot.yaml`, `utf-8`))
      restart_port = restart_port.restart_port || 27881
    } catch { }

    if (!await this.acquireActionLock('重启')) return false

    await this.e.reply('开始执行重启，请稍等...')
    logger.mark(`${this.e.logFnc} 开始执行重启，请稍等...`)

    let data = JSON.stringify({
      uin: this.e?.self_id || this.e.bot.uin,
      isGroup: !!this.e.isGroup,
      id: this.e.isGroup ? this.e.group_id : this.e.user_id,
      time: new Date().getTime()
    })

    let npm = await this.checkPnpm()
    await redis.set(this.key, data, { EX: 120 })
    if (await hasKsrRestartApi(restart_port || 27881)) {
      try {
        logger.mark('检测到 ksr 重启接口，使用本地 HTTP 重启')
        const url = await buildKsrActionUrl(restart_port || 27881, 'restart')
        let result = await fetch(url)
        result = (await result.text()).trim()
        if (result !== `OK`) {
          redis.del(this.key)
          await this.clearActionLock()
          this.e.reply(`操作失败！`)
          logger.error(`重启失败`)
        }
      } catch (error) {
        redis.del(this.key)
        await this.clearActionLock()
        this.e.reply(`操作失败！\n${error}`)
      }
    } else {
      try {
        if (process.argv[1].includes('pm2')) {
          logger.mark('检测到 PM2 运行环境，使用独立进程执行 PM2 重启')
          this.runPm2Action('restart')
          return true
        }

        let cm = `${npm} start`

        exec(cm, { windowsHide: true }, (error, stdout, stderr) => {
          if (error) {
            redis.del(this.key)
            this.clearActionLock()
            this.e.reply(`操作失败！\n${error.stack}`)
            logger.error(`重启失败\n${error.stack}`)
          } else {
            logger.mark('重启成功，运行已由前台转为后台')
            logger.mark(`查看日志请用命令：${npm} run log`)
            logger.mark(`停止后台运行命令：${npm} stop`)
            process.exit()
          }
        })
      } catch (error) {
        redis.del(this.key)
        await this.clearActionLock()
        let e = error.stack ?? error
        this.e.reply(`操作失败！\n${e}`)
      }
    }

    return true
  }

  async checkPnpm() {
    let npm = 'npm'
    let ret = await this.execSync('pnpm -v')
    if (ret.stdout) npm = 'pnpm'
    return npm
  }

  async execSync(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true }, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr })
      })
    })
  }

  async stop() {
    let restart_port
    try {
      restart_port = YAML.parse(fs.readFileSync(`./config/config/bot.yaml`, `utf-8`))
      restart_port = restart_port.restart_port || 27881
    } catch { }

    if (!await this.acquireActionLock('关机')) return false

    if (await hasKsrRestartApi(restart_port || 27881)) {
      try {
        logger.mark('检测到 ksr 退出接口，使用本地 HTTP 关机')
        // 先完成令牌校验与签名，确认有权关机后再回复，避免误报关机成功
        const url = await buildKsrActionUrl(restart_port || 27881, 'exit')
        logger.mark('关机成功，已停止运行')
        await this.e.reply(`关机成功，已停止运行`)
        await fetch(url)
        return
      } catch (error) {
        await this.clearActionLock()
        this.e.reply(`操作失败！\n${error}`)
        logger.error(`关机失败\n${error}`)
        return
      }
    }

    if (!process.argv[1].includes('pm2')) {
      logger.mark('关机成功，已停止运行')
      await this.e.reply('关机成功，已停止运行')
      process.exit()
    }

    logger.mark('关机成功，已停止运行')
    await this.e.reply('关机成功，已停止运行')

    logger.mark('检测到 PM2 运行环境，使用独立进程执行 PM2 关机')
    this.runPm2Action('stop')

    return true
  }
}
