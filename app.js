const db = require('./utils/db.js')

App({
  onLaunch() {
    // 初始化本地数据层：身份、默认账本
    db.init()
    // 云端同步（config.js 中 cloud.enabled = true 时生效）
    require('./utils/cloud.js').init()
  },

  onShow() {
    // 切回前台：拉取云端增量
    require('./utils/cloud.js').onAppShow()
  },

  globalData: {}
})
