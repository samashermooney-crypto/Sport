import http from 'k6/http';
import { Rate, Trend } from 'k6/metrics';
import { sleep } from 'k6';

import {
  apiUrl,
  assertPreviewTarget,
  authParams,
  getPath,
  isExpectedStatus,
  readJsonFile,
  requestBody,
} from './common.js';

const unexpectedResponses = new Rate('campaign_unexpected_responses');
const completed = new Rate('campaign_completed');
const completionSeconds = new Trend('campaign_completion_seconds');
const fixture = readJsonFile('CAMPAIGN_FIXTURE_FILE');

export const options = {
  scenarios: {
    campaign_fanout: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '16m',
    },
  },
  thresholds: {
    campaign_unexpected_responses: ['rate==0'],
    campaign_completed: ['rate==1'],
    campaign_completion_seconds: ['max<900'],
  },
};

export function setup() {
  assertPreviewTarget('CAMPAIGN_FIXTURE_FILE');
  if (!fixture || !fixture.token || !fixture.enqueuePath || !fixture.statusPath)
    throw new Error(
      'Campaign fixture must include auth, enqueue and status paths',
    );
  if (!fixture.enqueueIdempotencyKey)
    throw new Error('Campaign fixture needs an enqueue idempotency key');
  if (fixture.expectedRecipients !== 20000)
    throw new Error('Campaign fixture must target exactly 20,000 recipients');
  if (
    !fixture.completedFieldPath ||
    !fixture.failedFieldPath ||
    !fixture.statusFieldPath
  )
    throw new Error('Campaign fixture must identify completion status fields');
}

export default function () {
  const startedAt = Date.now();
  const send = http.post(
    apiUrl(fixture.enqueuePath),
    requestBody(fixture.enqueueBody),
    authParams(fixture.token, fixture.enqueueIdempotencyKey),
  );
  const sendAccepted = isExpectedStatus(send, [200, 201, 202]);
  unexpectedResponses.add(sendAccepted ? 0 : 1);
  if (!sendAccepted) {
    completed.add(0);
    return;
  }

  let finished = false;
  const maxPolls = 90;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    sleep(10);
    const status = http.get(
      apiUrl(fixture.statusPath),
      authParams(fixture.token),
    );
    const statusOk = isExpectedStatus(status, [200]);
    unexpectedResponses.add(statusOk ? 0 : 1);
    if (!statusOk) break;
    const payload = status.json();
    const delivered = Number(getPath(payload, fixture.completedFieldPath));
    const failed = Number(getPath(payload, fixture.failedFieldPath) ?? 0);
    const state = getPath(payload, fixture.statusFieldPath);
    if (state === 'failed' || failed > 0) break;
    if (Number.isFinite(delivered) && delivered >= fixture.expectedRecipients) {
      finished = true;
      break;
    }
  }
  completed.add(finished ? 1 : 0);
  if (finished) completionSeconds.add((Date.now() - startedAt) / 1000);
}
