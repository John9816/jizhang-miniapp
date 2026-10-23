const db = require('../../utils/db.js')
const u = require('../../utils/util.js')

/** 快捷预设：居家固定开销 + 工资/房租，点击即带入添加弹层（周期每月） */
var PRESETS = [
  { key: 'water', name: '水费', icon: '💧', type: 'expense', category: 'water' },
  { key: 'electric', name: '电费', icon: '⚡', type: 'expense', category: 'electric' },
  { key: 'gas', name: '燃气费', icon: '🔥', type: 'expense', category: 'gas' },
  { key: 'property', name: '物业费', icon: '🏢', type: 'expense', category: 'property' },
  { key: 'phonebill', name: '话费', icon: '📞', type: 'expense', category: 'phonebill' },
  { key: 'rent', name: '房租', icon: '🏠', type: 'expense', category: 'home' },
  { key: 'salary', name: '工资', icon: '💰', type: 'income', category: 'salary' }
]

/** 预设默认下次执行日：当月 1 日未过则当月 1 日，否则次月 1 日 */
function presetNextDate() {
  var d = new Date()
  var first = new Date(d.getFullYear(), d.getMonth(), 1)
  if (u.dateStr(d) > u.dateStr(first)) first = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  return u.dateStr(first)
}

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
    formAccount: '',
    presets: PRESETS
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

  /** 快捷预设：带入类型/名称/分类/周期，金额留空待填，下次执行日默认月度 1 日 */
  usePreset(e) {
    var p = PRESETS[e.currentTarget.dataset.idx]
    if (!p) return
    var ledger = db.currentLedger()
    var cats = db.categoriesOf(ledger ? ledger.id : '', p.type)
    // 账本若启用了自定义分类，预设 key 可能不在其中：沿用 edit 页策略回退首个分类
    var valid = false
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].key === p.category) { valid = true; break }
    }
    this.setData({
      showAdd: true,
      formName: p.name,
      formAmount: '',
      formType: p.type,
      formCategory: valid ? p.category : (cats[0] ? cats[0].key : 'other_out'),
      formCycle: 'monthly',
      formDate: presetNextDate(),
      formAccount: '',
      categories: cats
    })
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
