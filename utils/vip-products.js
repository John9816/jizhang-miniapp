/**
 * 会员商品展示目录（仅前端展示用）。
 * 真实价格以后端 .env（VPAY_PRODUCT_VIP / VPAY_PRODUCT_VIP_PRICE）为准，
 * 下单时前端只传 productId，后端负责按官方价格签名，避免前端篡改金额。
 *
 * 注意：productId 必须与后端白名单、MP 后台道具 ID 三者一致。
 */
var products = [
  {
    id: 'vip_perm',
    name: '永久会员',
    priceYuan: 30,
    period: '永久有效',
    tag: '一次买断',
    desc: '买断制，永久解锁全部会员权益，无续费'
  }
]

var benefits = [
  { icon: '🚫', title: '去除广告', desc: '记账界面纯净，无任何广告打扰' },
  { icon: '📒', title: '账本与成员不限', desc: '账本数量、每本成员数不再受限' },
  { icon: '📤', title: 'Excel / PDF 导出', desc: '解锁全量数据导出，方便备份与报税' },
  { icon: '📊', title: '高级统计图表', desc: '解锁更丰富的收支可视化分析' },
  { icon: '🧾', title: '账单导入与对账', desc: '解锁微信/支付宝流水导入与智能对账' }
]

module.exports = {
  products: products,
  benefits: benefits,
  productById: function (id) {
    for (var i = 0; i < products.length; i++) if (products[i].id === id) return products[i]
    return null
  }
}
