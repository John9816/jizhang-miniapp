var u = require('./util')
var cal = require('./date-calendar')
function build(records, start, end, type, resolveCategory, month) {
  var list = records.filter(function(r){return !r.deleted && (r.type==='income'||r.type==='expense') && r.date>=start && r.date<=end})
  var income=0, expense=0, categories={}, byDay={}, maxDay=0
  list.forEach(function(r){
    if(r.type==='income') income+=r.amount; else expense+=r.amount
    if(r.type!==type)return
    var key=r.category||'other'
    if(!categories[key]) categories[key]={key:key,amount:0,count:0}
    categories[key].amount+=r.amount;categories[key].count++
    if(!byDay[r.date])byDay[r.date]={amount:0,count:0}
    byDay[r.date].amount+=r.amount;byDay[r.date].count++
    maxDay=Math.max(maxDay,byDay[r.date].amount)
  })
  var total=type==='income'?income:expense
  var ranking=Object.keys(categories).map(function(k){
    var c=categories[k],info=resolveCategory(k)||{}
    return Object.assign({},c,{name:info.name||'其他',icon:info.icon||'●',amountText:u.formatCents(c.amount),pct:total?Math.round(c.amount/total*1000)/10:0})
  }).sort(function(a,b){return b.amount-a.amount||a.key.localeCompare(b.key)})
  var top=ranking.length?ranking[0].amount:0
  ranking.forEach(function(c,i){c.rank=i+1;c.width=top?Math.max(1,c.amount/top*100):0})
  month=month||end.slice(0,7)
  if(month<start.slice(0,7))month=start.slice(0,7)
  if(month>end.slice(0,7))month=end.slice(0,7)
  var cells=cal.grid(month,'',start,end).map(function(d){
    var v=byDay[d.date]||{amount:0,count:0}
    return Object.assign({},d,{amount:v.amount,count:v.count,amountText:u.formatCents(v.amount),level:!v.amount?0:Math.min(4,Math.ceil(v.amount/(maxDay||1)*4))})
  })
  var max=Math.max(income,expense,1)
  var monthly=(u.parseDate(end)-u.parseDate(start))/86400000>31, series=[], grouped={}
  for(var cursor=start;cursor<=end;cursor=monthly?cal.shiftMonth(cursor.slice(0,7),1)+'-01':u.addDays(cursor,1)) {
    var key=monthly?cursor.slice(0,7):cursor
    var point={key:key,label:monthly?key.slice(2).replace('-','/'):key.slice(5).replace('-','/'),income:0,expense:0}
    grouped[key]=point;series.push(point)
  }
  list.forEach(function(r){var p=grouped[monthly?r.date.slice(0,7):r.date];if(p)p[r.type]+=r.amount})
  var seriesMax=1;series.forEach(function(p){seriesMax=Math.max(seriesMax,p.income,p.expense)})
  series.forEach(function(p){p.incomeHeight=p.income/seriesMax*100;p.expenseHeight=p.expense/seriesMax*100;p.incomeText=u.formatCents(p.income);p.expenseText=u.formatCents(p.expense)})
  return {ranking:ranking,series:series,seriesUnit:monthly?'按月':'按日',calendar:cells,calendarMonth:month,calendarLabel:month.slice(0,4)+'年'+Number(month.slice(5))+'月',calendarPrev:month>start.slice(0,7),calendarNext:month<end.slice(0,7),comparison:{income:income,expense:expense,incomeText:u.formatCents(income),expenseText:u.formatCents(expense),balanceText:u.formatCents(income-expense),incomeWidth:income/max*100,expenseWidth:expense/max*100,savingsText:income?Math.round((income-expense)/income*100)+'%':'暂无收入',count:list.length}}
}
module.exports={build:build}
