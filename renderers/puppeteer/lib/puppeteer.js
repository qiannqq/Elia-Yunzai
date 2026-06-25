import Renderer from "../../../lib/renderer/Renderer.js"
import os from "node:os"
import childProcess from "node:child_process"
import lodash from "lodash"
import puppeteer from "puppeteer"
import timers from "node:timers/promises"
import fs from "node:fs/promises"
// 暂时保留对原config的兼容
import cfg from "../../../lib/config/config.js"

const _path = process.cwd()
// mac地址
let mac = ""

export default class Puppeteer extends Renderer {
  constructor(config) {
    super({
      id: "puppeteer",
      type: "image",
      render: "screenshot",
    })
    this.browser = false
    this.lock = false
    /** 正在主动关闭浏览器，用于抑制 disconnected 触发的重启 */
    this.closing = false
    this.shoting = []
    /** 截图数达到时重启浏览器 避免生成速度越来越慢 */
    this.restartNum = config.restartNum || 100
    /** 截图次数 */
    this.renderNum = 0
    /** 空闲多久(ms)后自动关闭浏览器释放资源，0 为不关闭 */
    this.idleTimeout = config.idleTimeout ?? cfg?.bot?.puppeteer_idle ?? 1800000
    /** 空闲定时器 */
    this.idleTimer = null
    /** 关闭浏览器的超时时间(ms)，超时则强制结束进程 */
    this.closeTimeout = config.closeTimeout || 8000
    this.config = {
      userDataDir: config.userDataDir || "data/puppeteer",
      headless: config.headless || "new",
      args: config.args || [
        "--disable-gpu",
        "--disable-setuid-sandbox",
        "--no-sandbox",
        "--no-zygote",
      ],
    }
    if (config.chromiumPath || cfg?.bot?.chromium_path)
      /** chromium其他路径 */
      this.config.executablePath = config.chromiumPath || cfg?.bot?.chromium_path
    if (config.puppeteerWS || cfg?.bot?.puppeteer_ws)
      /** chromium其他路径 */
      this.config.wsEndpoint = config.puppeteerWS || cfg?.bot?.puppeteer_ws
    /** puppeteer超时超时时间 */
    this.puppeteerTimeout = config.puppeteerTimeout || cfg?.bot?.puppeteer_timeout || 0
    this.pageGotoParams = config.pageGotoParams || {
      timeout: 120000,
      waitUntil: "networkidle2",
    }
  }

  /**
   * 初始化chromium
   */
  async browserInit() {
    if (this.browser) return this.browser
    if (this.lock) return false
    this.lock = true

    logger.info("puppeteer Chromium 启动中...")

    let connectFlag = false
    try {
      // 获取Mac地址
      if (!mac) {
        mac = await this.getMac()
        this.browserMacKey = `Yz:chromium:browserWSEndpoint:${mac}`
      }
      // 是否有browser实例
      const browserUrl = (await redis.get(this.browserMacKey)) || this.config.wsEndpoint
      if (browserUrl) {
        let conn
        try {
          conn = await puppeteer.connect({ browserWSEndpoint: browserUrl })
          // 校验实例可用，避免连接到僵死的孤儿进程
          await Promise.race([
            conn.version(),
            timers.setTimeout(5000).then(() => Promise.reject(new Error("连接验证超时"))),
          ])
          this.browser = conn
          connectFlag = true
          logger.info(`puppeteer Chromium 连接成功 ${browserUrl}`)
        } catch (err) {
          logger.warn(`puppeteer Chromium 复用实例不可用，丢弃缓存：${err.message || err}`)
          // 断开无效连接，避免残留句柄
          try {
            await conn?.disconnect?.()
          } catch {}
          await redis.del(this.browserMacKey)
        }
      }
    } catch {}

    if (!this.browser || !connectFlag) {
      // 如果没有实例，初始化puppeteer
      this.browser = await puppeteer.launch(this.config).catch(async (err, trace) => {
        const errMsg = err.toString() + (trace ? trace.toString() : "")
        logger.error(err, trace)
        if (errMsg.includes("Could not find Chromium")) {
          logger.error(
            "没有正确安装 Chromium，可以尝试执行安装命令：node node_modules/puppeteer/install.js",
          )
        } else if (errMsg.includes("cannot open shared object file")) {
          logger.error("没有正确安装 Chromium 运行库")
        } else if (errMsg.includes(this.config.userDataDir)) {
          await fs.rm(this.config.userDataDir, { force: true, recursive: true }).catch(() => {})
          return (this.lock = false)
        }
      })
      if (this.lock === false) return this.browserInit()
    }

    this.lock = false
    if (!this.browser) {
      logger.error("puppeteer Chromium 启动失败")
      return false
    }
    /** 记录主进程 PID，关闭异常时用于强制结束进程树 */
    this.browserPid = this.browser.process()?.pid
    if (!connectFlag) {
      logger.info(`puppeteer Chromium 启动成功 ${this.browser.wsEndpoint()}`)
      if (this.browserMacKey) {
        // 缓存一下实例30天
        const expireTime = 60 * 60 * 24 * 30
        await redis.set(this.browserMacKey, this.browser.wsEndpoint(), { EX: expireTime })
      }
    }

    /** 监听Chromium实例是否断开 */
    this.browser.on("disconnected", () => this.onDisconnected())

    return this.browser
  }

