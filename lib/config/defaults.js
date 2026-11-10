/**
 * 内核自带配置
 *
 * 只放内核自己会读的键。插件与适配器的配置由它们自己保管：
 * 启动时把这里的默认值写到 config/default_config/，缺失的用户配置再从默认值复制一份。
 */
const DEFAULTS = {
  bot: `# 日志等级:trace,debug,info,warn,fatal,mark,error,off
# mark时只显示执行命令，不显示聊天记录
log_level: info
# 群聊和频道中过滤自己的消息
ignore_self: true
# 被风控时是否尝试用分片发送
resend: false
# 发送消息错误时是否通知主人
sendmsg_error: false
# 重启API端口 仅ksr.js生效
restart_port: 27881
# ffmpeg
ffmpeg_path:
ffprobe_path:

# 接口代理地址，国际服可用
proxyAddress:

# 上线时给首个主人QQ推送帮助
online_msg: true
# 上线推送通知的冷却时间
online_msg_exp: 86400

# 适配器 id，留空时使用唯一已注册的适配器
adapter: ""

# 是否启用串行加载插件
serial_load: false

# 传入的QQ版本(如:8.9.63、8.9.68)，由适配器解释
ver:
`,

  other: `# 是否自动同意加好友 1-同意 0-不处理
autoFriend: 1
# 是否自动退群人数，当被好友拉进群时，群人数小于配置值自动退出， 默认50，0则不处理
autoQuit: 50
# 主人QQ号
masterQQ:

# 禁用频道功能 true: 不接受频道消息，flase：接受频道消息
disableGuildMsg: true
# 禁用私聊功能 true：私聊只接受ck以及抽卡链接（Bot主人不受限制），false：私聊可以触发全部指令，默认false
disablePrivate: false
# 禁用私聊Bot提示内容
disableMsg: "私聊功能已禁用，仅支持发送cookie，抽卡记录链接，记录日志文件"
# 私聊通行字符串
disableAdopt:
  - stoken

#白名单群，配置后只在该群生效
whiteGroup:
#白名单qq
whiteQQ:
#黑名单群
blackGroup:
#黑名单qq
blackQQ:
`,

  redis: `# Redis 命令路径
path: redis-server
# redis地址
host: 127.0.0.1
# redis端口
port: 6379
# redis用户名，可以为空
username:
# redis密码，没有密码可以为空
password:
# redis数据库
db: 0
`,

  notice: `# IYUU(https://iyuu.cn/)
iyuu:

# Server酱(https://sct.ftqq.com/)
sct:

# 飞书自定义机器人Webhook (https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
feishu_webhook:
`,

  db: `# Sequelize 配置
# https://sequelize.org/docs/v6/getting-started

# mysql, postgres, sqlite, db2, mariadb, mssql
dialect: sqlite

# SQLite 文件地址
storage: data/db/data.db

# 日志
logging: false
`,

  group: `# 默认设置
default:
  groupGlobalCD:  0    # 群聊中所有指令操作冷却时间，单位毫秒,0则无限制
  singleCD: 1000   # 群聊中个人操作冷却时间，单位毫秒

  onlyReplyAt: 0   # 是否只仅关注主动@机器人的消息， 0-否 1-是 2-触发用户非主人只回复@机器人的消息及特定前缀的消息，主人免前缀
  botAlias:        # 开启后则只回复@机器人的消息及特定前缀的消息，支持多个
    - 云崽
    - 云宝

  imgAddLimit: 0   #添加表情是否限制  0-所有群员都可以添加 1-群管理员才能添加 2-主人才能添加
  imgMaxSize: 2    #添加表情图片大小限制，默认2m
  addPrivate: 1    #是否允许私聊添加  1-允许 0-禁止

  isInheritDefault: 0  # 是否继承默认配置 1-是 0-否，启用后如果不对该群进行单独配置，将继承默认配置

  enable:          #只启用功能，配置后只有该功能才响应

  #禁用功能，功能名称
  disable:
`,

  renderer: `# 渲染后端
#
# 留空时按模板内容自动选择：含 <script> 的模板交给支持脚本的渲染器，
# 其余模板优先走轻量的后端；选中的渲染器渲染失败会自动退回下一个
# 也可以直接指定已有的渲染器 id，例如 puppeteer / shotium
name:
`,

  web: `# 插件 HTTP 服务
# 只有插件登记了路由（ctx.route / ctx.static / ctx.websocket）时才会启动
enable: false

# 监听地址，默认只对本机开放
host: 127.0.0.1

# 监听端口
port: 2536

# 访问令牌，留空表示不校验
# 监听非回环地址时必须设置，否则内核拒绝启动
token: ""
`,
}

export default DEFAULTS
