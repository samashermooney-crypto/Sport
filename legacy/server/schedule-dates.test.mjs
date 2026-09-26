import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleDateBounds,matchesScheduleDate,scheduleDateGroup,localDateKey} from '../src/schedule-dates.ts';
process.env.TZ='America/Chicago';
const today=new Date(2026,8,9,16);
const keys=b=>[localDateKey(b.start),localDateKey(b.end)];
test('date presets respect calendar weeks and calendar month boundaries',()=>{
 assert.deepEqual(keys(scheduleDateBounds('Today',today,0,'','')),['2026-09-09','2026-09-10']);
 assert.deepEqual(keys(scheduleDateBounds('Today & Tomorrow',today,0,'','')),['2026-09-09','2026-09-11']);
 assert.deepEqual(keys(scheduleDateBounds('This Week',today,1,'','')),['2026-09-07','2026-09-14']);
 assert.deepEqual(keys(scheduleDateBounds('Next Week',today,0,'','')),['2026-09-13','2026-09-20']);
 assert.deepEqual(keys(scheduleDateBounds('This Month',today,0,'','')),['2026-09-01','2026-10-01']);
 assert.deepEqual(keys(scheduleDateBounds('Next 6 Months',new Date(2026,7,31),0,'','')),['2026-08-31','2027-02-28']);
 assert.deepEqual(keys(scheduleDateBounds('Next 12 Months',new Date(2024,1,29),0,'','')),['2024-02-29','2025-02-28']);
});
test('custom range includes the full final day but excludes the next day',()=>{
 const preset='Custom Date Range',bounds=scheduleDateBounds(preset,today,0,'2026-09-01','2026-09-09');
 assert.equal(matchesScheduleDate(new Date(2026,8,9,23,59,59).toISOString(),preset,bounds),true);
 assert.equal(matchesScheduleDate(new Date(2026,8,10).toISOString(),preset,bounds),false);
 assert.equal(matchesScheduleDate(new Date(2026,7,31,23,59,59).toISOString(),preset,bounds),false);
 for(const [from,to] of [['2026-09-10','2026-09-09'],['2026-02-30','2026-03-01'],['','2026-09-09']]) assert.equal(scheduleDateBounds(preset,today,0,from,to),null);
});
test('daily windows retain local midnight boundaries across daylight saving changes',()=>{
 const bounds=scheduleDateBounds('Today',new Date(2026,2,8,12),0,'','');
 assert.equal((bounds.end-bounds.start)/3600000,23);
 assert.equal(matchesScheduleDate(new Date(2026,2,8,23,59).toISOString(),'Today',bounds),true);
 assert.equal(matchesScheduleDate(new Date(2026,2,9).toISOString(),'Today',bounds),false);
});
test('month and fortnight groups are stable across month, year, and DST boundaries',()=>{
 assert.deepEqual(scheduleDateGroup(new Date(2026,8,9).toISOString(),'Month',1,today),{key:'2026-09-01',label:'September 2026'});
 const anchor=new Date(2026,2,2);
 assert.equal(scheduleDateGroup(new Date(2026,2,15).toISOString(),'Two Weeks',1,anchor).key,'2026-03-02');
 assert.equal(scheduleDateGroup(new Date(2026,2,16).toISOString(),'Two Weeks',1,anchor).key,'2026-03-16');
 assert.equal(scheduleDateGroup(new Date(2026,0,1).toISOString(),'Week',1,today).key,'2025-12-29');
});
test('unscheduled selection does not misclassify malformed timestamps',()=>{
 assert.equal(matchesScheduleDate('', 'Unscheduled', null),true);
 assert.equal(matchesScheduleDate('invalid', 'Unscheduled', null),false);
 assert.equal(matchesScheduleDate(today.toISOString(), 'Unscheduled', null),false);
});
