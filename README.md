# Elia-Yunzai v3 伊莉雅

<p align="center">
  <img src="./resources/elia.png" width="30%" height="30%">
</p>

  由Miao-Yunzai修改，轻量化版，增加和修改一些机制

 ### 简介
 开发该Yunzai的目的是本组织成员不便迁移到TRSS-Yunzai，又需要一个轻量化但可以正常使用的Miao-Yunzai，因此 **Elia-Yunzai** 诞生了

 ### 修改的机制
 1. 已移除对miao-plugin的依赖，并删除了genshin
 * 虽然是移除了对miao-plugin的依赖，但部分插件可能需要用到miao-plugin，因此建议安装miao-plugin
 2. 默认跳过登录ICQQ，需要可以在配置文件中打开
 3. 重写Redis启动逻辑
 4. 移除Render对miao-plugin的依赖
 5. 修复PluginsLoader.changePlugin的Bug，现在插件包(含index.js的大型插件)可以通过调用`changePlugin`方法来热重载插件，key参数为插件包的目录名（例如miao-plugin）。

 ### 增加的机制
 1. 内置Stdin标准输入，可以直接在控制台执行指令
 * 如果装了Lain-plugin等自带标准输入的插件，可删除`plugins/system/stdin.js`自带的标准输入
 2. 对`log: false`的插件输出Debug日志，方便排查问题
 3. 可使用`BotID:GroupID`的格式添加指定Bot的黑白名单
 4. group.yaml可配置“群配置是否继承默认配置禁用或启用的功能”
 5. `#日志`增加了`#控制台日志`，使用`#控制台日志`将会把日志以终端的方式渲染为图片后发送，更方便阅读
 6. JS插件被修改（新增、修改、卸载）时，支持热重载（新增、重载、卸载）定时任务


 ### 安装
 ```
 git clone --depth=1 https://gitee.com/Orbiter_StellarTrek/Elia-Yunzai.git
 cd Elia-Yunzai
 pnpm i
 ```
 ### 由Miao-Yunzai迁移（换源）至Elia-Yunzai
 ```
 git reset --hard 9fa4496d25e53622b2701b25a061e05f9c93d863
 git remote set-url origin https://gitee.com/Orbiter_StellarTrek/Elia-Yunzai.git
 git pull
 ```

 ### 安装genshin（如果需要）
 ```
 git clone --depth=1 https://gitee.com/TimeRainStarSky/Yunzai-genshin.git ./plugins/genshin
 ```
