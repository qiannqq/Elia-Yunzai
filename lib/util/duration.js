/**
 * 时长解析与格式化
 *
 * 与 Yunzai-NG 的 util/duration.ts 保持同一套规则，插件的 every / cron / cache.ttl
 * 在两侧写同一个值就会得到同一个含义：
 * - 数字、以及纯数字字符串，都按毫秒
 * - 带单位的字符串：ms / s / m / h / d，允许小数
 */
const UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
const DURATION_RE = /^(-?\d+(?:\.\d+)?)(ms|s|m|h|d)$/i

/**
 * 解析时长为毫秒
 * @param value 数字或字符串
 * @param fallback 无法解析时的返回值
 */
export function parseDuration(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback
  if (typeof value !== "string") return fallback
  const text = value.trim()
  if (!text) return fallback
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  const matched = DURATION_RE.exec(text)
  if (!matched) return fallback
  return Number(matched[1]) * UNIT_MS[matched[2].toLowerCase()]
}

/** 把毫秒格式化成便于阅读的写法 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return String(ms)
  if (ms === 0) return "0ms"
  const units = [
    ["d", UNIT_MS.d],
    ["h", UNIT_MS.h],
    ["m", UNIT_MS.m],
    ["s", UNIT_MS.s],
  ]
  for (const [unit, size] of units) {
    if (Math.abs(ms) >= size) {
      const value = Math.round((ms / size) * 100) / 100
      return `${value}${unit}`
    }
  }
  return `${ms}ms`
}
