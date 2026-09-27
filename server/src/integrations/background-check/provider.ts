export type BackgroundCheckStatus =
  'pending' | 'clear' | 'consider' | 'suspended' | 'canceled' | 'expired';
export interface BackgroundCheckRequest {
  candidateId: string;
  firstName: string;
  lastName: string;
  email: string;
  dob?: string;
  package: string;
}
export interface BackgroundCheckResult {
  providerId: string;
  status: BackgroundCheckStatus;
  completedAt?: string;
  reportUrl?: string;
}
export interface BackgroundCheckProvider {
  create(
    request: BackgroundCheckRequest,
  ): Promise<{ providerId: string; status: 'pending' }>;
  retrieve(providerId: string): Promise<BackgroundCheckResult>;
}

/** Manual is first-class: officers record status through the compliance module, without an external vendor. */
export class ManualBackgroundCheckProvider implements BackgroundCheckProvider {
  create(request: BackgroundCheckRequest) {
    return Promise.resolve({
      providerId: `manual:${request.candidateId}`,
      status: 'pending' as const,
    });
  }
  retrieve(providerId: string): Promise<BackgroundCheckResult> {
    if (!providerId.startsWith('manual:'))
      throw new Error('Unknown manual background check');
    return Promise.resolve({ providerId, status: 'pending' });
  }
  recordResult(
    providerId: string,
    status: Exclude<BackgroundCheckStatus, 'pending'>,
    completedAt = new Date().toISOString(),
  ): BackgroundCheckResult {
    if (!providerId.startsWith('manual:'))
      throw new Error('Unknown manual background check');
    return { providerId, status, completedAt };
  }
}

export class CheckrBackgroundCheckProvider implements BackgroundCheckProvider {
  constructor(
    private readonly config: {
      apiKey: string;
      baseUrl?: string;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(config.baseUrl ?? 'https://api.checkr.com');
    if (
      url.protocol !== 'https:' ||
      !['api.checkr.com', 'api.checkr-staging.com'].includes(url.hostname)
    )
      throw new Error('Checkr host is not allow-listed');
    if (!config.apiKey) throw new Error('Checkr API key is required');
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.fetcher = config.fetch ?? fetch;
  }
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  async create(request: BackgroundCheckRequest) {
    const candidateResponse = await this.fetcher(
      `${this.baseUrl}/v1/candidates`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          first_name: request.firstName,
          last_name: request.lastName,
          email: request.email,
          ...(request.dob ? { dob: request.dob } : {}),
        }),
      },
    );
    if (!candidateResponse.ok)
      throw new Error(
        `Checkr candidate request failed with HTTP ${String(candidateResponse.status)}`,
      );
    const candidate: unknown = await candidateResponse.json();
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !('id' in candidate) ||
      typeof candidate.id !== 'string'
    )
      throw new Error('Checkr candidate response is invalid');
    const reportResponse = await this.fetcher(`${this.baseUrl}/v1/reports`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        candidate_id: candidate.id,
        package: request.package,
      }),
    });
    if (!reportResponse.ok)
      throw new Error(
        `Checkr report request failed with HTTP ${String(reportResponse.status)}`,
      );
    const report: unknown = await reportResponse.json();
    if (
      !report ||
      typeof report !== 'object' ||
      !('id' in report) ||
      typeof report.id !== 'string'
    )
      throw new Error('Checkr report response is invalid');
    return { providerId: report.id, status: 'pending' as const };
  }
  async retrieve(providerId: string): Promise<BackgroundCheckResult> {
    const response = await this.fetcher(
      `${this.baseUrl}/v1/reports/${encodeURIComponent(providerId)}`,
      { headers: this.headers() },
    );
    if (!response.ok)
      throw new Error(
        `Checkr report lookup failed with HTTP ${String(response.status)}`,
      );
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== 'object' ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !('status' in value) ||
      typeof value.status !== 'string'
    )
      throw new Error('Checkr report response is invalid');
    const statuses: Record<string, BackgroundCheckStatus> = {
      pending: 'pending',
      clear: 'clear',
      consider: 'consider',
      suspended: 'suspended',
      canceled: 'canceled',
      expired: 'expired',
    };
    const status = statuses[value.status];
    if (!status) throw new Error('Checkr returned an unknown report status');
    return {
      providerId: value.id,
      status,
      ...('completed_at' in value && typeof value.completed_at === 'string'
        ? { completedAt: value.completed_at }
        : {}),
    };
  }
  private headers() {
    return {
      authorization: `Basic ${Buffer.from(`${this.config.apiKey}:`).toString('base64')}`,
      'content-type': 'application/json',
    };
  }
}
