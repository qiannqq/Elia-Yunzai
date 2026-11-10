/**
 * 跨内核示例插件
 *
 * 同一份代码可以在 Yunzai-NG 与 Elia-Yunzai 上运行：
 * 只要导出 { name, setup(ctx) }，内核就会把 ctx 递过来。
 * 插件不需要 import 任何框架包，也不需要知道自己在哪个内核里跑。
 *
 * 规矩只有一条：**凡是会留下东西的操作，都通过 ctx 登记**。
 * 定时器、事件监听、路由、服务、缓存都算；内核在卸载时按登记的逆序回收，
 * 所以热重载不会留下还在跑的旧定时器。
 */
import fs from "node:fs"

export default {
  name: "ng-compat-demo",
  version: "1.0.0",
  description: "演示定时器、事件、缓存、服务与路由的登记方式",

  setup(ctx) {
    ctx.logger.mark("示例插件已装载")

    /** 1. 周期任务：交给内核，卸载时自动停掉 */
    ctx.every(
      "60s",
      () => {
        ctx.logger.debug("每 60 秒执行一次，不需要自己 clearInterval")
      },
      { name: "demo:tick", overlap: "skip" },
    )

    /** 2. cron 任务：同样是内核托管 */
    ctx.cron(
      "0 4 * * *",
      () => {
        ctx.logger.debug("每天 04:00 执行一次")
      },
      { name: "demo:daily" },
    )

    /**
     * 3. 自己创建的定时器：必须登记清理
     *
     * 这类定时器内核管不到，不登记就会在插件卸载后继续跑。
     * ctx.onDispose 接收一个清理函数，卸载时调用；
     * ctx.adopt(timer) 是同一件事的简写。
     */
    const selfTimer = setInterval(() => {
      ctx.logger.debug("自己创建的定时器")
    }, 5 * 60 * 1000)
    /** 只剩定时器时不要拖着进程不退出 */
    selfTimer.unref?.()
    ctx.onDispose(() => clearInterval(selfTimer))

    /** 4. 内核事件：app/ready、message、bot/online…… */
    ctx.on("app/ready", () => ctx.logger.mark("收到 app/ready"))
    ctx.on("message", e => {
      if (e.msg === "#demo") e.reply("示例插件在，登记的定时器与监听都已生效")
    })

    /** 5. 缓存：随插件卸载清空，不用自己管生命周期 */
    const cache = ctx.cache({ max: 200, ttl: 5 * 60 * 1000 })
    cache.set("loaded_at", Date.now())

    /** 6. 跨插件服务：别的插件可以 ctx.inject("demo.greeting") 取到 */
    ctx.provide("demo.greeting", "你好")

    /** 7. HTTP 路由：固定挂在 /plugin/<插件名> 下，需要 web.yaml 里 enable: true */
    ctx.route("GET", "/ping", () => ({ status: 200, body: { ok: true, plugin: ctx.name } }))

    /** 静态目录（有就挂，没有就跳过） */
    const assets = ctx.resource("assets")
    if (fs.existsSync(assets)) ctx.static("/assets", assets)

    /**
     * 8. setup 的返回值也会被当作清理函数
     * 适合「装载了什么，就返回对应的卸载动作」这种写法
     */
    return () => ctx.logger.mark("示例插件已卸载，登记项已逆序回收")
  },
}
