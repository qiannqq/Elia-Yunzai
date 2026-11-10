/**
 * HTTP / WebSocket 服务
 *
 * 只做三件事：把插件登记的路由挂起来、把 node 的请求转成 RouteRequest、把返回值转成响应。
 * 默认只监听回环地址；没有配 token 又想监听外网时直接拒绝启动，而不是默默裸奔。
 *
 * 懒启动：有插件真的登记了路由/静态目录/WebSocket 才 listen，
 * 一个都不用 HTTP 的部署连端口都不会开。
 */
import http from "node:http"
import fs from "node:fs"
import { URL } from "node:url"
import routes, { mimeOf, normalizePath, resolveStatic } from "./router.js"
import cfg from "../config/config.js"

const DEFAULT_BODY_LIMIT = 1024 * 1024
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"])

export function isLoopback(host) {
  return LOOPBACK.has(String(host || "").toLowerCase())
}

/** 把 query 解析成 { key: value | [value...] } */
export function parseQuery(search) {
  const result = {}
  const params = new URLSearchParams(search || "")
  for (const [key, value] of params) {
    if (result[key] === undefined) result[key] = value
    else if (Array.isArray(result[key])) result[key].push(value)
    else result[key] = [result[key], value]
  }
  return result
}

/**
 * 读取请求体
 * @param limit 上限字节数，超出抛 code = 413 的错误
 * @returns { buffer, text, parsed }
 */
export function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", chunk => {
      size += chunk.length
      if (size > limit) {
        const error = new Error("请求体超过上限")
        error.code = 413
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      const buffer = Buffer.concat(chunks)
      const text = buffer.toString("utf8")
      const type = String(req.headers["content-type"] || "").toLowerCase()
      let parsed = undefined
      if (!buffer.length) parsed = undefined
      else if (type.includes("application/json")) {
        try {
          parsed = JSON.parse(text)
        } catch (err) {
          parsed = text
        }
      } else if (type.includes("application/x-www-form-urlencoded")) {
        parsed = parseQuery(text)
      } else {
        parsed = text
      }
      resolve({ buffer, text, parsed })
    })
    req.on("error", reject)
  })
}

/**
 * 把处理器返回值转成响应
 * - 返回 undefined / null：204
 * - 返回 { status, headers, body }：按字面量处理
 * - 返回 Buffer / Uint8Array：二进制
 * - 返回字符串：text/plain
 * - 返回其它对象：JSON
 */
