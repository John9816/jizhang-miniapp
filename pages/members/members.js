const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

Page({
  data: {
    me: { id: '', name: '' },
    ledger: null,
    members: [],
    showNickname: false,
    nicknameInput: ''
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
    var me = db.getMe()
    var ledger = db.currentLedger()
    var records = ledger ? db.recordsOf(ledger.id) : []
    var members = ledger ? u.memberStats(records, ledger.members).map(function (m) {
      return {
        id: m.id,
        name: m.name,
        count: m.count,
        income: m.income,
        expense: m.expense,
        incomeText: u.formatCents(m.income),
        expenseText: u.formatCents(m.expense),
        avatarChar: m.name ? m.name.charAt(0) : '友'
      }
    }) : []
    var meView = {
      id: me.id,
      name: me.name || '我',
      avatarChar: (me.name || '我').charAt(0)
    }
    this.setData({ me: meView, ledger: ledger, members: members })
  },

  openNickname() {
    this.setData({ showNickname: true, nicknameInput: this.data.me.name })
  },

  closeNickname() {
    this.setData({ showNickname: false })
  },

  onNicknameInput(e) {
    this.setData({ nicknameInput: e.detail.value })
  },

  confirmNickname() {
    db.setMyName(this.data.nicknameInput)
    this.setData({ showNickname: false })
    this.refresh()
    wx.showToast({ title: '昵称已更新', icon: 'success' })
  },

  leaveLedger() {
    var self = this
    wx.showModal({
      title: '退出账本',
      content: '将从你的账本列表移除，同账号其他设备会同步移除；其他成员的记录不受影响。确定退出吗？',
      confirmText: '退出',
      confirmColor: '#F04646',
      success(r) {
        if (r.confirm) {
          db.deleteLedger(self.data.ledger.id)
          self.refresh()
          wx.showToast({ title: '已退出', icon: 'success' })
        }
      }
    })
  }
})
