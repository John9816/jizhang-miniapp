const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')

Page({
  data: {
    ledger: null,
    ledgers: [],
    stats: { count: 0, income: 0, expense: 0, balance: 0, incomeText: '0.00', expenseText: '0.00', balanceText: '0.00' },
    memberCount: 0,
    showCreate: false,
    newName: '',
    showImport: false,
    importText: '',
    showRename: false,
    renameId: '',
    renameText: '',
    cloud: false,
    inviteCode: ''
  },

  onLoad() {
    this.refresh()
    var self = this
    this._offChange = db.onChange(function () { self.refresh() })
  },

  onUnload() {
    if (this._offChange) this._offChange()
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    var ledger = db.currentLedger()
    var stats = ledger ? db.statsOf(ledger.id) : { count: 0, income: 0, expense: 0, balance: 0 }
    this.setData({
      ledger: ledger,
      ledgers: db.listLedgers(),
      memberCount: ledger ? Object.keys(ledger.members).length : 0,
      cloud: cloud.enabled(),
      inviteCode: cloud.currentInviteCode(),
      stats: {
        count: stats.count,
        income: stats.income,
        expense: stats.expense,
        balance: stats.balance,
        incomeText: u.formatCents(stats.income),
        expenseText: u.formatCents(stats.expense),
        balanceText: u.formatCents(stats.balance)
      }
    })
  },

  /* ---------------- 账本切换与管理 ---------------- */

  switchLedger(e) {
    var id = e.currentTarget.dataset.id
    db.setCurrentLedger(id)
    this.refresh()
  },

  openCreate() {
    this.setData({ showCreate: true, newName: '' })
  },

  closeCreate() {
    this.setData({ showCreate: false })
  },

  onNewNameInput(e) {
    this.setData({ newName: e.detail.value })
  },

  confirmCreate() {
    var name = this.data.newName.trim()
    db.createLedger(name || '新账本')
    this.setData({ showCreate: false })
    this.refresh()
    wx.showToast({ title: '已创建', icon: 'success' })
  },

  openRename(e) {
    var id = e.currentTarget.dataset.id
    var name = e.currentTarget.dataset.name
    this.setData({ showRename: true, renameId: id, renameText: name })
  },

  closeRename() {
    this.setData({ showRename: false })
  },

  onRenameInput(e) {
    this.setData({ renameText: e.detail.value })
  },

  confirmRename() {
    db.renameLedger(this.data.renameId, this.data.renameText)
    this.setData({ showRename: false })
    this.refresh()
    wx.showToast({ title: '已重命名', icon: 'success' })
  },

  deleteLedger(e) {
    var id = e.currentTarget.dataset.id
    var name = e.currentTarget.dataset.name
    var self = this
    wx.showModal({
      title: '删除账本',
      content: '将同时删除本机上的「' + name + '」及其全部记录，且不可恢复。好友手机上的副本不受影响。',
      confirmText: '删除',
      confirmColor: '#F04646',
      success(r) {
        if (r.confirm) {
          db.deleteLedger(id)
          self.refresh()
          wx.showToast({ title: '已删除', icon: 'success' })
        }
      }
    })
  },

  /* ---------------- 分享与导入 ---------------- */

  copyInvite() {
    var code = this.data.inviteCode
    if (!code) {
      wx.showToast({ title: '邀请码首次同步后生成', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: code,
      success() {
        wx.showToast({ title: '邀请码已复制', icon: 'success' })
      }
    })
  },

  copySharePackage() {
    if (!this.data.ledger) return
    var code = db.sharePackage(this.data.ledger.id)
    if (!code) {
      wx.showToast({ title: '生成分享包失败', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: code,
      success() {
        wx.showToast({ title: '分享包已复制', icon: 'success' })
      }
    })
  },

  openImport() {
    this.setData({ showImport: true, importText: '' })
  },

  closeImport() {
    this.setData({ showImport: false })
  },

  onImportInput(e) {
    this.setData({ importText: e.detail.value })
  },

  pasteImport() {
    var self = this
    wx.getClipboardData({
      success(res) {
        if (res.data) {
          self.setData({ importText: res.data })
        } else {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' })
        }
      }
    })
  },

  confirmImport() {
    var text = this.data.importText.trim()
    if (!text) {
      wx.showToast({ title: this.data.cloud ? '请输入邀请码' : '请先粘贴分享包', icon: 'none' })
      return
    }
    if (this.data.cloud) {
      var self = this
      wx.showLoading({ title: '加入中', mask: true })
      cloud.joinLedger(text).then(function (res) {
        wx.hideLoading()
        self.setData({ showImport: false })
        if (!res.ok) {
          wx.showToast({ title: res.error, icon: 'none' })
          return
        }
        self.refresh()
        wx.showToast({ title: '已加入账本', icon: 'success' })
      })
      return
    }
    var result = db.importSharePackage(text)
    if (!result.ok) {
      wx.showToast({ title: result.error, icon: 'none' })
      return
    }
    this.setData({ showImport: false })
    this.refresh()
    wx.showToast({ title: '已导入 ' + result.added + ' 条记录', icon: 'success' })
  },

  /* ---------------- 导出 CSV ---------------- */

  exportCSV() {
    if (!this.data.ledger) return
    var csv = db.exportCSV(this.data.ledger.id)
    if (!csv) {
      wx.showToast({ title: '没有可导出的记录', icon: 'none' })
      return
    }
    var count = csv.split('\n').length - 2
    var self = this
    wx.showActionSheet({
      itemList: ['复制 CSV 内容（可粘贴到表格）', '发送给微信好友'],
      success(res) {
        if (res.tapIndex === 0) {
          wx.setClipboardData({
            data: csv,
            success() { wx.showToast({ title: '已复制 ' + count + ' 条', icon: 'success' }) }
          })
        } else if (res.tapIndex === 1) {
          // 通过聊天记录分享 CSV 文本
          wx.setClipboardData({
            data: csv,
            success() {
              wx.showToast({ title: '已复制，去聊天框粘贴发送', icon: 'none' })
            }
          })
        }
      }
    })
  },

  onShareAppMessage() {
    var name = this.data.ledger ? this.data.ledger.name : '记账本'
    return {
      title: '我的账本「' + name + '」，一起来记账',
      path: '/pages/index/index'
    }
  }
})