  /** 浏览器意外断开处理，主动关闭时不做任何动作 */
  onDisconnected() {
    if (this.closing) return
    logger.warn("puppeteer Chromium 连接已断开，将在下次渲染时重新启动")
    this.browser = false
    this.lock = false
    this.clearIdleTimer()
  }

  // 获取Mac地址
  getMac() {
    let mac = "00:00:00:00:00:00"
    try {
      const network = os.networkInterfaces()
      let macFlag = false
      for (const a in network) {
        for (const i of network[a]) {
          if (i.mac && i.mac !== mac) {
            macFlag = true
            mac = i.mac
            break
          }
        }
        if (macFlag) {
          break
        }
      }
    } catch (e) {}
    mac = mac.replace(/:/g, "")
    return mac
  }

  /**
   * `chromium` 截图
   * @param name
   * @param data 模板参数
   * @param data.tplFile 模板路径，必传
   * @param data.saveId  生成html名称，为空name代替
   * @param data.imgType  screenshot参数，生成图片类型：jpeg，png
   * @param data.quality  screenshot参数，图片质量 0-100，jpeg是可传，默认90
   * @param data.omitBackground  screenshot参数，隐藏默认的白色背景，背景透明。默认不透明
   * @param data.path   screenshot参数，截图保存路径。截图图片类型将从文件扩展名推断出来。如果是相对路径，则从当前路径解析。如果没有指定路径，图片将不会保存到硬盘。
   * @param data.multiPage 是否分页截图，默认false
   * @param data.multiPageHeight 分页状态下页面高度，默认4000
   * @param data.pageGotoParams 页面goto时的参数
   * @return img 不做segment包裹
   */
  async screenshot(name, data = {}) {
    /** 进入渲染先停掉空闲定时器，避免渲染途中被关闭 */
    this.clearIdleTimer()
    if (!(await this.browserInit())) return false
    const pageHeight = data.multiPageHeight || 4000

    const savePath = this.dealTpl(name, data)
    if (!savePath) return false

    let buff = ""
    const start = Date.now()

    let ret = []
    this.shoting.push(name)

    const puppeteerTimeout = this.puppeteerTimeout
    let overtime
    if (puppeteerTimeout > 0) {
      // TODO 截图超时处理
      overtime = setTimeout(() => {
        if (this.shoting.length) {
          logger.error(`[图片生成][${name}] 截图超时，当前等待队列：${this.shoting.join(",")}`)
          this.restart(true)
          this.shoting = []
        }
      }, puppeteerTimeout)
    }

    let page
    try {
      page = await this.browser.newPage()
      const pageGotoParams = lodash.extend(this.pageGotoParams, data.pageGotoParams || {})
      await page.goto(`file://${_path}${lodash.trim(savePath, ".")}`, pageGotoParams)
      const body = (await page.$("#container")) || (await page.$("body"))

      // 计算页面高度
      const boundingBox = await body.boundingBox()
      // 分页数
      let num = 1

      const randData = {
        type: data.imgType || "jpeg",
        omitBackground: data.omitBackground || false,
        quality: data.quality || 90,
        path: data.path || "",
      }

      if (data.multiPage) {
        randData.type = "jpeg"
        num = Math.round(boundingBox.height / pageHeight) || 1
      }

      if (data.imgType === "png") delete randData.quality

      if (!data.multiPage) {
        buff = await body.screenshot(randData)
        if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

        this.renderNum++
        /** 计算图片大小 */
        const kb = (buff.length / 1024).toFixed(2) + "KB"
        logger.mark(
          `[图片生成][${name}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`,
        )
        ret.push(buff)
      } else {
        // 分片截图
        if (num > 1) {
          await page.setViewport({
            width: boundingBox.width,
            height: pageHeight + 100,
          })
        }
        for (let i = 1; i <= num; i++) {
          if (i !== 1 && i === num)
            await page.setViewport({
              width: boundingBox.width,
              height: parseInt(boundingBox.height) - pageHeight * (num - 1),
            })

          if (i !== 1 && i <= num)
            await page.evaluate(pageHeight => window.scrollBy(0, pageHeight), pageHeight)

          if (num === 1) buff = await body.screenshot(randData)
          else buff = await page.screenshot(randData)
          if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

          if (num > 2) await timers.setTimeout(200)

          this.renderNum++

          /** 计算图片大小 */
          const kb = (buff.length / 1024).toFixed(2) + "KB"
          logger.mark(`[图片生成][${name}][${i}/${num}] ${kb}`)
          ret.push(buff)
        }
        if (num > 1) {
          logger.mark(`[图片生成][${name}] 处理完成`)
        }
      }
    } catch (err) {
      logger.error(`[图片生成][${name}] 图片生成失败`, err)
      /** 关闭浏览器 */
      this.restart(true)
      if (overtime) clearTimeout(overtime)
      ret = []
      return false
    } finally {
      /** 无论成功失败都关闭页面，避免页面句柄泄漏 */
      if (page) page.close().catch(err => logger.error(err))
      if (overtime) clearTimeout(overtime)
    }

    this.shoting.pop()

    if (ret.length === 0 || !ret[0]) {
      logger.error(`[图片生成][${name}] 图片生成为空`)
      return false
    }

    this.restart()
    /** 渲染完成后启动空闲定时器 */
    this.resetIdleTimer()
    return data.multiPage ? ret : ret[0]
  }

