#!/usr/bin/env node
/**
 * 内核自测：只覆盖不依赖第三方模块的部分
 *
 * 用法：node ./lib/tools/kernel-selftest.js
 */
import assert from "node:assert/strict"
import KeyedRegistry from "../plugins/registry.js"
import { buildRenderData } from "../plugins/render-data.js"

let passed = 0
function test(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

console.log("KeyedRegistry")

test("同 key 覆盖，size 不增长", () => {
  const reg = new KeyedRegistry()
  reg.set("a", 1)
  reg.set("a", 2)
  assert.equal(reg.size, 1)
  assert.equal(reg.get("a"), 2)
})

test("按 priority 升序，同优先级保持注册顺序", () => {
  const reg = new KeyedRegistry()
  reg.set("c", 3, 30)
  reg.set("a", 1, 10)
  reg.set("b", 2, 10)
  assert.deepEqual(
    reg.values().map(i => i.key),
    ["a", "b", "c"],
  )
})

test("delete 后可重新排序", () => {
  const reg = new KeyedRegistry()
  reg.set("a", 1, 20)
  reg.set("b", 2, 10)
  assert.deepEqual(
    reg.values().map(i => i.key),
    ["b", "a"],
  )
  reg.delete("b")
  assert.deepEqual(
    reg.values().map(i => i.key),
    ["a"],
  )
  assert.equal(reg.has("b"), false)
})

console.log("buildRenderData")

const config = { package: { version: "9.9.9" } }

test("内核默认值：版本号、资源路径", () => {
  const data = buildRenderData({ plugin: "demo", segments: ["a", "b"], config })
  assert.equal(data._plugin, "demo")
  assert.equal(data._htmlPath, "a/b")
  assert.equal(data.pluResPath, "../../../../../plugins/demo/resources/")
  assert.equal(data._res_path, data.pluResPath)
  assert.equal(data.tplFile, "./plugins/demo/resources/a/b.html")
  assert.equal(data.saveId, "b")
  assert.ok(data.copyright.includes("9.9.9"))
  assert.deepEqual(data.sys, { scale: 1 })
  assert.deepEqual(data.pageGotoParams, { waitUntil: "networkidle2" })
})

test("合并顺序：默认 → 提供者 → data", () => {
  const providers = [{ key: "p", value: () => ({ a: "provider", b: "provider" }) }]
  const data = buildRenderData(
    { plugin: "demo", segments: ["x"], data: { b: "data", c: "data" }, config },
    providers,
  )
  assert.equal(data.a, "provider")
  assert.equal(data.b, "data")
  assert.equal(data.c, "data")
})

test("内核终值不可被 data 覆盖", () => {
  const data = buildRenderData({
    plugin: "demo",
    segments: ["x"],
    data: {
      _plugin: "hack",
      _htmlPath: "hack",
      pluResPath: "hack",
      tplFile: "hack",
      saveId: "hack",
      pageGotoParams: {},
    },
    config,
  })
  assert.equal(data._plugin, "demo")
  assert.equal(data._htmlPath, "x")
  assert.equal(data.pluResPath, "../../../../plugins/demo/resources/")
  assert.equal(data.tplFile, "./plugins/demo/resources/x.html")
  assert.equal(data.saveId, "hack")
  assert.deepEqual(data.pageGotoParams, { waitUntil: "networkidle2" })
})

test("saveId 回退顺序：saveId → save_id → 路径末段", () => {
  const base = { plugin: "demo", segments: ["a", "b"], config }
  assert.equal(buildRenderData({ ...base, data: { save_id: "sid" } }).saveId, "sid")
  assert.equal(buildRenderData({ ...base, data: {} }).saveId, "b")
})

test("提供者抛错不影响其余提供者与 data", () => {
  const origError = console.error
  console.error = () => {}
  try {
    const providers = [
      { key: "bad", value: () => { throw new Error("boom") } },
      { key: "good", value: () => ({ ok: 1 }) },
    ]
    const data = buildRenderData({ plugin: "demo", segments: ["x"], data: { d: 2 }, config }, providers)
    assert.equal(data.ok, 1)
    assert.equal(data.d, 2)
  } finally {
    console.error = origError
  }
})

test("非对象返回值被忽略", () => {
  const data = buildRenderData(
    { plugin: "demo", segments: ["x"], config },
    [{ key: "p", value: () => "nope" }],
  )
  assert.equal(data._plugin, "demo")
})

console.log(`\n全部通过（${passed} 项）`)
