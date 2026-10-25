const db = require('../../utils/db.js')
const u = require('../../utils/util.js')
const recordView = require('../../utils/record-view.js')

Page({
  data: {
    netWorthText: '0.00',
    netWorthAbs: '0.00',
    netWorthPositive: true,
    totalAssetsText: '0.00', totalDebtText: '0.00', debtRatio: '0%',
    selectedAccount: '', selectedAccountName: '全部账户', balanceMode: 'initial',
    accounts: [],
    records: [],
    groups: [],
    showManage: false,
    editingId: '',
    editName: '',
    editType: 'cash',
    editIsFixed: false,
    editInitial: '',
    accountTypes: [],
    defaultAccountId: ''
  },

  onLoad() {
    this.setData({ accountTypes: u.ACCOUNT_TYPES })
    this.refresh()
  },

  onShow() {
    this.refresh()
    if (!this._offChange) this._offChange = db.onChange(() => this.refresh())
  },

  onHide() { if (this._offChange) this._offChange(); this._offChange = null },
  onUnload() { this.onHide() },

  refresh() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var s = db.assetSummary(ledger.id)
    var selected = this.data.selectedAccount
    if (this._flowLedgerId !== ledger.id || !s.accounts.some(function(a){return a.id === selected})) selected = ''
    this._flowLedgerId = ledger.id
    var totalAssets = 0, totalDebt = 0
    s.accounts.forEach(function(a){if(a.balance >= 0) totalAssets += a.balance; else totalDebt -= a.balance})
    var recs = db.recordsOf(ledger.id)
      .filter(function (r) { return r.type !== undefined && (r.accountId || r.transferTo) && (!selected || r.accountId === selected || (r.type === 'transfer' && r.transferTo === selected)) })
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
      var category = recordView.categoryInfo(ledger.id, r.type, r.category)
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
        icon: isTransfer ? '↔' : category.icon,
        categoryName: isTransfer ? (selected && r.transferTo === selected ? '转入自 ' + (accName || '已删除账户') : '转账至 ' + (toName || '已删除账户')) : category.name + (accName ? ' · ' + accName : ''),
        amountText: isTransfer ? (selected ? (r.transferTo === selected ? '+' : '−') : '') + u.formatCents(r.amount) : u.signedText(r.amount, r.type),
        memberName: r.memberName,
        isOther: r.memberId !== me.id
      }
    })
    this.setData({
      netWorthText: s.netWorthText,
      netWorthAbs: s.netWorth < 0 ? u.formatCents(-s.netWorth) : s.netWorthText,
      netWorthPositive: s.netWorth >= 0,
      totalAssetsText: u.formatCents(totalAssets), totalDebtText: u.formatCents(totalDebt),
      debtRatio: totalAssets ? Math.round(totalDebt / totalAssets * 100) + '%' : (totalDebt ? '暂无资产' : '0%'),
      selectedAccount: selected, selectedAccountName: selected ? s.accounts.find(function(a){return a.id===selected}).name : '全部账户',
      accounts: s.accounts.map(function (a) { return Object.assign({}, a, { balanceAbsText: u.formatCents(Math.abs(a.balance)) }) }),
      groups: s.groups.map(function (g) {
        return Object.assign({}, g, { accounts: g.accounts.map(function (a) {
          return Object.assign({}, a, { balanceAbsText: u.formatCents(Math.abs(a.balance)) })
        }) })
      }),
      records: recs,
      recordGroups: u.groupByDate(decorated),
      defaultAccountId: db.defaultAccountOf(ledger.id)
    })
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/edit/edit' })
  },

  filterAccount(e) { this.setData({selectedAccount: e.currentTarget.dataset.id || ''}); this.refresh() },

  calibrateAccount(e) {
    this.editAccount(e)
    var account = this.data.accounts.find(function(a){return a.id===e.currentTarget.dataset.id})
    if (!account) return
    this.setData({balanceMode:'current',editInitial:(account.balance/100).toFixed(2)})
  },

  goTransfer() {
    wx.navigateTo({ url: '/pages/edit/edit?mode=transfer' })
  },

  openManage() {
    this._manageLedgerId = (db.currentLedger() || {}).id
    this.setData({ showManage: true, balanceMode:'initial', editingId: '', editName: '', editType: 'cash', editIsFixed: false, editInitial: '' })
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
          showManage: true,
          balanceMode: 'initial',
          editingId: id,
          editName: accounts[i].name,
          editType: accounts[i].type,
          editIsFixed: !!accounts[i].isFixed,
          editInitial: (initial / 100).toFixed(2)
        })
        this._manageLedgerId = db.currentLedger().id
        return
      }
    }
  },

  addAccount() {
    this.openManage()
  },

  onEditName(e) { this.setData({ editName: e.detail.value }) },
  onEditInitial(e) { this.setData({ editInitial: String(e.detail.value == null ? '' : e.detail.value) }) },
  toggleBalanceSign() {
    var value = this.data.editInitial || '0'
    this.setData({ editInitial: value.charAt(0) === '-' ? value.slice(1) : '-' + value })
  },
  setEditType(e) {
    if (this.data.balanceMode === 'current') return
    var type = e.currentTarget.dataset.type
    this.setData({ editType: type, editIsFixed: u.accountIsFixed(type) })
  },

  saveAccount() {
    var ledger = this._manageLedgerId ? db.getLedger(this._manageLedgerId) : db.currentLedger()
    if (!ledger) { wx.showToast({ title: '账本不存在，请返回查看', icon: 'none' }); return }
    var name = String(this.data.editName || '').trim()
    if (!name) {
      wx.showToast({ title: '请输入账户名称', icon: 'none' })
      return
    }
    var value = String(this.data.editInitial || '0').trim()
    if (!/^-?\d+(\.\d{0,2})?$/.test(value) || Math.abs(Number(value)) > 999999999) {
      wx.showToast({ title: '请输入有效金额，最多两位小数', icon: 'none' })
      return
    }
    var initial = (value.charAt(0) === '-' ? -1 : 1) * u.yuanToCents(value.replace(/^-/, ''))
    var raw = db.accountsOf(ledger.id).map(function (a) { return Object.assign({}, a) })
    if (this.data.editingId) {
      if (!raw.some((a) => a.id === this.data.editingId)) {
        wx.showToast({ title: '账户不存在，请重新打开', icon: 'none' })
        return
      }
      for (var i = 0; i < raw.length; i++) {
        if (raw[i].id === this.data.editingId) {
          raw[i].name = name.slice(0, 12)
          if (this.data.balanceMode === 'current') {
            // 以保存时的流水为准；校准余额不伪造收入或支出。
            raw[i].initialBalance = (Number(raw[i].initialBalance) || 0) + initial - u.accountBalance(raw[i], db.recordsOf(ledger.id))
          } else {
            raw[i].type = this.data.editType
            raw[i].initialBalance = initial
          }
          break
        }
      }
    } else {
      var newId = u.genId('acc')
      raw.push({
        id: newId,
        name: name.slice(0, 12),
        type: this.data.editType,
        initialBalance: initial,
        sortIndex: raw.length
      })
      // 第一个账户自动设为默认：之后记账无需每次手动选账户
      if (raw.length === 1 && !u.accountIsFixed(this.data.editType) && !db.defaultAccountOf(ledger.id)) {
        db.setDefaultAccount(ledger.id, newId)
      }
    }
    db.saveAccounts(ledger.id, raw)
    this.setData({ showManage: false })
    this.refresh()
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  /**
   * 设为/取消默认记账账户。默认账户在「记一笔」新建记录时自动预选。
   * 固定资产（房产/车产）不能设为默认——不参与日常记账选择。
   */
  toggleDefault(e) {
    var id = e.currentTarget.dataset.id
    var ledger = this._manageLedgerId ? db.getLedger(this._manageLedgerId) : db.currentLedger()
    if (!ledger || !id) return
    var next = this.data.defaultAccountId === id ? '' : id
    db.setDefaultAccount(ledger.id, next)
    this.refresh()
    wx.showToast({ title: next ? '已设为默认账户' : '已取消默认', icon: 'success' })
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
        var ledger = self._manageLedgerId ? db.getLedger(self._manageLedgerId) : db.currentLedger()
        if (!ledger) return
        var raw = db.accountsOf(ledger.id).filter(function (a) { return a.id !== id })
        db.saveAccounts(ledger.id, raw)
        // 删除的正是默认账户时联动取消，避免预选失效账户
        if (db.defaultAccountOf(ledger.id) === id) db.setDefaultAccount(ledger.id, '')
        self.setData({ showManage: false })
        self.refresh()
      }
    })
  },

  onRecordTap(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + encodeURIComponent(e.currentTarget.dataset.id) })
  }
})
