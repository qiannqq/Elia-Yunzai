#!/usr/bin/env node
/**
 * 内核纯度检查
 *
 * 只扫描 lib/：内核实现不出现具体插件、具体游戏与具体渲染后端的名字或路径。
 * 插件、配置、渲染后端不在检查范围内。
 *
 * 用法：node ./lib/tools/kernel-purity.js
 * 命中时逐条打印 文件:行: 规则，并以 1 退出。
 */
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const TARGETS = ["lib"]
const EXCLUDE = new Set(["lib/tools/kernel-purity.js", "lib/tools/kernel-selftest.js"])

const RULES = [
  { name: "插件名 miao", re: /miao/i },
  { name: "插件名 genshin", re: /genshin/i },
  { name: "米游社 model", re: /\bmys(Info|Api|User)?\b/i },
  { name: "游戏专有词", re: /米游社|原神|星铁|星穹|崩铁|绝区零|穹轨/ },
  { name: "游戏事件字段", re: /\bisSr\b|\bisGs\b|\be\.game\b/ },
  { name: "跨包别名", re: /#miao/ },
  { name: "写死的插件路径", re: /plugins\/[A-Za-z0-9_-]+\// },
  /** 内核可以保留 puppeteer 这个名字（旧的导出与调用方式），但不许真的依赖它 */
  { name: "依赖渲染后端库", re: /(?:from|import\()\s*["'][^"']*(?:puppeteer|shotium)[^"']*["']/ },
  { name: "渲染后端配置", re: /\bchromium_path\b|\bpuppeteer_(?:idle|ws|timeout)\b/ },
  { name: "协议库", re: /icqq/i },
]

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(ROOT, full).split(path.sep).join("/")
    if (entry.isDirectory()) yield* walk(full)
    else if (/\.(js|json|ya?ml)$/.test(entry.name)) yield { full, rel }
  }
}

const hits = []
let files = 0

for (const target of TARGETS) {
  if (!fs.existsSync(target)) continue
  for (const { full, rel } of walk(target)) {
    if (EXCLUDE.has(rel)) continue
    files++
    const lines = fs.readFileSync(full, "utf8").split(/\r?\n/)
    lines.forEach((line, i) => {
      if (line.includes("kernel-purity-ignore")) return
      for (const rule of RULES) {
        if (rule.re.test(line)) hits.push(`${rel}:${i + 1}: ${rule.name} → ${line.trim()}`)
      }
    })
  }
}

if (hits.length) {
  console.error(`内核纯度检查未通过，共 ${hits.length} 处：`)
  for (const hit of hits) console.error(`  ${hit}`)
  process.exit(1)
}

console.log(`内核纯度检查通过（${files} 个文件）`)
