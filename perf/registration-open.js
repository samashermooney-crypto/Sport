import exec from 'k6/execution';
import http from 'k6/http';
import { Rate } from 'k6/metrics';
import { sleep } from 'k6';

import {
  apiUrl,
  assertPreviewTarget,
  authParams,
  isExpectedStatus,
  sharedJsonArray,
  requestBody,
} from './common.js';

const unexpectedResponses = new Rate('registration_unexpected_responses');
const capacityConflicts = new Rate('registration_capacity_conflicts');
const families = sharedJsonArray(
  'registration families',
  'REGISTRATION_FAMILIES_FILE',
  (fixture) => fixture.families,
);
const offerings = sharedJsonArray(
  'registration offerings',
  'REGISTRATION_FAMILIES_FILE',
  (fixture) => fixture.offerings,
);

export const options = {
  scenarios: {
    registration_open: {
      executor: 'per-vu-iterations',
      vus: 2000,
      iterations: 1,
      maxDuration: '11m',
    },
  },
  thresholds: {
    registration_unexpected_responses: ['rate==0'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  assertPreviewTarget('REGISTRATION_OPEN_PATH');
  const familyList = Array.from(families);
  const offeringList = Array.from(offerings);
  if (familyList.length !== 2000)
    throw new Error('Registration test requires exactly 2,000 family fixtures');
  if (offeringList.length !== 10) {
    throw new Error(
      'Registration fixture must include exactly 10 limited offerings',
    );
  }
  const tokens = new Set(familyList.map((family) => family.token));
  const idempotencyKeys = new Set(
    familyList.map((family) => family.idempotencyKey),
  );
  const capacities = new Map(
    offeringList.map((offering) => [offering.id, offering.capacity]),
  );
  const attemptsByOffering = new Map();
  for (const family of familyList) {
    attemptsByOffering.set(
      family.offeringId,
      (attemptsByOffering.get(family.offeringId) ?? 0) + 1,
    );
  }
  const offeringIds = new Set(capacities.keys());
  if (tokens.size < 2000 || idempotencyKeys.size < 2000)
    throw new Error(
      'Registration fixtures require unique family tokens and idempotency keys',
    );
  if (offeringIds.size !== 10)
    throw new Error('Registration fixtures must cover exactly 10 offerings');
  if (
    offeringList.some(
      (offering) =>
        typeof offering.id !== 'string' ||
        !Number.isSafeInteger(offering.capacity) ||
        offering.capacity < 1 ||
        offering.capacity >= (attemptsByOffering.get(offering.id) ?? 0),
    )
  ) {
    throw new Error(
      'Each offering needs a positive capacity below its attempted family count',
    );
  }
  if (familyList.some((family) => !capacities.has(family.offeringId)))
    throw new Error('Each family fixture must reference a configured offering');
}

export default function () {
  sleep(Math.random() * 600);
  const family = families[exec.scenario.iterationInTest];
  if (!family || !family.token || !family.body)
    throw new Error('Registration fixture is incomplete');
  const response = http.post(
    apiUrl(__ENV.REGISTRATION_OPEN_PATH),
    requestBody(family.body),
    authParams(family.token, family.idempotencyKey),
  );
  const allowed = [200, 201, 202, 409];
  const accepted = isExpectedStatus(response, allowed);
  unexpectedResponses.add(accepted ? 0 : 1);
  capacityConflicts.add(response.status === 409 ? 1 : 0);
}
