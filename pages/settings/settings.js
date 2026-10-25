const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')

Page({
  data: { account: {}, syncText: '', cloudOn: false, ledgerCount: 0, recordCount: 0, deletedCount: 0, syncing: false },
  onLoad() {
    this.refresh()
    this._offDb = db.onChange(() => this.refresh())
    this._offCloud = cloud.onChange(() => this.refresh())
  },
  onShow() { this.refresh() },
  onUnload() {
    if (this._offDb) this._offDb()
    if (this._offCloud) this._offCloud()
  },
  refresh() {
    const ledgers = db.listLedgers()
    this.setData({
      account: cloud.accountState(), cloudOn: cloud.enabled(), syncText: cloud.statusText(),
      ledgerCount: ledgers.length,
      deletedCount: db.deletedRecordsOf().length,
      recordCount: ledgers.reduce((count, ledger) => count + db.recordsOf(ledger.id).length, 0)
    })
  },
  goRecycle() { wx.navigateTo({ url: '/pages/recycle/recycle' }) },
  syncNow() {
    if (this.data.syncing || !cloud.enabled()) return
    this.setData({ syncing: true })
    const action = this.data.account.phase === 'failed' ? cloud.retry() : cloud.sync()
    action.then(() => {
      this.setData({ syncing: false })
      this.refresh()
      const error = cloud.accountState().error
      wx.showToast({ title: error ? '同步失败，请稍后重试' : '同步完成', icon: error ? 'none' : 'success' })
    }).catch(() => {
      this.setData({ syncing: false })
      wx.showToast({ title: '同步失败，请稍后重试', icon: 'none' })
    })
  }
})
