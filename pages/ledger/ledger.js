const db = require('../../utils/db.js')
const cloud = require('../../utils/cloud.js')
const u = require('../../utils/util.js')
const vip = require('../../utils/vip.js')
const csvExport = require('../../utils/csvExport.js')

Page({
  data: {
    ledger: null,
    ledgers: [],
    stats: { count: 0, income: 0, expense: 0, balance: 0, incomeText: '0.00', expenseText: '0.00', balanceText: '0.00' },
    memberCount: 0,
    showCreate: false,
    newName: '',
    newCover: { kind: 'preset', key: 'default' },
    showImport: false,
    importText: '',
    showRename: false,
    renameId: '',
    renameText: '',
    renameCover: { kind: 'preset', key: 'default' },
    currentCover: { kind: 'preset', key: 'default' },
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
      currentCover: u.ledgerCoverInfo(ledger && ledger.cover),
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

  goMembers() { wx.navigateTo({ url: '/pages/members/members' }) },

  switchLedger(e) {
    var id = e.currentTarget.dataset.id
    db.setCurrentLedger(id)
    this.refresh()
  },

  openCreate() {
    this.setData({ showCreate: true, newName: '', newCover: { kind: 'preset', key: 'default' } })
  },

  closeCreate() {
    this.setData({ showCreate: false })
  },

  onNewNameInput(e) {
    this.setData({ newName: e.detail.value })
  },

  onCreateCoverChange(e) {
    var cover = e.detail && e.detail.cover
    if (cover) this.setData({ newCover: cover })
  },

  confirmCreate() {
    var name = this.data.newName.trim()
    if (vip.featureEnabled() && !db.isVip() && db.listLedgers().length >= 2) {
      wx.showModal({
        title: '账本数量已达上限',
        content: '免费版最多创建 2 个账本，升级会员后可无限创建并解除成员上限。',
        confirmText: '去开通',
        cancelText: '知道了',
        success: function (r) { if (r.confirm) wx.navigateTo({ url: '/pages/vip/vip' }) }
      })
      return
    }
    db.createLedger(name || '新账本', this.data.newCover)
    this.setData({ showCreate: false })
    this.refresh()
    wx.showToast({ title: '已创建', icon: 'success' })
  },

  openRename(e) {
    var id = e.currentTarget.dataset.id
    var name = e.currentTarget.dataset.name
    var l = db.getLedger(id)
    this.setData({
      showRename: true,
      renameId: id,
      renameText: name,
      renameCover: u.ledgerCoverInfo(l && l.cover)
    })
  },

  closeRename() {
    this.setData({ showRename: false })
  },

  onRenameInput(e) {
    this.setData({ renameText: e.detail.value })
  },

  onRenameCoverChange(e) {
    var cover = e.detail && e.detail.cover
    if (cover) this.setData({ renameCover: cover })
  },

  confirmRename() {
    var id = this.data.renameId
    db.renameLedger(id, this.data.renameText)
    // 封面有变化才写库（setLedgerCover 会刷新 cfgAt，无谓的写入会放大同步包）
    var want = u.ledgerCoverInfo(this.data.renameCover)
    var now = u.ledgerCoverInfo(db.getLedger(id) && db.getLedger(id).cover)
    if (JSON.stringify(want) !== JSON.stringify(now)) {
      db.setLedgerCover(id, this.data.renameCover)
    }
    this.setData({ showRename: false })
    this.refresh()
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  deleteLedger(e) {
    var id = e.currentTarget.dataset.id
    var name = e.currentTarget.dataset.name
    var self = this
    wx.showModal({
      title: '删除账本',
      content: '将从你的账本列表移除「' + name + '」及本机记录。开启云同步时，同账号其他设备也会移除，其他成员不受影响。删除最后一个账本后会保留一个空白账本。',
      confirmText: '删除',
      confirmColor: '#D65A45',
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
    if (vip.featureEnabled() && !db.isVip()) {
      wx.showModal({
        title: '导出为会员功能',
        content: '升级会员后可解锁 CSV 数据导出，方便用表格查看和整理。',
        confirmText: '去开通',
        cancelText: '知道了',
        success: function (r) { if (r.confirm) wx.navigateTo({ url: '/pages/vip/vip' }) }
      })
      return
    }
    var csv = db.exportCSV(this.data.ledger.id)
    if (!csv) {
      wx.showToast({ title: '没有可导出的记录', icon: 'none' })
      return
    }
    return csvExport.show({ csv: csv, name: this.data.ledger.name, count: db.recordsOf(this.data.ledger.id).length })
  },

  onShareAppMessage() {
    var name = this.data.ledger ? this.data.ledger.name : '记账本'
    return {
      title: '我的账本「' + name + '」，一起来记账',
      path: '/pages/index/index'
    }
  }
})
