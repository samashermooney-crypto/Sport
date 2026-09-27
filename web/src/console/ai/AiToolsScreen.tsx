import {
  aiApplyResponseSchema,
  aiDraftResponseSchema,
  aiStatusSchema,
  aiTranslateResponseSchema,
} from '@shared/schemas/growth';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost, orgHeaders } from '../../api/client';
import { OrgShell } from '../../ui/OrgShell';
import {
  Badge,
  Button,
  Card,
  Field,
  PageHeader,
  Select,
  Textarea,
} from '../../ui/primitives';

export function AiToolsScreen({ orgId }: { orgId: string }): React.JSX.Element {
  const status = useQuery({
    queryKey: ['ai', orgId, 'status'],
    queryFn: () => apiGet('/ai/status', aiStatusSchema, orgHeaders(orgId)),
  });
  if (status.isPending) {
    return (
      <OrgShell orgId={orgId}>
        <main>
          <p role="status">Loading…</p>
        </main>
      </OrgShell>
    );
  }
  if (!status.data?.enabled) {
    return (
      <OrgShell orgId={orgId}>
        <main>
          <PageHeader
            title="AI assistance"
            kicker="AI TOOLS"
            description="AI assistance is not enabled for this environment."
          />
        </main>
      </OrgShell>
    );
  }
  return (
    <OrgShell orgId={orgId}>
      <main className="help-center">
        <PageHeader
          title="AI assistance"
          kicker="AI TOOLS"
          description={`Provider: ${status.data.provider ?? ''} (${status.data.model ?? ''}). Drafts are never saved until you apply them.`}
        />
        <FormDraftCard orgId={orgId} />
        <TranslateCard orgId={orgId} />
      </main>
    </OrgShell>
  );
}

interface DraftPreview {
  title?: string;
  description?: string;
  fields?: {
    key?: string;
    label?: string;
    type?: string;
    required?: boolean;
  }[];
}

function FormDraftCard({ orgId }: { orgId: string }): React.JSX.Element {
  const [draft, setDraft] = useState<DraftPreview | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const upload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a PDF, DOCX, or text file first.');
      return;
    }
    setError('');
    setDraft(null);
    setDraftId(null);
    try {
      const response = await fetch(
        `/api/v1/ai/form-drafts?name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'X-Athlentry-Request': '1',
            'X-Athlentry-Org': orgId,
            'Content-Type': 'application/octet-stream',
          },
          body: file,
        },
      );
      const json: unknown = await response.json();
      if (!response.ok)
        throw new Error(
          (json as { message?: string }).message ?? 'Draft failed',
        );
      const parsed = aiDraftResponseSchema.parse(json);
      setDraftId(parsed.draftId);
      setDraft(parsed.draft as DraftPreview);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : 'Draft failed',
      );
    }
  };
  const apply = useMutation({
    mutationFn: () =>
      apiPost(
        `/ai/form-drafts/${String(draftId)}/apply`,
        {},
        aiApplyResponseSchema,
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: (result) => {
      setAppliedId(result.formDefinitionId);
      void queryClient.invalidateQueries({ queryKey: ['ai', orgId] });
    },
  });
  const discard = useMutation({
    mutationFn: () =>
      apiPost(
        `/ai/form-drafts/${String(draftId)}/discard`,
        {},
        z.object({}),
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: () => {
      setDraft(null);
      setDraftId(null);
    },
  });
  return (
    <Card>
      <h2>Draft a form from a document</h2>
      <p>
        Upload a PDF, Word, or text file — for example a paper waiver — and AI
        drafts an Athlentry form for you to review. Nothing is saved until you
        apply the draft.
      </p>
      <div className="imports-new-row">
        <Field label="Document">
          <input
            ref={fileRef}
            type="file"
            className="ui-input"
            accept=".pdf,.docx,.txt,.md"
          />
        </Field>
        <Button onClick={() => void upload()}>Draft form</Button>
      </div>
      {error && (
        <p role="alert" className="imports-error">
          {error}
        </p>
      )}
      {draft && !appliedId && (
        <div>
          <h3>{draft.title ?? 'Untitled draft'}</h3>
          {draft.description && <p>{draft.description}</p>}
          <ul>
            {(draft.fields ?? []).map((field, index) => (
              <li key={index}>
                {field.label ?? field.key} <Badge>{field.type ?? 'text'}</Badge>
                {field.required ? ' (required)' : ''}
              </li>
            ))}
          </ul>
          <div className="imports-bulk">
            <Button
              onClick={() => {
                apply.mutate();
              }}
              disabled={apply.isPending || !draftId}
            >
              Save as unpublished form
            </Button>
            <Button
              secondary
              onClick={() => {
                discard.mutate();
              }}
              disabled={discard.isPending}
            >
              Discard draft
            </Button>
          </div>
        </div>
      )}
      {appliedId && (
        <p role="status">
          Form saved (unpublished). Publish it from the forms list when it is
          ready.
        </p>
      )}
    </Card>
  );
}

function TranslateCard({ orgId }: { orgId: string }): React.JSX.Element {
  const [text, setText] = useState('');
  const [target, setTarget] = useState<'en' | 'es'>('es');
  const [result, setResult] = useState('');
  const translate = useMutation({
    mutationFn: () =>
      apiPost(
        '/ai/translate',
        { text, target },
        aiTranslateResponseSchema,
        undefined,
        orgHeaders(orgId),
      ),
    onSuccess: (response) => {
      setResult(response.text);
    },
  });
  return (
    <Card>
      <h2>Translate</h2>
      <Field label="Text">
        <Textarea
          value={text}
          rows={4}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </Field>
      <Field label="Translate to">
        <Select
          value={target}
          options={[
            { value: 'es', label: 'Spanish' },
            { value: 'en', label: 'English' },
          ]}
          onChange={(event) => {
            setTarget(event.target.value as 'en' | 'es');
          }}
        />
      </Field>
      <Button
        onClick={() => {
          translate.mutate();
        }}
        disabled={translate.isPending || !text.trim()}
      >
        {translate.isPending ? 'Translating…' : 'Translate'}
      </Button>
      {result && (
        <Field label="Translation" hint="Review before sending to families.">
          <Textarea
            value={result}
            rows={4}
            onChange={(event) => {
              setResult(event.target.value);
            }}
          />
        </Field>
      )}
      {translate.isError && (
        <p role="alert" className="imports-error">
          {translate.error instanceof Error
            ? translate.error.message
            : 'Translation failed'}
        </p>
      )}
    </Card>
  );
}
