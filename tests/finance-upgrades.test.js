const assert = require('assert')
const calendar = require('../utils/date-calendar')
const analytics = require('../utils/advanced-stats')
const feb = calendar.grid('2024-02', '2024-02-29', '2024-02-02', '2024-03-01')
assert.equal(feb.length, 42)
assert.equal(feb[0].date, '2024-01-29')
assert.equal(feb.find(d => d.date === '2024-02-29').selected, true)
assert.equal(feb.find(d => d.date === '2024-02-01').disabled, true)
assert.equal(calendar.valid('2023-02-29'), false)
assert.equal(calendar.valid('2024-02-29'), true)
assert.equal(calendar.shiftMonth('2024-12', 1), '2025-01')
let definition
global.Component = d => { definition = d }
require('../components/date-picker/date-picker')
delete global.Component
const c = Object.assign({}, definition.methods, {properties:{value:'2024-02-29',start:'2020-01-01',end:'2035-12-31'},data:JSON.parse(JSON.stringify(definition.data)),setData(p){Object.assign(this.data,p)},events:[],triggerEvent(n,d){this.events.push({n,d})}})
global.wx = {hideKeyboard(){}}
c.open(); c.selectDay({currentTarget:{dataset:{date:'2024-02-20'}}}); c.close()
assert.equal(c.events.length,0, 'cancel must not mutate parent')
c.open();c.selectDay({currentTarget:{dataset:{date:'2024-02-21'}}});c.confirm()
assert.equal(c.events[0].d.value,'2024-02-21')
c.open();c.selectDay({currentTarget:{dataset:{date:'2040-01-01'}}});assert.equal(c.data.draft,'2024-02-29')
const records = [
 {date:'2024-02-02',type:'expense',category:'pet',amount:2500},
 {date:'2024-02-02',type:'expense',category:'food',amount:1500},
 {date:'2024-02-03',type:'income',amount:10000},
 {date:'2024-02-03',type:'transfer',amount:90000},
 {date:'2024-02-04',type:'expense',amount:20000,deleted:true},
 {date:'2024-03-01',type:'expense',amount:50000}
]
const result = analytics.build(records,'2024-02-01','2024-02-29','expense',k=>({name:k==='pet'?'宠物':k,icon:'●'}),'2024-02')
assert.equal(result.comparison.income,10000)
assert.equal(result.comparison.expense,4000)
assert.equal(result.comparison.savingsText,'60%')
assert.equal(result.ranking[0].name,'宠物')
assert.equal(result.ranking[0].pct,62.5)
assert.equal(result.calendar.filter(d=>d.amount>0).length,1)
assert.equal(result.calendar.find(d=>d.date==='2024-02-02').count,2)
assert.equal(analytics.build([], '2024-01-01','2024-12-31','expense',()=>({}),'2025-01').calendarMonth,'2024-12')
assert.equal(analytics.build([], '2024-02-01','2024-02-29','expense',()=>({}),'2024-02').comparison.savingsText,'暂无收入')
console.log('PASS calendar grid, date selection and advanced financial analytics')
