/**
 * 会员功能总开关（前端展示层）。
 *
 * 作用：在「后台尚未开通虚拟支付 / 版本送审」阶段，把会员相关的
 *   - 价格标签、购买按钮、开通引导（"去开通"等）
 *   - 付费门控（账本上限、导入上限、导出/海报拦截）
 * 全部收口隐藏，使提审包里不存在任何"货架价格 / 购买路径"，符合微信审核规范。
 *
 * 注意：这只是「前端展示开关」。会员的支付、发货、权益判定等核心代码
 * （utils/cloud.js 的 purchaseVip / 后端 server.js 的 pay/order/notify 等）
 * 一律保留不动；待 config.vipEnabled 翻为 true 并重新上传后，会员能力原地上线。
 */

var cfg = require('../config.js')

/** 会员前端能力是否可见。false 时前端不展示任何购买入口与付费门控。 */
function featureEnabled() {
  return !!(cfg && cfg.vipEnabled === true)
}

module.exports = {
  featureEnabled: featureEnabled
}
