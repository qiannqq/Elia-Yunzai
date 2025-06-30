# Elia-Yunzai v3 伊莉雅
 由Miao-Yunzai修改，轻量化版

<p align="center">
  <img src="./resources/elia.png" width="70%" height="70%">
</p>

 #### 简介
 开发该Yunzai的目的是本组织成员不便迁移到TRSS-Yunzai，又需要一个轻量化但可以正常使用的Miao-Yunzai，因此Elia-Yunzai诞生了
 #### 说明
 1. 内置Stdin标准输入，可以直接在控制台执行指令
 2. 默认跳过ICQQ登录，需要可以在配置文件中打开
 3. 已移除对miao-plugin的依赖，并删除了genshin
 4. 虽然是移除了对miao-plugin的依赖，但部分插件可能需要用到miao-plugin，因此建议安装miao-plugin
 5. Elia-Yunzai 底层不会与 Miao-Yunzai 实时同步
 #### 安装Elia-Yunzai
 ```
 git clone --depth=1 https://gitee.com/Orbiter_StellarTrek/Elia-Yunzai.git
 cd Elia-Yunzai
 pnpm i
 ```
 #### 安装genshin
 ```
 git clone --depth=1 https://gitee.com/TimeRainStarSky/Yunzai-genshin.git ./plugins/genshin
 ```