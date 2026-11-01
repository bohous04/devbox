import {createApp} from './api';
import {expect,test} from 'bun:test';
import {openDb,insertMetrics,insertWorkInterval,metricByAttr,metricDailyByAttr} from './db';
import {buildRange,buildWorkHours,type RangeStats,type WorkHours,PROMPT_CHARS,PROMPT_WAIT} from './aggregate';
const DAY=86400000;
function seed(){
  const db=openDb(':memory:');
  for(const [project,repo,scale,host] of [['app','web',1,'devbox'],['app','api',10,'mac'],['other','web',100,'mac']] as const){
    const attrs=JSON.stringify({project,repo,model:repo,'devbox.host':host,'user.account_uuid':repo,custom:repo});
    for(const ts of [-DAY+100,100,DAY+100]) insertMetrics(db,[
      {ts,session_id:null,name:'claude_code.cost.usage',value:scale,attrs},
      {ts,session_id:null,name:'claude_code.token.usage',value:scale*100,attrs},
      {ts,session_id:null,name:'claude_code.active_time.total',value:scale*3600,attrs},
      {ts,session_id:null,name:PROMPT_CHARS,value:scale*20,attrs},
      {ts,session_id:null,name:PROMPT_WAIT,value:scale*1000,attrs},
    ]);
    insertWorkInterval(db,{session_id:repo,project,repo,started_at:100,ended_at:1800100,seconds:scale*60,capped:1});
  }
  return db;
}
test('repository and project jointly scope every range dimension, preserving selector choices',()=>{
  const db=seed();const r=buildRange(db,0,2*DAY,'app','web');
  expect(r.repo).toBe('web');expect(r.repoOptions).toEqual(['api','web']);
  expect(r.projects.map(p=>p.project).sort()).toEqual(['app','other']);
  expect(r.totals).toEqual({cost:2,tokens:200,hours:2});
  expect(r.previous).toEqual({cost:1,tokens:100,hours:1});
  expect(r.daily.map(d=>[d.cost,d.tokens,d.hours])).toEqual([[1,100,1],[1,100,1]]);
  expect(r.hourly.reduce((n,h)=>n+h.cost,0)).toBe(2);
  expect(r.hourly.reduce((n,h)=>n+h.hours,0)).toBe(2);
  expect(r.models).toEqual([{model:'web',cost:2,tokens:200}]);
  expect(r.repos).toEqual([{repo:'web',cost:2,tokens:200}]);
  expect(r.hosts).toEqual([{key:'devbox',cost:2,tokens:200,hours:2}]);
  expect(r.hostsPrevious).toEqual([{key:'devbox',cost:1,tokens:100,hours:1}]);
  expect(r.accounts).toEqual([{key:'web',cost:2,tokens:200,hours:2}]);
  expect(r.dailyByHost).toEqual([{host:'devbox',days:r.daily}]);
  expect(r.prompts.chars).toEqual({count:2,avg:20,p50:20,p90:20});
  expect(r.prompts.waitMs).toEqual({count:2,avg:1000,p50:1000,p90:1000});
  expect(metricByAttr(db,'claude_code.cost.usage','$.custom',0,2*DAY,'app','web')).toEqual([{key:'web',sum:2}]);
  expect(metricDailyByAttr(db,'claude_code.cost.usage','$.custom',0,2*DAY,'app','web')).toEqual([{key:'web',bucket:0,sum:1},{key:'web',bucket:1,sum:1}]);
  db.close();
});
test('repository-only selection spans projects; unknown and SQL-like repository names are exact filters',()=>{
  const db=seed();expect(buildRange(db,0,2*DAY,null,'web').totals.cost).toBe(202);
  expect(buildRange(db,0,2*DAY,'app').totals.cost).toBe(22);
  for(const repo of ['missing',"web' OR 1=1 --"]){const r=buildRange(db,0,2*DAY,'app',repo);expect(r.totals.cost).toBe(0);expect(r.models).toEqual([]);expect(r.repoOptions).toEqual(['api','web']);}
  db.close();
});
test('work hours use the same project/repo intersection for totals, cap accounting and daily series',()=>{
  const db=seed();const r=buildWorkHours(db,0,2*DAY,'app','web');
  expect(r.totalHours).toBe(1/60);expect(r.byProject).toEqual([{project:'app',hours:1/60,cappedHours:1/60}]);
  expect(r.daily).toEqual([{day:0,hours:1/60},{day:DAY,hours:0}]);
  expect(buildWorkHours(db,0,2*DAY,null,'web').totalHours).toBe(101/60);
  expect(buildWorkHours(db,0,2*DAY,'app',"web' OR 1=1 --").totalHours).toBe(0);
  db.close();
});

test('range and work HTTP routes forward both filters and accept blank as all',async()=>{
  const db=seed();
  const a=createApp({db,mgr:{},cfg:{version:1,settings:{},folders:{}},root:'/tmp',tree:async()=>[],listener:{},notify:()=>{},stats:()=>({sessions:[],disk:{}}),cloneQueue:{},configRepo:{},dashboardDir:'/tmp'} as never);
  const scope=new URLSearchParams({from:'0',to:String(2*DAY),project:'app',repo:'web'});
  const range=await a.request('/api/stats/range?'+scope);expect(range.status).toBe(200);expect((await range.json() as RangeStats).totals.cost).toBe(2);
  const work=await a.request('/api/stats/work?'+scope);expect(work.status).toBe(200);expect((await work.json() as WorkHours).totalHours).toBe(1/60);
  scope.set('repo','  ');const all=await a.request('/api/stats/range?'+scope);expect((await all.json() as RangeStats).totals.cost).toBe(22);
  db.close();
});
