/**
 * 路由表
 *
 * 与 Yunzai-NG 的 server 一致的对外契约：插件只写相对路径，scope 由内核拼成
 * /plugin/<插件名>，处理器拿到的是框架无关的 RouteRequest，返回值就是响应。
 *
 * 匹配规则：
 * - :name 匹配一段并放进 params
 * - *rest 或 *name 匹配剩余全部
 * - 同 method + 同 pattern 重复登记时后者生效并告警
 */
import fs from "node:fs"
import path from "node:path"

const METHOD_SET = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
}

/**
 * 把静态目录下的相对路径解析成真实文件
 * 越界（..）返回 null，交给调用方回 404，而不是回一个目录外的文件
 */
export function resolveStatic(root, rest) {
  const base = path.resolve(root)
  const target = path.resolve(base, rest || "")
  if (target !== base && !target.startsWith(base + path.sep)) return null
  try {
    const stat = fs.statSync(target)
    if (stat.isDirectory()) {
      const index = path.join(target, "index.html")
      return fs.existsSync(index) ? { file: index, size: fs.statSync(index).size } : null
    }
    return { file: target, size: stat.size }
  } catch (err) {
    return null
  }
}

export function mimeOf(file) {
  const index = file.lastIndexOf(".")
  return MIME[file.slice(index).toLowerCase()] || "application/octet-stream"
}

/** 规范化路径：去掉重复斜杠与尾部斜杠 */
export function normalizePath(input) {
  const parts = String(input || "/")
    .split("/")
    .filter(Boolean)
  return parts.length ? `/${parts.join("/")}` : "/"
}

function compile(pattern) {
  const normalized = normalizePath(pattern)
  const parts = normalized === "/" ? [] : normalized.slice(1).split("/")
  const segments = parts.map(part => {
    if (part.startsWith(":")) return { type: "param", name: part.slice(1) }
    if (part === "*") return { type: "rest", name: "*" }
    if (part.startsWith("*")) return { type: "rest", name: part.slice(1) || "*" }
    return { type: "literal", value: part }
  })
  return { pattern: normalized, segments }
}

function matchSegments(route, parts) {
  const params = {}
  for (let i = 0; i < route.segments.length; i++) {
    const segment = route.segments[i]
    if (segment.type === "rest") {
      params[segment.name] = parts.slice(i).join("/")
      return params
    }
    if (i >= parts.length) return null
    if (segment.type === "param") {
      try {
        params[segment.name] = decodeURIComponent(parts[i])
      } catch (err) {
        params[segment.name] = parts[i]
      }
      continue
    }
    if (segment.value !== parts[i]) return null
  }
  return parts.length === route.segments.length ? params : null
}

function warn(message) {
  if (globalThis.logger?.warn) globalThis.logger.warn(message)
  else console.warn(message)
}

export class RouteTable {
  constructor() {
    this.routes = []
    this.statics = []
    this.sockets = []
  }

  get size() {
    return this.routes.length + this.statics.length + this.sockets.length
  }

  /**
   * 登记一条 HTTP 路由
   * @param method 七种方法之一
   * @param pattern 相对路径，允许 :name 与 *rest
   * @param handler (req) => 值 | { status, headers, body }
   * @param options.owner 归属插件
   * @param options.auth 是否要求鉴权，默认 true（与 NG 一致）
   * @param options.bodyLimit 请求体上限，默认 1MB
   * @param options.rawBody 是否同时提供原始 Buffer
   */
  add(method, pattern, handler, { owner = null, auth = true, bodyLimit = 1024 * 1024, rawBody = false } = {}) {
    const verb = String(method || "GET").toUpperCase()
    if (!METHOD_SET.has(verb)) throw new Error(`不支持的 HTTP 方法：${method}`)
    if (typeof handler !== "function") throw new Error("路由处理器必须是函数")
    const route = { method: verb, handler, owner, auth, bodyLimit, rawBody, ...compile(pattern) }
    const duplicate = this.routes.find(item => item.method === verb && item.pattern === route.pattern)
    if (duplicate) {
      warn(`[路由] ${verb} ${route.pattern} 被 ${duplicate.owner} 与 ${owner} 重复登记，后者生效`)
      this.routes = this.routes.filter(item => item !== duplicate)
    }
    this.routes.push(route)
    return () => {
      this.routes = this.routes.filter(item => item !== route)
    }
  }

  /**
   * 登记静态目录
   * @param urlPath 挂载路径（相对 scope）
   * @param dir 目录绝对路径
   */
  addStatic(urlPath, dir, { owner = null, auth = true } = {}) {
    const record = { pattern: normalizePath(urlPath), dir, owner, auth }
    this.statics.push(record)
    /** 长的前缀优先，避免 / 抢走 /assets */
    this.statics.sort((a, b) => b.pattern.length - a.pattern.length)
    return () => {
      this.statics = this.statics.filter(item => item !== record)
    }
  }

  /** 登记一条 WebSocket 路由 */
  addSocket(path, handler, { owner = null, verify = null } = {}) {
    const record = { pattern: normalizePath(path), handler, owner, verify }
    this.sockets.push(record)
    return () => {
      this.sockets = this.sockets.filter(item => item !== record)
    }
  }

  /**
   * 查找路由
   * @returns { route, params } | { status: 405, allow: string[] } | null
   */
  find(method, pathname) {
    const verb = String(method || "GET").toUpperCase()
    const parts = normalizePath(pathname) === "/" ? [] : normalizePath(pathname).slice(1).split("/")
    const allowed = new Set()
    for (const route of this.routes) {
      const params = matchSegments(route, parts)
      if (!params) continue
      if (route.method === verb || (verb === "HEAD" && route.method === "GET")) {
        return { route, params }
      }
      allowed.add(route.method)
    }
    if (allowed.size) return { status: 405, allow: [...allowed] }
    return null
  }

  /** 查找命中的静态目录，返回 { record, rest } */
  findStatic(pathname) {
    const target = normalizePath(pathname)
    for (const record of this.statics) {
      if (record.pattern === "/") return { record, rest: target.slice(1) }
      if (target === record.pattern) return { record, rest: "" }
      if (target.startsWith(`${record.pattern}/`)) {
        return { record, rest: target.slice(record.pattern.length + 1) }
      }
    }
    return null
  }

  /** 查找 WebSocket 路由 */
  findSocket(pathname) {
    const target = normalizePath(pathname)
    for (const record of this.sockets) {
      if (record.pattern === target) return { record, params: {} }
      const compiled = compile(record.pattern)
      const params = matchSegments(compiled, target === "/" ? [] : target.slice(1).split("/"))
      if (params) return { record, params }
    }
    return null
  }

  /** 按归属批量摘除 */
  removeByOwner(owner) {
    if (!owner) return 0
    const before = this.size
    this.routes = this.routes.filter(item => item.owner !== owner)
    this.statics = this.statics.filter(item => item.owner !== owner)
    this.sockets = this.sockets.filter(item => item.owner !== owner)
    return before - this.size
  }

  clear() {
    this.routes = []
    this.statics = []
    this.sockets = []
  }

  /** 已登记路径，用于诊断与日志 */
  list() {
    return [
      ...this.routes.map(item => ({ kind: "route", method: item.method, path: item.pattern, owner: item.owner })),
      ...this.statics.map(item => ({ kind: "static", path: item.pattern, owner: item.owner })),
      ...this.sockets.map(item => ({ kind: "websocket", path: item.pattern, owner: item.owner })),
    ]
  }
}

export default new RouteTable()
