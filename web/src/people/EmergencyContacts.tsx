import { emergencyContactsSchema } from '@shared/schemas/emergencyContacts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../api/client';
import { ErrorBox } from '../ui/auth';
import { Button, Card, Field, Input } from '../ui/primitives';

type Contact = z.output<typeof emergencyContactsSchema>['items'][number];
type Values = {
  name: string;
  relationship: string;
  phoneE164: string;
  altPhoneE164: string;
  priority: string;
};

function initial(contact?: Contact): Values {
  return {
    name: contact?.name ?? '',
    relationship: contact?.relationship ?? '',
    phoneE164: contact?.phoneE164 ?? '',
    altPhoneE164: contact?.altPhoneE164 ?? '',
    priority: String(contact?.priority ?? 1),
  };
}

export function EmergencyContacts({
  orgId,
  personId,
}: {
  orgId: string;
  personId: string;
}): React.JSX.Element {
  const client = useQueryClient();
  const key = ['people', orgId, personId, 'emergency-contacts'];
  const contacts = useQuery({
    queryKey: key,
    queryFn: () =>
      apiGet(
        `/people/orgs/${orgId}/${personId}/emergency-contacts`,
        emergencyContactsSchema,
      ),
  });
  const [editing, setEditing] = useState<Contact | null>(null);
  const [values, setValues] = useState<Values>(initial());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const base = `/people/orgs/${orgId}/${personId}/emergency-contacts`;
  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }
  function saved(
    next: z.output<typeof emergencyContactsSchema>,
    notice: string,
  ) {
    client.setQueryData(key, next);
    setEditing(null);
    setValues(initial());
    setMessage(notice);
  }
  return (
    <Card>
      <h2>Emergency contacts</h2>
      {contacts.isPending && <p role="status">Loading emergency contacts…</p>}
      {contacts.isError && <p>Emergency contacts are unavailable.</p>}
      {contacts.data && (
        <>
          {contacts.data.items.length === 0 && (
            <p>No emergency contacts are on file.</p>
          )}
          <ol>
            {contacts.data.items.map((contact) => (
              <li key={contact.id}>
                <strong>{contact.name}</strong> · {contact.relationship} ·{' '}
                {contact.phoneE164}
                {contact.altPhoneE164 && ` · ${contact.altPhoneE164}`}
                {contacts.data.canEdit && (
                  <>
                    {' '}
                    <Button
                      type="button"
                      secondary
                      onClick={() => {
                        setEditing(contact);
                        setValues(initial(contact));
                        setError('');
                        setMessage('');
                      }}
                    >
                      Edit
                    </Button>{' '}
                    <Button
                      type="button"
                      secondary
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Remove ${contact.name} as an emergency contact?`,
                          )
                        )
                          return;
                        setBusy(true);
                        setError('');
                        void apiPost(
                          `${base}/${contact.id}/remove`,
                          { expectedVersion: contact.version },
                          emergencyContactsSchema,
                        )
                          .then((next) => {
                            saved(next, 'Emergency contact removed.');
                          })
                          .catch((cause: unknown) => {
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : 'Contact could not be removed.',
                            );
                          })
                          .finally(() => {
                            setBusy(false);
                          });
                      }}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ol>
          {contacts.data.canEdit && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setBusy(true);
                setError('');
                setMessage('');
                const body = {
                  name: values.name,
                  relationship: values.relationship,
                  phoneE164: values.phoneE164,
                  altPhoneE164: values.altPhoneE164 || null,
                  priority: Number(values.priority),
                };
                const action = editing
                  ? apiPatch(
                      `${base}/${editing.id}`,
                      { ...body, expectedVersion: editing.version },
                      emergencyContactsSchema,
                    )
                  : apiPost(base, body, emergencyContactsSchema);
                void action
                  .then((next) => {
                    saved(
                      next,
                      editing
                        ? 'Emergency contact updated.'
                        : 'Emergency contact added.',
                    );
                  })
                  .catch((cause: unknown) => {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : 'Contact could not be saved.',
                    );
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              <h3>{editing ? 'Edit contact' : 'Add contact'}</h3>
              <ErrorBox error={error} />
              <Field label="Contact name" required>
                <Input
                  required
                  maxLength={200}
                  value={values.name}
                  onChange={(event) => {
                    set('name', event.target.value);
                  }}
                />
              </Field>
              <Field label="Relationship" required>
                <Input
                  required
                  maxLength={100}
                  value={values.relationship}
                  onChange={(event) => {
                    set('relationship', event.target.value);
                  }}
                />
              </Field>
              <Field label="Phone (+country code)" required>
                <Input
                  required
                  type="tel"
                  value={values.phoneE164}
                  onChange={(event) => {
                    set('phoneE164', event.target.value);
                  }}
                />
              </Field>
              <Field label="Alternate phone (+country code)">
                <Input
                  type="tel"
                  value={values.altPhoneE164}
                  onChange={(event) => {
                    set('altPhoneE164', event.target.value);
                  }}
                />
              </Field>
              <Field label="Contact priority" required>
                <Input
                  required
                  type="number"
                  min={1}
                  max={99}
                  value={values.priority}
                  onChange={(event) => {
                    set('priority', event.target.value);
                  }}
                />
              </Field>
              <Button type="submit" disabled={busy}>
                {busy
                  ? 'Saving…'
                  : editing
                    ? 'Save contact'
                    : 'Add emergency contact'}
              </Button>
              {editing && (
                <Button
                  type="button"
                  secondary
                  onClick={() => {
                    setEditing(null);
                    setValues(initial());
                  }}
                >
                  Cancel edit
                </Button>
              )}
            </form>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </Card>
  );
}
