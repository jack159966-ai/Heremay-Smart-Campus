/* 每月自評列印 v1.1.0：純資料整理，分數均取自已存檔紀錄。 */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.SelfEvalPrintModel=api})(typeof globalThis!=='undefined'?globalThis:this,()=>{
'use strict';
function parse(term){if(!/^\d{4}-(02|08)$/.test(term))throw Error('學期格式錯誤');const [year,month]=term.split('-').map(Number);if(year<2000||year>2100)throw Error('年份超出範圍');return year*12+month-1}
function month(n){return Math.floor(n/12)+'-'+String(n%12+1).padStart(2,'0')}
function termFor(value){const [y,m]=value.split('-').map(Number);if(!Number.isInteger(y)||!Number.isInteger(m)||m<1||m>12)throw Error('月份格式錯誤');return (m===1?y-1:y)+'-'+(m>=2&&m<=7?'02':'08')}
function terms(from,to){const a=parse(from),b=parse(to);if(b<a)throw Error('結束學期不可早於開始學期');if(b-a>6*19)throw Error('一次最多列印20個學期');const result=[];for(let n=a;n<=b;n+=6)result.push(month(n));return result}
function months(term){const a=parse(term);return Array.from({length:6},(_,i)=>month(a+i))}
function label(term){const [y,m]=term.split('-').map(Number);return m===2?y+'年2～7月':y+'年8月～'+(y+1)+'年1月'}
function score(record,kind,index){if(!record||record.status==='草稿'||kind==='principal'&&record.status!=='已複檢')return '';const value=record[kind==='teacher'?'teacherScores':'principalScores']?.[index];return Number.isInteger(value)&&value>=1&&value<=5?String(value):''}
function total(record,kind){const values=Array.from({length:20},(_,i)=>score(record,kind,i));return values.every(Boolean)?String(values.reduce((s,n)=>s+Number(n),0)):''}
function build(records,banks,from,to){const pages=[];for(const term of terms(from,to)){const period=months(term),matched=records.filter(r=>period.includes(r.month)&&['已送出','已複檢'].includes(r.status));const versions=[...new Set(matched.map(r=>r.version))];if(!versions.length){pages.push({term,months:period,empty:true});continue}for(const version of versions){const bank=banks[version];if(!bank)throw Error('找不到題庫版本：'+version);const questions=bank.groups.flatMap(g=>g.items);if(questions.length!==20)throw Error('題庫題數不是20題：'+version);const selected=matched.filter(r=>r.version===version),byMonth=new Map();selected.forEach(r=>{if(byMonth.has(r.month))throw Error('同一月份出現重複紀錄，請先核對：'+r.month);byMonth.set(r.month,r)});pages.push({term,months:period,version,department:selected[0].department,questions,byMonth,split:versions.length>1,otherMonths:matched.filter(r=>r.version!==version).map(r=>r.month)})}}return pages}
return {terms,months,label,termFor,score,total,build};
});
