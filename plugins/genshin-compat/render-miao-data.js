/**
 * 渲染数据：米游社风格的布局与模板路径
 *
 * 模板里用到 _miao_path / _tpl_path / defaultLayout / elemLayout 时，
 * 由本插件按「已安装 miao-plugin 优先，否则用随包自带的副本」提供。
 */
import fs from "node:fs"
import Runtime from "../../lib/plugins/runtime.js"

/** miao-plugin 自带的资源 */
const MIAO_RES = "plugins/miao-plugin/resources/"
/** 随包自带的副本 */
const BUNDLED_RES = "plugins/genshin-compat/resources/miao-common/"

export function installRenderData() {
  Runtime.renderData(
    ({ segments = [] }) => {
      const res = fs.existsSync("./plugins/miao-plugin") ? MIAO_RES : BUNDLED_RES
      const resPath = `../../../${"../".repeat(segments.length)}${res}`
      const layoutPath = `${process.cwd()}/${res}common/layout/`
      const tplPath = `${process.cwd()}/${res}common/tpl/`
      return {
        _miao_path: resPath,
        _tpl_path: tplPath,
        defaultLayout: layoutPath + "default.html",
        elemLayout: layoutPath + "elem.html",
      }
    },
    "genshin-compat:miao-render",
  )
}
