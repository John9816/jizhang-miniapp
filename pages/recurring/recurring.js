const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

Page({
  data: {
    rules: [],
    showAdd: false,
    formName: '',
    formAmount: '',
    formType: 'expense',
    formCategory: 'food',
    formCycle: 'monthly',
    formDate: '',
    categories: [],
    cycles: u.RECUR_CYCLES,
    accounts: [],
    formAccount: ''
  },

  onLoad() {
    this.refresh()
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var rules = db.recurringList(ledger.id).map(function (r) {
      return {
        id: r.id,
        name: r.name,
        amount: r.amount,
        amountText: u.formatCents(r.amount),
        type: r.type,
        category: r.category,
        categoryName: u.categoryName(r.type, r.category),
        categoryIcon: u.categoryIcon(r.type, r.category),
        cycle: r.cycle,
        cycleName: u.recurCycleName(r.cycle),
        nextDate: r.nextDate,
        paused: !!r.paused
      }
    })
    this.setData({
      rules: rules,
      categories: db.categoriesOf(ledger.id, this.data.formType),
      accounts: db.accountsOf(ledger.id).map(function (a) {
        return { id: a.id, name: a.name, icon: u.accountTypeInfo(a.type).icon }
      })
    })
  },

  openAdd() {
    this.setData({
      showAdd: true,
      formName: '',
      formAmount: '',
      formType: 'expense',
      formCategory: 'food',
      formCycle: 'monthly',
      formDate: u.dateStr(new Date()),
      formAccount: ''
    })
    var ledger = db.currentLedger()
    if (ledger) this.setData({ categories: db.categoriesOf(ledger.id, 'expense') })
  },

  closeAdd() {
    this.setData({ showAdd: false })
  },

  setFormType(e) {
    var type = e.currentTarget.dataset.type
    var ledger = db.currentLedger()
    this.setData({ formType: type, formCategory: db.categoriesOf(ledger ? ledger.id : '', type)[0].key })
    if (ledger) this.setData({ categories: db.categoriesOf(ledger.id, type) })
  },

  setFormCategory(e) {
    this.setData({ formCategory: e.currentTarget.dataset.key })
  },

  setFormCycle(e) {
    this.setData({ formCycle: e.currentTarget.dataset.key })
  },

  setFormAccount(e) {
    this.setData({ formAccount: e.currentTarget.dataset.id })
  },

  onFormName(e) { this.setData({ formName: e.detail.value }) },
  onFormAmount(e) { this.setData({ formAmount: String(e.detail.value == null ? '' : e.detail.value).replace(/[^\d.]/g, '') }) },
  onFormDate(e) { this.setData({ formDate: e.detail.value }) },

  saveRule() {
    var ledger = db.currentLedger()
    if (!ledger) return
    var cents = u.yuanToCents(this.data.formAmount)
    if (cents <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    db.addRecurring(ledger.id, {
      name: this.data.formName,
      amount: cents,
      type: this.data.formType,
      category: this.data.formCategory,
      accountId: this.data.formAccount,
      cycle: this.data.formCycle,
      nextDate: this.data.formDate,
      note: ''
    })
    this.setData({ showAdd: false })
    this.refresh()
    wx.showToast({ title: '已添加', icon: 'success' })
  },

  toggleRule(e) {
    var id = e.currentTarget.dataset.id
    var ledger = db.currentLedger()
    if (!ledger) return
    db.toggleRecurring(ledger.id, id)
    this.refresh()
  },

  runNow(e) {
    var id = e.currentTarget.dataset.id
    var ledger = db.currentLedger()
    if (!ledger) return
    // 把 nextDate 设为今天，再跑一次到期执行
    var rules = db.recurringList(ledger.id)
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].id === id) {
        // 直接借道：写一条相同内容的记录
        var rec = db.addRecord({
          ledgerId: ledger.id,
          type: rules[i].type,
          amount: rules[i].amount,
          category: rules[i].category,
          accountId: rules[i].accountId,
          date: u.dateStr(new Date()),
          note: rules[i].name
        })
        if (rec) {
          wx.showToast({ title: '已记一笔', icon: 'success' })
          this.refresh()
        }
        return
      }
    }
  },

  removeRule(e) {
    var id = e.currentTarget.dataset.id
    var name = e.currentTarget.dataset.name
    var self = this
    wx.showModal({
      title: '删除周期规则',
      content: '删除「' + name + '」后不再自动记账，已生成的记录保留。确定吗？',
      confirmColor: '#F04646',
      success(r) {
        if (!r.confirm) return
        var ledger = db.currentLedger()
        if (!ledger) return
        db.removeRecurring(ledger.id, id)
        self.refresh()
      }
    })
  }
})
