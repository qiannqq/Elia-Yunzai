/**
 * 定时任务调度
 *
 * 与 Yunzai-NG 的 scheduler 同一套语义：
 * - cron 与 interval 共用一个 runner，所以 overlap / timeout / immediate 的行为不随类型变化
 * - overlap: "skip"（默认，上一轮没跑完就跳过）| "queue"（排队，最多积压 3 轮）
 * - timeout: 到点先中止传进去的 signal，宽限一小段时间后不再等待
 * - 注册即 unref，只剩定时任务的进程能正常退出
 *
 * 内核自己的旧式 task（{ name, cron, fnc }）也走这里，避免两套调度逻辑各管一段。
 */
import { createRequire } from "node:module"
import { parseDuration } from "./util/duration.js"

/**
 * cron 解析器按需加载
 * 这样 lib/scheduler.js 可以在没有 node_modules 的环境里被 import（自测、静态检查），
 * 只有真正登记 cron 任务时才需要 node-schedule。
 */
let scheduleModule = null
function getSchedule() {
  if (!scheduleModule) {
    try {
      scheduleModule = createRequire(import.meta.url)("node-schedule")
    } catch (err) {
      throw new Error("登记 cron 任务需要 node-schedule，请先安装依赖")
    }
  }
  return scheduleModule
}

export const MAX_QUEUE = 3
export const ABORT_GRACE = 200
export const MIN_INTERVAL = 1000

const TIMEOUT = Symbol("task.timeout")

function resolveLogger(logger) {
  if (logger) return logger
  return globalThis.logger
}

/**
 * 造一个任务执行器，不依赖真实时钟，便于单测直接 tick()
 * @param options.name 任务名，用于日志
 * @param options.fn (signal) => void | Promise<void>
 * @param options.options.overlap skip | queue
 * @param options.options.timeout 超时毫秒，0 表示不限制
 * @param options.signal 外部中止信号（插件卸载时触发）
 */
export function createTaskRunner({ name = "task", fn, options = {}, signal = null, logger = null } = {}) {
  const overlap = options.overlap === "queue" ? "queue" : "skip"
  const timeout = options.timeout === undefined ? 0 : Math.max(0, parseDuration(options.timeout, 0))
  const log = resolveLogger(logger)
  const state = { running: false, queued: 0, skipped: 0, runs: 0, errors: 0, current: null }

  async function invoke() {
    if (signal?.aborted) return
    state.runs++
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal.reason)
    signal?.addEventListener("abort", onAbort, { once: true })

    let timer = null
    const timedOut = new Promise(resolve => {
      if (timeout <= 0) return
      timer = setTimeout(() => {
        controller.abort(new Error("timeout"))
        resolve(TIMEOUT)
      }, timeout)
      timer.unref?.()
    })

    try {
      const task = Promise.resolve().then(() => fn(controller.signal))
      if (timeout > 0) {
        const raced = await Promise.race([
          task.then(
            value => ({ ok: true, value }),
            error => ({ ok: false, error }),
          ),
          timedOut.then(() => ({ timeout: true })),
        ])
        if (raced.timeout) {
          log?.warn?.(`[定时任务][${name}] 超过 ${timeout}ms，已中止并停止等待`)
          return
        }
        if (!raced.ok) throw raced.error
      } else {
        await task
      }
    } catch (err) {
      /** 插件卸载导致的中止不算错误 */
      if (signal?.aborted) return
      state.errors++
      log?.error?.(`[定时任务][${name}] 执行出错`)
      log?.error?.(err)
    } finally {
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }
  }

  async function tick() {
    if (signal?.aborted) return
    if (state.running) {
      if (overlap === "queue" && state.queued < MAX_QUEUE) {
        state.queued++
        try {
          await state.current
          await invoke()
        } finally {
          state.queued--
        }
        return
      }
      state.skipped++
      return
    }
    state.running = true
    const running = invoke()
    state.current = running
    try {
      await running
    } finally {
      state.running = false
      state.current = null
    }
  }

  return { name, tick, state, options: { overlap, timeout } }
}

export class TaskScheduler {
  constructor({ logger = null } = {}) {
    this.logger = logger
    /** id -> { id, plugin, kind, spec, name, runner, handle, job } */
    this.jobs = new Map()
    this.seq = 0
  }

  get size() {
    return this.jobs.size
  }

  /**
   * 登记一个任务
   * @param options.plugin 归属插件 key
   * @param options.kind "cron" | "interval"
   * @param options.schedule cron 表达式，或 interval 的时长
   * @param options.fn (signal) => void | Promise<void>
   * @param options.options.overlap / timeout / immediate / name
   * @param options.signal 插件中止信号
   * @returns Disposer
   */
  register({ plugin, kind = "cron", schedule: spec, fn, options = {}, signal = null }) {
    if (typeof fn !== "function") throw new Error(`插件 ${plugin} 的任务缺少执行函数`)
    if (kind !== "cron" && kind !== "interval") {
      throw new Error(`插件 ${plugin} 的任务类型不合法：${kind}，只支持 cron / interval`)
    }
    const log = resolveLogger(this.logger)
    const id = `${plugin}:${++this.seq}`
    const name = options.name || `${plugin}#${this.seq}`
    const runner = createTaskRunner({ name, fn, options, signal, logger: log })
    const record = { id, plugin, kind, spec, name, runner, handle: null, job: null }

    if (kind === "interval") {
      const ms = parseDuration(spec, -1)
      if (!(ms >= MIN_INTERVAL)) {
        throw new Error(
          `插件 ${plugin} 的间隔任务周期 ${spec} 过短：最小 1s，请确认单位是否写错`,
        )
      }
      if (ms > 0x7fffffff) {
        throw new Error(`插件 ${plugin} 的间隔任务周期 ${spec} 超出上限`)
      }
      record.handle = setInterval(() => runner.tick(), ms)
      record.handle.unref?.()
    } else {
      if (typeof spec !== "string" || !spec.trim()) {
        throw new Error(`插件 ${plugin} 的 cron 表达式为空`)
      }
      record.job = getSchedule().scheduleJob(spec, () => runner.tick())
      if (!record.job) throw new Error(`插件 ${plugin} 的 cron 表达式无法解析：${spec}`)
    }

    this.jobs.set(id, record)
    if (options.immediate) runner.tick()
    return () => this.cancel(id)
  }

  cancel(id) {
    const record = this.jobs.get(id)
    if (!record) return false
    try {
      if (record.handle) clearInterval(record.handle)
      record.job?.cancel?.()
    } catch (ignored) {}
    record.handle = null
    record.job = null
    this.jobs.delete(id)
    return true
  }

  /** 按插件整批注销 */
  removePlugin(plugin) {
    let removed = 0
    for (const record of [...this.jobs.values()]) {
      if (record.plugin === plugin) {
        this.cancel(record.id)
        removed++
      }
    }
    return removed
  }

  list() {
    return [...this.jobs.values()].map(record => ({
      id: record.id,
      plugin: record.plugin,
      kind: record.kind,
      schedule: record.spec,
      name: record.name,
      state: { ...record.runner.state, current: undefined },
    }))
  }

  stop() {
    for (const id of [...this.jobs.keys()]) this.cancel(id)
  }
}

export default new TaskScheduler()