  /** 重启 */
  restart(force = false) {
    /** 截图超过重启数时，自动关闭重启浏览器，避免生成速度越来越慢 */
    if (!this.browser?.close || this.lock) return
    if (!force) if (this.renderNum % this.restartNum !== 0 || this.shoting.length > 0) return
    logger.info(`puppeteer Chromium ${force ? "强制" : ""}关闭重启...`)
    const browser = this.browser
    this.browser = false
    this.closing = true
    /** 关闭旧实例（带超时强杀），不阻塞新实例启动 */
    this.stop(browser).finally(() => {
      this.closing = false
    })
    return this.browserInit()
  }

  /** 空闲定时器：长时间无渲染时关闭浏览器释放资源 */
  resetIdleTimer() {
    this.clearIdleTimer()
    if (!(this.idleTimeout > 0)) return
    this.idleTimer = setTimeout(() => {
      if (this.shoting.length > 0 || !this.browser) return
      logger.info(`puppeteer Chromium 空闲超过 ${this.idleTimeout / 1000}s，自动关闭释放资源`)
      this.closeBrowser()
    }, this.idleTimeout)
    /** 不阻止进程退出 */
    this.idleTimer.unref?.()
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /** 主动关闭浏览器且不重启，下次渲染时按需重新启动 */
  async closeBrowser() {
    if (!this.browser) return
    this.clearIdleTimer()
    const browser = this.browser
    const pid = this.browserPid
    this.browser = false
    this.closing = true
    try {
      await this.stop(browser, pid)
      // 已主动销毁，清掉缓存的 WS 端点，避免下次连到死实例
      if (this.browserMacKey) await redis.del(this.browserMacKey).catch(() => {})
    } finally {
      this.closing = false
    }
  }

  /**
   * 关闭浏览器实例，close 超时则按 PID 强制结束进程树，杜绝孤儿/僵尸进程
   * @param browser 浏览器实例
   * @param pid 浏览器主进程 PID，缺省时取 browser.process()
   */
  async stop(browser, pid) {
    if (!browser) return
    pid = pid ?? browser.process()?.pid
    try {
      await Promise.race([
        browser.close(),
        timers.setTimeout(this.closeTimeout).then(() => Promise.reject(new Error("close 超时"))),
      ])
    } catch (err) {
      logger.error(`puppeteer Chromium 正常关闭失败，尝试强制结束进程(${pid})`, err)
      this.killProcess(pid)
    }
  }

  /** 按 PID 强杀进程树（含子渲染进程） */
  killProcess(pid) {
    if (!pid) return
    try {
      if (process.platform === "win32") {
        childProcess.execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" })
      } else {
        process.kill(pid, "SIGKILL")
      }
      logger.mark(`puppeteer Chromium 进程 ${pid} 已强制结束`)
    } catch (err) {
      // 进程可能已退出，忽略
      logger.debug(`puppeteer Chromium 进程 ${pid} 结束失败（可能已退出）：${err.message || err}`)
    }
  }
}
