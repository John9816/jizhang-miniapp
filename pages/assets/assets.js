const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

Page({
  data: {
    netWorthText: '0.00',
    netWorthAbs: '0.00',
    netWorthPositive: true,
    accounts: [],
    records: [],
    groups: [],
    showManage: false,
    editingId: '',
    editName: '',
    editType: 'cash',
    editInitial: '',
    accountTypes: []
  },

  onLoad() {
    this.setData({ accountTypes: u.ACCOUNT_TYPES })
    this.refresh()
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var s = db.assetSummary(ledger.id)
    var recs = db.recordsOf(ledger.id)
      .filter(function (r) { return r.type !== undefined && r.accountId })
      .sort(function (a, b) { return a.date < b.date ? 1 : -1 })
    var me = db.getMe()
    var accounts = db.accountsOf(ledger.id)
    var decorated = recs.map(function (r) {
      var accName = ''
      var i
      for (i = 0; i < accounts.length; i++) {
        if (accounts[i].id === r.accountId) accName = accounts[i].name || ''
      }
      var isTransfer = r.type === 'transfer'
      var toName = ''
      if (isTransfer) {
        for (i = 0; i < accounts.length; i++) {
          if (accounts[i].id === r.transferTo) toName = accounts[i].name || ''
        }
      }
      return {
        id: r.id,
        date: r.date,
        note: r.note,
        type: r.type,
        amount: r.amount,
        icon: isTransfer ? '🔀' : u.categoryIcon(r.type, r.category),
        categoryName: isTransfer ? ('转账至 ' + (toName || '其他账户')) : u.categoryName(r.type, r.category) + (accName ? ' · ' + accName : ''),
        amountText: u.signedText(r.amount, r.type),
        memberName: r.memberName,
        isOther: r.memberId !== me.id
      }
    })
    this.setData({
      netWorthText: s.netWorthText,
      netWorthAbs: s.netWorth < 0 ? u.formatCents(-s.netWorth) : s.netWorthText,
      netWorthPositive: s.netWorth >= 0,
      accounts: s.accounts,
      records: recs,
      groups: u.groupByDate(decorated)
    })
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  goTransfer() {
    wx.navigateTo({ url: '/pages/edit/edit?mode=transfer' })
  },

  openManage() {
    this.setData({ showManage: true, editingId: '', editName: '', editType: 'cash', editInitial: '' })
  },

  closeManage() {
    this.setData({ showManage: false })
  },

  editAccount(e) {
    var id = e.currentTarget.dataset.id
    var accounts = this.data.accounts
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].id === id) {
        // 初始余额存在原始账本配置里，这里从 db.accountsOf 拿
        var raw = db.accountsOf(db.currentLedger().id)
        var initial = 0
        for (var j = 0; j < raw.length; j++) {
          if (raw[j].id === id) initial = raw[j].initialBalance
        }
        this.setData({
          editingId: id,
          editName: accounts[i].name,
          editType: accounts[i].type,
          editInitial: initial > 0 ? (initial / 100).toFixed(2) : '0'
        })
        return
      }
    }
  },

  addAccount() {
    this.setData({ editingId: '', editName: '', editType: 'cash', editInitial: '0' })
  },

  onEditName(e) { this.setData({ editName: e.detail.value }) },
  onEditInitial(e) { this.setData({ editInitial: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') }) },
  setEditType(e) { this.setData({ editType: e.currentTarget.dataset.type }) },

  saveAccount() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var name = String(this.data.editName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入账户名称', icon: 'none' })
      return
    }
    var initial = u.yuanToCents(this.data.editInitial)
    var raw = db.accountsOf(ledger.id)
    if (this.data.editingId) {
      for (var i = 0; i < raw.length; i++) {
        if (raw[i].id === this.data.editingId) {
          raw[i].name = name.slice(0, 12)
          raw[i].type = this.data.editType
          raw[i].initialBalance = initial
          break
        }
      }
    } else {
      raw.push({
        id: u.genId('acc'),
        name: name.slice(0, 12),
        type: this.data.editType,
        initialBalance: initial,
        sortIndex: raw.length
      })
    }
    db.saveAccounts(ledger.id, raw)
    this.setData({ showManage: false })
    this.refresh()
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  removeAccount(e) {
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '删除账户',
      content: '删除后，该账户的历史记录仍会保留（显示为未知账户），确定删除吗？',
      confirmColor: '#F04646',
      success(r) {
        if (!r.confirm) return
        var ledger = db.currentLedger()
        if (!ledger) return
        var raw = db.accountsOf(ledger.id).filter(function (a) { return a.id !== id })
        db.saveAccounts(ledger.id, raw)
        self.setData({ showManage: false })
        self.refresh()
      }
    })
  },

  onRecordTap(e) {
    wx.navigateTo({ url: '/pages/edit/edit?id=' + e.currentTarget.dataset.id })
  }
})
