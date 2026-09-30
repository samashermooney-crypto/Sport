import exec from 'k6/execution';
import http from 'k6/http';
import { Rate } from 'k6/metrics';

import {
  apiUrl,
  assertPreviewTarget,
  authParams,
  isExpectedStatus,
  publicParams,
  sharedJsonArray,
  requestBody,
} from './common.js';

const unexpectedResponses = new Rate('game_day_unexpected_responses');
const coaches = sharedJsonArray('coach submissions', 'COACH_FIXTURES_FILE');
const publicReadFixtures = sharedJsonArray('public reads', 'PUBLIC_READS_FILE');

export const options = {
  scenarios: {
    coaches: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '10m',
      exec: 'coachSubmissions',
    },
    public_schedule_standings: {
      executor: 'constant-arrival-rate',
      rate: 5000,
      timeUnit: '1m',
      duration: '10m',
      preAllocatedVUs: 100,
      maxVUs: 500,
      exec: 'publicReads',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    game_day_unexpected_responses: ['rate==0'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  assertPreviewTarget('COACH_FIXTURES_FILE', 'PUBLIC_READS_FILE');
  const coachList = Array.from(coaches);
  if (coachList.length < 500)
    throw new Error('Game-day fixture file must contain 500 coaches');
  const coachKeys = coachList
    .slice(0, 500)
    .flatMap((coach) => [
      coach.attendanceIdempotencyKey,
      coach.scoreIdempotencyKey,
    ]);
  if (
    coachList
      .slice(0, 500)
      .some(
        (coach) =>
          coach.attendanceMethod !== undefined &&
          !['POST', 'PUT', 'PATCH'].includes(coach.attendanceMethod),
      )
  )
    throw new Error('Coach attendance method must be POST, PUT or PATCH');
  if (coachKeys.some((key) => !key) || new Set(coachKeys).size !== 1000) {
    throw new Error(
      'Coach fixtures need 1,000 unique attendance and score idempotency keys',
    );
  }
  if (publicReadFixtures.length < 2)
    throw new Error(
      'Public read fixture file must contain schedule and standings paths',
    );
}

export function coachSubmissions() {
  // Scenario-local index: __VU is shared with the public-read scenario.
  const coach = coaches[exec.scenario.iterationInTest];
  if (!coach || !coach.token) throw new Error('Coach fixture is incomplete');
  const attendance = http.request(
    coach.attendanceMethod ?? 'POST',
    apiUrl(coach.attendancePath),
    requestBody(coach.attendanceBody),
    authParams(coach.token, coach.attendanceIdempotencyKey),
  );
  const attendanceOk = isExpectedStatus(attendance, [200, 201, 204]);
  unexpectedResponses.add(attendanceOk ? 0 : 1);
  const score = http.post(
    apiUrl(coach.scorePath),
    requestBody(coach.scoreBody),
    authParams(coach.token, coach.scoreIdempotencyKey),
  );
  const scoreOk = isExpectedStatus(score, [200, 201, 204]);
  unexpectedResponses.add(scoreOk ? 0 : 1);
}

export function publicReads() {
  const fixture =
    publicReadFixtures[(__ITER + __VU - 1) % publicReadFixtures.length];
  const response = http.get(apiUrl(fixture.path), publicParams());
  const accepted = isExpectedStatus(response, [200]);
  unexpectedResponses.add(accepted ? 0 : 1);
}
