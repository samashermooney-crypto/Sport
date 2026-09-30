import { Rate } from 'k6/metrics';

import {
  assertPreviewTarget,
  isExpectedStatus,
  sharedJsonArray,
  readRequest,
} from './common.js';

const unexpectedResponses = new Rate('steady_unexpected_responses');
const reads = sharedJsonArray('read requests', 'READ_REQUESTS_FILE');

export const options = {
  scenarios: {
    mixed_reads: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 250,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<1000'],
    steady_unexpected_responses: ['rate==0'],
    dropped_iterations: ['count==0'],
  },
};

export function setup() {
  assertPreviewTarget('READ_REQUESTS_FILE');
  const readList = Array.from(reads);
  if (readList.length === 0)
    throw new Error('Read fixture file must contain request records');
  const surfaces = new Set(readList.map((fixture) => fixture.surface));
  if (!surfaces.has('console') || !surfaces.has('portal'))
    throw new Error(
      'Read fixtures must cover both console and portal surfaces',
    );
}

export default function () {
  const fixture = reads[(__ITER + __VU - 1) % reads.length];
  const response = readRequest(fixture);
  unexpectedResponses.add(isExpectedStatus(response, [200]) ? 0 : 1);
}
