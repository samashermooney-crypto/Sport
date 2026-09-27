export type Channel = 'email' | 'sms' | 'push' | 'in_app';
export type Category =
  'operational' | 'announcement' | 'marketing' | 'emergency';
export type RegistrationStatus =
  | 'pending_payment'
  | 'pending_approval'
  | 'waitlisted'
  | 'offered'
  | 'confirmed'
  | 'canceled'
  | 'withdrawn'
  | 'transferred_out';
export type AudienceSpec = {
  include: {
    personIds?: string[];
    teamSeasonIds?: string[];
    programIds?: string[];
    roles?: string[];
  };
  exclude: {
    personIds?: string[];
    teamSeasonIds?: string[];
    programIds?: string[];
    roles?: string[];
  };
  filters: {
    registrationStatuses?: RegistrationStatus[];
    pastDueBalance?: boolean;
  };
};
export type LocaleCopy = {
  subject: string;
  bodyHtml: string;
  bodyText: string;
  smsText: string;
  pushText: string;
};
export type CampaignDraft = {
  channels: Channel[];
  category: Category;
  audience: AudienceSpec;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  smsText: string;
  pushText: string;
  localeVariants: { en: LocaleCopy; es: LocaleCopy };
};
export type Campaign = {
  id: string;
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'canceled' | 'failed';
  category: Category;
  channels: Channel[];
  subject: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  resolvedRecipientCount: number | null;
  version: number;
  createdAt: string;
};
export type CampaignDetail = Campaign & { draft: CampaignDraft };
export type Preview = {
  recipientCount: number;
  counts: Record<string, number>;
  recipients: {
    displayName: string;
    locale: 'en' | 'es';
    aboutPersonId: string | null;
    channels: Channel[];
  }[];
};
export type Option = { id: string; label: string };
export type AudienceOptions = {
  people: Option[];
  teams: Option[];
  programs: Option[];
};

export async function communicationsRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/communications${path}`, {
      method,
      credentials: 'include',
      ...(method === 'GET'
        ? {}
        : {
            headers: {
              'Content-Type': 'application/json',
              'X-Athlentry-Request': '1',
            },
          }),
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  } catch {
    throw new Error('Cannot connect. Check your connection and try again.');
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      result && typeof result === 'object' && 'error' in result
        ? result.error
        : null;
    throw new Error(
      error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
        ? error.message
        : 'The request could not be completed.',
    );
  }
  return result as T;
}
