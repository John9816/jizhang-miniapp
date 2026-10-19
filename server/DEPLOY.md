# 部署实录：记账本小程序后端（已完成部署）

本文档对应**已实际部署完成**的环境：ECS = 阿里云 8.156.95.93（Debian 12, 2C2G/3Mbps），域名 `jizhang-api.751152.xyz`，部署日期 2026-10-18。**零 npm 依赖**（只用 Node 内置模块：`node:sqlite` + `node:http`）。

```
手机微信(小程序) ──HTTPS:443──> jizhang-api.751152.xyz ──nginx:443/TLS──> 127.0.0.1:3123(node + SQLite)
                                                        （AppSecret 只存在服务端 .env）
```

`api.751152.xyz` 已被现网占用（website-api），故本服务使用 `jizhang-api` 子域。

## 部署状态总览

| 环节 | 状态 | 说明 |
| --- | --- | --- |
| Node 运行时 | ✅ 已就绪 | ECS 自带 v22.14.0（≥22.5，内置 node:sqlite 可用） |
| systemd 服务 | ✅ 运行中 | `jizhang-api.service`，listen 127.0.0.1:3123 |
| nginx 反代 | ✅ 已生效 | `/etc/nginx/conf.d/jizhang-api.conf` |
| HTTPS 证书 | ✅ 已签发 | Let's Encrypt（2027-01-16 到期），certbot.timer 自动续期 + 80 跳 443 |
| DNS | ✅ 已就绪 | A 记录 `jizhang-api.751152.xyz → 8.156.95.93`（显式记录优先于 `*` 泛解析） |
| 安全组 | ✅ 已放行 | 外网实测 80/443 可达 |
| 每日备份 | ✅ 已装 | `/etc/cron.daily/jizhang-backup`，保留 14 份 |
| APPID / APPSECRET | ⬜ **待你填写** | 见下方「你的待办清单」第 1 项 |
| 小程序后台域名 | ⬜ 待你配置 | 见第 3 项 |
| 小程序上线 | ⬜ 待你操作 | 见第 4 项 |

## 你的待办清单（4 步，其余已全部完成）

**1. 填入小程序账号（在服务器上操作，不要发到聊天里）**

```bash
ssh root@8.156.95.93
nano /opt/jizhang-api/.env      # 把 APPID / APPSECRET 两行改成真实值
systemctl restart jizhang-api
journalctl -u jizhang-api -n 5  # 看到 listening on 127.0.0.1:3123 即正常
```

值在小程序后台取：mp.weixin.qq.com → 开发管理 → 开发设置 → AppID / AppSecret。

**2. 验证服务端登录已通**

```bash
curl -s -X POST https://jizhang-api.751152.xyz/api/login \
  -H 'Content-Type: application/json' -d '{"code":"test"}'
```

返回 `{"error":"微信登录失败(40013)"}` 说明链路已到微信服务器（test 是假 code 才有这错）；
换成真实 code 后即返回 token。若返回 `{"error":"微信服务未配置"}` 说明 `.env` 没填好。

**3. 小程序后台配 request 合法域名**

mp.weixin.qq.com → 开发管理 → 开发设置 → 服务器域名：

```
https://jizhang-api.751152.xyz
```

硬性规则：**HTTPS、443、不带端口、不能用 IP、已备案**。个人主体每月修改次数很少（约 5 次），**务必一次配对**。本域名随主域 751152.xyz 已备案，直接用。
调试阶段可在开发者工具勾选「详情 → 本地设置 → 不校验合法域名」跳过。

**4. 打开小程序云端开关并上传**

编辑 `jizhang-miniapp/config.js`：

```js
module.exports = {
  cloud: {
    enabled: true,
    apiBase: 'https://jizhang-api.751152.xyz'
  }
}
```

- 开发者工具重新编译 → 首页顶部「云同步」由「待连接」变「已同步 HH:MM」即打通
- 首次登录后本机账本/记录自动整体上云（按记录 ID 去重，原数据不丢）
- 邀请好友：账本页 →「复制邀请码」→ 微信发给对方 → 对方打开小程序 → 账本页 →「输入邀请码」→ 即刻共享，之后双方记账实时同步
- 上传方法：开发者工具 → 上传 → 填版本号 → 小程序后台「版本管理」提交审核 → 通过后发布

## 重部署 / 升级

```bash
# 本地改完 server/ 后，重新上传并部署：
scp server/*.js server/.env.example server/deploy.sh \
    server/jizhang-api.service server/nginx-jizhang-api.conf \
    root@8.156.95.93:/root/jizhang-deploy/
ssh root@8.156.95.93 'cd /root/jizhang-deploy && bash deploy.sh'
```

deploy.sh 会：校验 Node ≥22.5 → 创建 `jizhang` 用户 → 同步文件到 `/opt/jizhang-api`（保留已有 .env）→ 重装 systemd 服务 → 重装 nginx 反代并 reload → 装每日备份 cron。

**只更新 server.js（小改动，推荐）**：

