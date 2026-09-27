import { archery } from './archery.js';
import { badminton } from './badminton.js';
import { baseball } from './baseball.js';
import { basketball } from './basketball.js';
import { beach_volleyball } from './beach_volleyball.js';
import { bowling } from './bowling.js';
import { boxing } from './boxing.js';
import { cheer } from './cheer.js';
import { chess } from './chess.js';
import { climbing } from './climbing.js';
import { cricket } from './cricket.js';
import { cross_country } from './cross_country.js';
import { cycling } from './cycling.js';
import { dance } from './dance.js';
import { diving } from './diving.js';
import { esports } from './esports.js';
import { fencing } from './fencing.js';
import { field_hockey } from './field_hockey.js';
import { figure_skating } from './figure_skating.js';
import { flag_football } from './flag_football.js';
import { futsal } from './futsal.js';
import { general_activity } from './general_activity.js';
import { golf } from './golf.js';
import { gymnastics } from './gymnastics.js';
import { handball } from './handball.js';
import { ice_hockey } from './ice_hockey.js';
import { judo_bjj } from './judo_bjj.js';
import { lacrosse } from './lacrosse.js';
import { martial_arts } from './martial_arts.js';
import { pickleball } from './pickleball.js';
import { roller_hockey } from './roller_hockey.js';
import { rowing } from './rowing.js';
import { rugby } from './rugby.js';
import { skiing_snowboard } from './skiing_snowboard.js';
import { soccer } from './soccer.js';
import { softball } from './softball.js';
import { swimming } from './swimming.js';
import { table_tennis } from './table_tennis.js';
import { tackle_football } from './tackle_football.js';
import { tball } from './tball.js';
import { tennis } from './tennis.js';
import { track_field } from './track_field.js';
import { ultimate } from './ultimate.js';
import { volleyball } from './volleyball.js';
import { water_polo } from './water_polo.js';
import { wrestling } from './wrestling.js';

export const builtInSportTemplates = [
  soccer,
  futsal,
  basketball,
  baseball,
  softball,
  tball,
  volleyball,
  beach_volleyball,
  flag_football,
  tackle_football,
  ice_hockey,
  roller_hockey,
  field_hockey,
  lacrosse,
  rugby,
  water_polo,
  ultimate,
  handball,
  cricket,
  tennis,
  pickleball,
  badminton,
  table_tennis,
  swimming,
  diving,
  track_field,
  cross_country,
  gymnastics,
  cheer,
  dance,
  figure_skating,
  wrestling,
  martial_arts,
  judo_bjj,
  boxing,
  fencing,
  golf,
  bowling,
  archery,
  cycling,
  skiing_snowboard,
  rowing,
  esports,
  chess,
  climbing,
  general_activity,
] as const;
export const builtInSportTemplatesByKey = new Map(
  builtInSportTemplates.map((profile) => [profile.key, profile]),
);