export function toResponse(result, res, method = "GET") {
  if (result === undefined || result === null) {
    res.writeHead(204)
    res.end()
    return
  }
  if (result instanceof Response) {
    /** 兼容标准 Response：直接透传 */
    res.writeHead(result.status, Object.fromEntries(result.headers))
    result.arrayBuffer().then(buffer => res.end(Buffer.from(buffer)))
    return
  }
  const isEnvelope =
    typeof result === "object" &&
    !Buffer.isBuffer(result) &&
    !(result instanceof Uint8Array) &&
    ("status" in result || "headers" in result || "body" in result)
  const status = (isEnvelope && result.status) || 200
  const headers = { ...(isEnvelope && result.headers) }
  const body = isEnvelope ? result.body : result

  if (body === undefined || body === null) {
    res.writeHead(status, headers)
    res.end()
    return
  }
  if (typeof body === "string") {
    headers["content-type"] ||= "text/plain; charset=utf-8"
    const payload = Buffer.from(body, "utf8")
    headers["content-length"] = payload.length
    res.writeHead(status, headers)
    res.end(method === "HEAD" ? undefined : payload)
    return
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const payload = Buffer.from(body)
    headers["content-type"] ||= "application/octet-stream"
    headers["content-length"] = payload.length
    res.writeHead(status, headers)
    res.end(method === "HEAD" ? undefined : payload)
    return
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8")
  headers["content-type"] ||= "application/json; charset=utf-8"
  headers["content-length"] = payload.length
  res.writeHead(status, headers)
  res.end(method === "HEAD" ? undefined : payload)
}

export class WebServer {
  constructor({ table = routes, logger = null } = {}) {
    this.table = table
    this.logger = logger
    this.server = null
    this.wsServer = null
    this.running = false
    this.warnedDisabled = false
    this.warnedNoToken = false
  }

  get log() {
    return this.logger || globalThis.logger
  }

  /** 读 web.yaml，缺文件时回退到默认配置 */
  getConfig() {
    try {
      return cfg.getConfig("web") || {}
    } catch (err) {
      try {
        return cfg.getdefSet("web") || {}
      } catch (ignored) {
        return {}
      }
    }
  }

  get enabled() {
    return this.getConfig().enable !== false
  }

  get token() {
    return String(this.getConfig().token || "")
  }

  /** 有登记项才启动，且只启动一次 */
  ensure() {
    if (this.running || !this.enabled) return this
    if (!this.table.size) return this
    this.start()
    return this
  }

  start() {
    if (this.running) return this
    const config = this.getConfig()
    const host = String(config.host || "127.0.0.1")
    const port = Number(config.port || 2536)

    if (!this.token && !isLoopback(host)) {
      this.log?.error?.(
        `[HTTP] 监听地址 ${host} 不是回环地址，却没有配置 token；已拒绝启动。请在 config/config/web.yaml 里设置 token，或把 host 改回 127.0.0.1`,
      )
      return this
    }

    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.on("error", err => {
      this.log?.error?.(`[HTTP] 监听 ${host}:${port} 失败`)
      this.log?.error?.(err)
      this.running = false
      this.server = null
    })
    this.server.listen(port, host, () => {
      this.log?.mark?.(`[HTTP] 已监听 http://${host}:${port}，路由 ${this.table.size} 条`)
    })
    this.attachWebSocket()
    this.running = true
    return this
  }

  attachWebSocket() {
    if (!this.server) return
    if (!this.table.sockets.length) return
    import("ws")
      .then(({ WebSocketServer }) => {
        const wss = new WebSocketServer({ noServer: true })
        this.wsServer = wss
        this.server.on("upgrade", (req, socket, head) => {
          const url = new URL(req.url, "http://localhost")
          const pathname = normalizePath(decodeURIComponent(url.pathname))
          const found = this.table.findSocket(pathname)
          if (!found) {
            socket.destroy()
            return
          }
          const { record } = found
          try {
            if (record.verify && record.verify(req) === false) {
              socket.destroy()
              return
            }
          } catch (err) {
            socket.destroy()
            return
          }
          wss.handleUpgrade(req, socket, head, conn => {
            try {
              record.handler(conn, req)
            } catch (err) {
              this.log?.error?.("[WebSocket] 处理器执行出错")
              this.log?.error?.(err)
              conn.close?.()
            }
          })
        })
      })
      .catch(err => {
        this.log?.error?.("[WebSocket] 缺少 ws 依赖，已跳过 WebSocket 路由")
        this.log?.error?.(err)
      })
  }

  /** 鉴权：配了 token 就校验，没配且只监听回环则放行 */
  authorize(req, url) {
    const token = this.token
    if (!token) return true
    const header = String(req.headers.authorization || "")
    if (header.startsWith("Bearer ") && header.slice(7) === token) return true
    const query = url.searchParams.get("token")
    if (query === token) return true
    return false
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`)
    let pathname = url.pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch (err) {}

    const method = String(req.method || "GET").toUpperCase()
    const found = this.table.find(method, pathname)

    if (found?.status === 405) {
      toResponse({ status: 405, headers: { allow: found.allow.join(", ") }, body: { error: "Method Not Allowed" } }, res, method)
      return
    }

    if (found?.route) {
      const { route, params } = found
      if (route.auth && !this.authorize(req, url)) {
        toResponse({ status: 401, body: { error: "Unauthorized" } }, res, method)
        return
      }
      let body
      try {
        const read = await readBody(req, route.bodyLimit || DEFAULT_BODY_LIMIT)
        body = { parsed: read.parsed, rawBody: route.rawBody ? read.buffer : undefined }
      } catch (err) {
        if (err.code === 413) {
          toResponse({ status: 413, body: { error: "Payload Too Large" } }, res, method)
          return
        }
        toResponse({ status: 400, body: { error: "Bad Request" } }, res, method)
        return
      }
      const request = {
        method,
        path: normalizePath(pathname),
        params,
        query: parseQuery(url.search),
        headers: req.headers,
        body: body.parsed,
        rawBody: body.rawBody,
        ip: req.socket?.remoteAddress || "",
      }
      try {
        const result = await route.handler(request)
        toResponse(result, res, method)
      } catch (err) {
        this.log?.error?.(`[HTTP] ${method} ${pathname} 处理出错`)
        this.log?.error?.(err)
        toResponse({ status: 500, body: { error: "Internal Server Error" } }, res, method)
      }
      return
    }

    const statics = this.table.findStatic(pathname)
    if (statics) {
      if (statics.record.auth && !this.authorize(req, url)) {
        toResponse({ status: 401, body: { error: "Unauthorized" } }, res, method)
        return
      }
      const resolved = resolveStatic(statics.record.dir, statics.rest)
      if (!resolved) {
        toResponse({ status: 404, body: { error: "Not Found" } }, res, method)
        return
      }
      const headers = {
        "content-type": mimeOf(resolved.file),
        "content-length": resolved.size,
        "cache-control": "no-cache",
      }
      res.writeHead(200, headers)
      if (method === "HEAD") {
        res.end()
        return
      }
      fs.createReadStream(resolved.file).pipe(res)
      return
    }

    toResponse({ status: 404, body: { error: "Not Found" } }, res, method)
  }

  stop() {
    this.wsServer?.close?.()
    this.wsServer = null
    if (this.server) {
      this.server.close()
      this.server.closeAllConnections?.()
      this.server = null
    }
    this.running = false
    return this
  }
}

export default new WebServer()
