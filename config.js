/**
 * 全局配置。
 * cloud.enabled = true 时启用自部署后端同步（apiBase 指向你的 ECS）。
 *
 * 本地测试覆盖：可选地在同目录放一个 config.local.js，内容形如：
 *   module.exports = { cloud: { enabled: true, apiBase: 'http://127.0.0.1:3123' } }
 * 该文件不参与线上构建约定——上线前删掉它即可，本文件始终保持线上配置。
 */
var cloud = {
  enabled: true,
  apiBase: 'https://jizhang-api.751152.xyz'
}

// 会员功能开关：
//   false = 前端隐藏所有价格/购买入口与付费门控（审核期、或后台尚未开通虚拟支付时使用）；
//   true  = 正常展示会员中心与付费门控。
// 待 MP 后台开通虚拟支付 + 发布道具后，把这里改为 true 并重新上传，会员能力即原地上线（代码始终保留）。
var vipEnabled = false

try {
  var local = require('./config.local.js')
  if (local && local.cloud) {
    if (local.cloud.enabled !== undefined) cloud.enabled = local.cloud.enabled
    if (local.cloud.apiBase) cloud.apiBase = local.cloud.apiBase
  }
} catch (e) {
  // 没有 config.local.js 时忽略
}

module.exports = {
  cloud: cloud,
  vipEnabled: vipEnabled
}