```bash
scp server/server.js root@8.156.95.93:/opt/jizhang-api/server.js
ssh root@8.156.95.93 'chown jizhang:jizhang /opt/jizhang-api/server.js && systemctl restart jizhang-api'
```

### v2 数据模型升级（2026-10-18 已上线）

新增能力：资产账户、预算、周期记账、自定义分类、转账记录。数据结构变化：

- `ledgers` 表新增 5 列：`accounts_json`、`budget_json`、`recurring_json`、`categories_json`、`cfg_at`（账本级配置按 cfgAt 时间戳 LWW 合并）
- `records` 表新增 3 列：`account_id`、`transfer_to`、`transfer_to_name`；`type` 新增 `transfer` 取值（不计收支）
- **启动时自动迁移**（`migrateSchema`）：老库无需手工操作，重启即加列；推送侧对 transfer 做字段校验，配置推送按体积上限 200KB 截断保护
- 2026-10-18 已实际部署到 ECS 并验证：新旧列就位、journal 无错误、外网 healthz 正常

## 日常运维

```bash
systemctl status jizhang-api          # 状态
journalctl -u jizhang-api -f          # 实时日志
tail -f /opt/jizhang-api/data/server.log
systemctl restart jizhang-api         # 重启
node backup.js                         # 手动备份（cron 每日自动，保留 14 份）
certbot certificates                   # 查看证书到期日
nginx -t && systemctl reload nginx     # 改 nginx 后校验重载
```

- 数据库：`/opt/jizhang-api/data/jizhang.db`（SQLite，WAL 模式）
- 备份位置：`/opt/jizhang-api/data/backups/`
- 更换服务器：打包拷走 `data/` 目录即可完整迁移
- 端口：node 只听 127.0.0.1:3123，对外只暴露 nginx 的 443（80 仅 301 跳转 + 证书续期验证）

## 安全须知

- **AppSecret 只在服务器 `.env`（权限 600）**，绝不写进小程序代码、不提交 git——这是底线
- 同步接口全 token 鉴权，账本按成员鉴权，非成员推送被服务端丢弃
- node 服务不监听公网端口，外部只能到 nginx

## 常见问题

**Q：3Mbps 带宽够吗？**
够。记账是纯文本小 JSON，几人家庭使用峰值也就几 KB/s；SQLite 单机读写在 2C2G 上毫无压力。

**Q：中途断网了怎么办？**
离线优先设计：断网时正常记账存本机，恢复网络后自动补推送/补拉取，不会丢。

**Q：一方删了记录，对方会同步删除吗？**
会。删除以「墓碑」传播，两端最终一致。

**Q：两边同时改同一条记录？**
后写者胜（按 `updatedAt` LWW）。家庭场景极少冲突，且不会数据错乱。

**Q：不认证能用吗？**
个人主体注册免费即可开发预览；正式上线/长期使用需要完成年审认证（30 元/年），到期未认证会影响账号功能。

**Q：服务重启后数据会丢吗？**
不会。数据在 SQLite 文件里，与进程无关；且每日自动备份保留 14 份。

## 小程序代码上传（CLI 自动化，2026-10-19 跑通）

不打开界面，直接用命令行发布开发版本：

```bash
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
PROJ=/Users/wangweijie/WorkBuddy/2026-10-18-19-55-50/jizhang-miniapp

$CLI islogin --project "$PROJ"          # 确认已登录（返回 {"login":true}）
$CLI upload  --project "$PROJ" -v 1.0.0 -d "版本说明"
```

**前置：开启服务端口（一次性）**

真正的开关不是界面里的设置项，而是标记文件：

```bash
D="$HOME/Library/Application Support/微信开发者工具/d1e8765721a6c23d43b14c95b1843e6b/Default"
printf 'On' > "$D/.ide-status"
```

`Default` 目录路径用 `$CLI islogin --project "$PROJ" --debug` 查 `userDirPath` 得到。
**上传命令不要加 `--port`**：IDE 会自选端口，硬指定会报 "must be restarted on port xxx"。

**打包排除清单**（`project.config.json` → `packOptions.ignore`）

`,` 必须排除，否则编译器会把 Node 代码当小程序代码解析而报错：

```
tests/  server/  jizhang-data/  config.local.js  package.json  README.md
```

**编译器比 Node 严格，以下问题 `node --check` 查不出但上传必挂**：

| 问题 | 现象 | 修法 |
| --- | --- | --- |
| 顶层函数重名 | `the name xx is defined multiple times` | 删掉旧定义（非严格模式下 JS 不报错，容易漏） |
| 标签属性缺收尾 `">` | `unexpected character '"'` + 行列号 | 补上引号和尖括号 |
| WXML 里调用方法 | `unexpected token '.'` | 页面 JS 预计算字段，WXML 只做取值/三元/拼接 |

查行列号：上传报错不含文件名时，去
`~/Library/Application Support/微信开发者工具/<profile>/WeappLog/logs/<最新>.log`
搜 `task type:upload exec error`，后面会带 `File: pages/xxx.wxml`。
