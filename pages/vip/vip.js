var cloud = require('../../utils/cloud.js')
var db = require('../../utils/db.js')
var vipProducts = require('../../utils/vip-products.js')
var vip = require('../../utils/vip.js')

Page({
  data: {
    vipOn: false,
    vip: false,
    product: null,
    benefits: [],
    buying: false,
    toast: ''
  },
  onShow: function () {
    this.refresh()
  },
  refresh: function () {
    var on = vip.featureEnabled()
    var p = vipProducts.products[0]
    // 开关关闭时只展示"敬请期待"，不暴露价格与购买入口
    this.setData({ vipOn: on, vip: db.isVip(), product: on ? p : null, benefits: vipProducts.benefits })
  },
  buy: function () {
    var that = this
    if (!this.data.vipOn) {
      wx.showToast({ title: '会员功能即将开放', icon: 'none' })
      return
    }
    if (this.data.buying) return
    this.setData({ buying: true, toast: '正在唤起支付…' })
    cloud.purchaseVip(this.data.product.id).then(function (r) {
      if (r.ok && r.vip) {
        that.setData({ vip: true, buying: false, toast: '开通成功，会员权益已生效' })
      } else if (r.ok && r.pending) {
        that.setData({ buying: false, toast: r.error || '支付受理中，稍后自动生效' })
        setTimeout(function () { that.refresh() }, 4000)
      } else if (r.needUpdate) {
        that.setData({ buying: false, toast: r.error || '请更新微信后重试' })
      } else {
        that.setData({ buying: false, toast: r.error || '开通失败，请重试' })
      }
    })
  }
})
