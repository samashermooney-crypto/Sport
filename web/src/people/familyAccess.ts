import { familyResponseSchema } from '@shared/schemas/people';
import { useQuery } from '@tanstack/react-query';

import { apiGet } from '../api/client';

export function useFamilyPerson(
  orgId: string | undefined,
  personId: string | undefined,
  enabled = true,
) {
  const family = useQuery({
    queryKey: ['people', 'me', 'family'],
    queryFn: () => apiGet('/people/me/family', familyResponseSchema),
    enabled: enabled && Boolean(orgId && personId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const isReady =
    family.isFetchedAfterMount && family.isSuccess && !family.isFetching;
  const person = isReady
    ? family.data.organizations
        .find((organization) => organization.orgId === orgId)
        ?.people.find((member) => member.personId === personId)
    : undefined;

  return { isError: family.isError, isReady, person };
}
