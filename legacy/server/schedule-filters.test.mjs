import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyScheduleFilters, matchesScheduleFilters, activityState} from '../src/schedule-filters.ts';
import {eventSchema} from './domain.mjs';
const activity = (overrides={}) => ({id:'game', type:'Game', home_team_id:'home', away_team_id:'away', state:'Scheduled', start_at:new Date(2026,8,12,9,30).toISOString(), ...overrides});
test('schedule filters match either team and combine independent criteria', () => {
  const filters={...emptyScheduleFilters(),teams:['unrelated','away'],types:['Game'],states:['Scheduled']};
  assert.equal(matchesScheduleFilters(activity(), filters),true);
  assert.equal(matchesScheduleFilters(activity({home_team_id:'other',away_team_id:'third'}),filters),false);
  assert.equal(matchesScheduleFilters(activity({type:'Event'}),filters),false);
  assert.equal(matchesScheduleFilters(activity({state:'Canceled'}),filters),false);
  assert.equal(matchesScheduleFilters(activity({home_team_id:null,away_team_id:null}),emptyScheduleFilters()),true);
});
test('schedule start-time filters include boundaries and support open ranges', () => {
  const filters={...emptyScheduleFilters(),from:'09:30',to:'09:30'};
  assert.equal(matchesScheduleFilters(activity(), filters),true);
  assert.equal(matchesScheduleFilters(activity({start_at:new Date(2026,8,12,9,29).toISOString()}),filters),false);
  assert.equal(matchesScheduleFilters(activity({start_at:new Date(2026,8,12,9,31).toISOString()}),filters),false);
  assert.equal(matchesScheduleFilters(activity(), {...filters,to:''}),true);
  assert.equal(matchesScheduleFilters(activity(), {...filters,from:''}),true);
  assert.equal(matchesScheduleFilters(activity({start_at:'invalid'}),filters),false);
});
test('source activity states distinguish overtime and forfeits without changing stored results', () => {
  for(const [fields,label] of [
    [{state:'Completed'},'Played regular time'],
    [{state:'Completed',overtime:true},'Played overtime'],
    [{state:'Completed',overtime:true,forfeit:'Home'},'Forfeit home'],
    [{state:'Completed',forfeit:'Away'},'Forfeit away'],
    [{state:'Completed',forfeit:'Both'},'Forfeit both'],
    [{state:'Canceled',forfeit:'Home'},'Canceled'],
    [{state:'Rescheduled'},'Rescheduled'],
  ]) {
    const event=activity(fields);
    assert.equal(activityState(event),label);
    assert.equal(matchesScheduleFilters(event,{...emptyScheduleFilters(),states:[label]}),true);
    assert.equal(event.state,fields.state);
  }
  assert.equal(eventSchema.parse({program_id:'program',type:'Event',title:'Rescheduled orientation',state:'Rescheduled',start_at:'2026-09-12T14:00:00Z',end_at:'2026-09-12T15:00:00Z'}).state,'Rescheduled');
});

test('staff filters match either team, union staff choices, and require team association',()=>{
 const staff=[{id:'coach',name:'Coach',team_ids:['away']},{id:'other',name:'Other',team_ids:['third']}];
 const filters={...emptyScheduleFilters(),staff:['unknown','coach']};
 assert.equal(matchesScheduleFilters(activity(),filters,staff),true);
 assert.equal(matchesScheduleFilters(activity({home_team_id:'third',away_team_id:null}),filters,staff),false);
 assert.equal(matchesScheduleFilters(activity(),{...filters,teams:['third']},staff),false);
 assert.equal(matchesScheduleFilters(activity(),{...filters,staff:['other']},staff),false);
 assert.equal(matchesScheduleFilters(activity(),filters,[]),false);
});
