import "./config/init.js"
import boot from "./adapter/boot.js"

/** 启动入口：具体登录流程由 adapters/ 下的适配器决定 */
export default class Yunzai {
  static async run() {
    return await boot()
  }
}
