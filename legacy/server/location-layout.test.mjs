import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutLocationDay} from '../src/location-layout.ts';
const event=(id,start,end,location_id='field')=>({id,location_id,start_at:start,end_at:end});
const at=(hour,minute=0)=>new Date(2026,8,12,hour,minute).toISOString();
test('location cards do not overlap, including short activities',()=>{
 const events=[event('a',at(9),at(10)),event('b',at(9,30),at(10,30)),event('c',at(11),at(11,5)),event('d',at(11,10),at(11,15)),event('other',at(9),at(10),'other')];
 const result=layoutLocationDay(events,'field',new Date(2026,8,12));
 assert.equal(result.intervals.length,4);
 assert.equal(result.laneCount,2);
 for(const a of result.intervals)for(const b of result.intervals)if(a!==b&&a.lane===b.lane)assert.ok(a.start+a.height<=b.start||b.start+b.height<=a.start);
 assert.equal(events[0].lane,undefined);
});
test('overnight cards clip at both day boundaries and exclude adjacent days',()=>{
 const start=new Date(2026,8,12),next=new Date(2026,8,13);
 const result=layoutLocationDay([event('overnight',new Date(2026,8,11,23).toISOString(),at(1)),event('late',at(23,55),new Date(2026,8,13,1).toISOString()),event('before',new Date(2026,8,11,23).toISOString(),start.toISOString()),event('after',next.toISOString(),new Date(2026,8,13,1).toISOString())],'field',start);
 assert.deepEqual(result.intervals.map(x=>[x.event.id,x.start,x.height]),[['overnight',0,60],['late',1435,5]]);
});

test('TBD-end activities remain visible only on their start day without storing a made-up end',()=>{
 const entry=event('tbd',at(9),'');
 const result=layoutLocationDay([entry],'field',new Date(2026,8,12));
 assert.equal(result.intervals.length,1);
 assert.equal(result.intervals[0].start,540);
 assert.ok(result.intervals[0].height>=24);
 assert.equal(result.intervals[0].event.end_at,'');
 assert.equal(layoutLocationDay([entry],'field',new Date(2026,8,13)).intervals.length,0);
});
