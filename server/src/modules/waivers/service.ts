import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import * as fontkit from '@pdf-lib/fontkit';
import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import {
  waiverDocumentCreateSchema,
  waiverDocumentListSchema,
  waiverDocumentSchema,
  waiverDocumentUpdateSchema,
  waiverSignatureCreateSchema,
  waiverSignatureListSchema,
  waiverSignatureSchema,
} from '@shared/schemas/waivers';
import type {
  WaiverDocumentCreate,
  WaiverDocumentUpdate,
  WaiverSignatureCreate,
} from '@shared/schemas/waivers';
import { sql } from 'kysely';
import type { Kysely, Selectable } from 'kysely';
import { PDFDocument, rgb, type PDFPage } from 'pdf-lib';
import { z } from 'zod';

import type { DB, WaiverDocuments, WaiverSignatures } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { openSansRegularDeflatedBase64 } from '../finance/open-sans-font';

export class WaiversError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type DocumentRow = Selectable<WaiverDocuments>;
type SignatureRow = Selectable<WaiverSignatures>;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function bodyHtml(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split(/\n{2,}/)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`,
    )
    .join('');
}

function bodyText(html: string): string {
  return html
    .replaceAll(/<br\s*\/?\s*>/gi, '\n')
    .replaceAll(/<\/p\s*>\s*<p(?:\s[^>]*)?>/gi, '\n\n')
    .replaceAll(/<[^>]*>/g, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&')
    .trim();
}

function documentView(row: DocumentRow) {
  return waiverDocumentSchema.parse({
    id: row.id,
    name: row.name,
    bodyText: bodyText(row.body_html),
    version: row.version,
    requires: row.requires,
    renewal: row.renewal,
    templateUnreviewed: row.template_unreviewed,
    publishedAt: row.published_at?.toISOString() ?? null,
    retiredAt: row.retired_at?.toISOString() ?? null,
    supersedesId: row.supersedes_id,
  });
}

function signatureView(row: SignatureRow) {
  return waiverSignatureSchema.parse({
    id: row.id,
    waiverDocumentId: row.waiver_document_id,
    documentVersion: row.document_version,
    documentHash: row.document_hash.toString('hex'),
    participantPersonId: row.participant_person_id,
    signerAccountId: row.signer_account_id,
    signerPersonId: row.signer_person_id,
    signerNameTyped: row.signer_name_typed,
    method: row.method,
    signedAt: row.signed_at.toISOString(),
  });
}

async function requireDocumentManager(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<void> {
  const membership = await trx
    .selectFrom('org_memberships')
    .select('id')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!membership)
    throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
  const role = await trx
    .selectFrom('role_assignments')
    .select('role')
    .where('org_id', '=', context.orgId)
    .where('account_id', '=', context.actor.accountId)
    .where('scope_type', '=', 'org')
    .where('pending_mfa', '=', false)
    .where('revoked_at', 'is', null)
    .where('role', 'in', ['owner', 'admin', 'registrar'])
    .executeTakeFirst();
  if (!role) throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
}

async function ancestorIds(
  trx: OrgTransaction,
  orgId: string,
  documentId: string,
): Promise<string[]> {
  const ids = [documentId];
  let currentId = documentId;
  for (let depth = 0; depth < 100; depth += 1) {
    const row = await trx
      .selectFrom('waiver_documents')
      .select('supersedes_id')
      .where('org_id', '=', orgId)
      .where('id', '=', currentId)
      .executeTakeFirst();
    if (!row?.supersedes_id) return ids;
    ids.push(row.supersedes_id);
    currentId = row.supersedes_id;
  }
  throw new WaiversError(409, 'CONFLICT', 'Waiver version history is invalid');
}

async function mergedPersonLineage(
  trx: OrgTransaction,
  orgId: string,
  personId: string,
): Promise<string[]> {
  const lineage = await sql<{ person_id: string }>`
    WITH RECURSIVE lineage(person_id) AS (
      SELECT ${personId}::uuid
      UNION
      SELECT related.person_id
      FROM lineage current
      JOIN person_merges merge
        ON merge.org_id = ${orgId}
        AND (merge.survivor_id = current.person_id OR merge.merged_id = current.person_id)
      CROSS JOIN LATERAL (VALUES (merge.survivor_id), (merge.merged_id)) AS related(person_id)
    )
    SELECT person_id FROM lineage
  `.execute(trx);
  return lineage.rows.map((row) => row.person_id);
}

async function renderPdf(
  name: string,
  text: string,
  signer: string,
  method: string,
  signedAt: string,
  documentHash: string,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(`${name} — signed waiver`);
  document.setSubject(text);
  document.setKeywords([
    `Signer: ${signer}`,
    `Method: ${method}`,
    `Signed at: ${signedAt}`,
    `Document SHA-256: ${documentHash}`,
  ]);
  const fontBytes = inflateSync(
    Buffer.from(openSansRegularDeflatedBase64, 'base64'),
  );
  const glyphFont = fontkit.create(fontBytes);
  document.registerFontkit(fontkit);
  const font = await document.embedFont(fontBytes, { subset: true });
  let page: PDFPage = document.addPage([612, 792]);
  let y = 744;
  const addPage = (): void => {
    page = document.addPage([612, 792]);
    y = 744;
  };
  const drawLine = (line: string, size = 11): void => {
    if (y < 56) addPage();
    for (const character of Array.from(line)) {
      const point = character.codePointAt(0);
      if (point === undefined || !glyphFont.hasGlyphForCodePoint(point))
        throw new WaiversError(
          422,
          'UNSUPPORTED_TEXT',
          'Waiver text contains a character that cannot be rendered.',
        );
    }
    page.drawText(line, {
      x: 48,
      y,
      size,
      font,
      color: rgb(0.12, 0.16, 0.22),
    });
    y -= size + 7;
  };
  const drawParagraph = (paragraph: string, size = 11): void => {
    const words = paragraph.split(/\s+/);
    let line = '';
    for (const word of words) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > 516 && line) {
        drawLine(line, size);
        line = word;
      } else {
        line = next;
      }
      if (font.widthOfTextAtSize(line, size) > 516)
        throw new WaiversError(
          422,
          'UNSUPPORTED_TEXT',
          'A waiver word is too long to render on the signed PDF.',
        );
    }
    if (line) drawLine(line, size);
  };
  drawParagraph(name, 18);
  y -= 10;
  for (const paragraph of text.split('\n')) {
    if (paragraph) drawParagraph(paragraph);
    else y -= 7;
  }
  y -= 18;
  drawParagraph(`Signer: ${signer}`);
  drawParagraph(`Method: ${method}`);
  drawParagraph(`Signed at: ${signedAt}`);
  drawParagraph(`Document SHA-256: ${documentHash}`);
  return document.save({ useObjectStreams: false });
}

export function createWaiversService(database: Kysely<DB>) {
  const withOrg = createWithOrg(database);
  return {
    async list(context: OrgContext) {
      return withOrg(context, async (trx) => {
        await requireDocumentManager(trx, context);
        const rows = await trx
          .selectFrom('waiver_documents')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .orderBy('created_at', 'desc')
          .orderBy('version', 'desc')
          .execute();
        return waiverDocumentListSchema.parse({
          items: rows.map(documentView),
        });
      });
    },

    async listForPerson(context: OrgContext, participantPersonId: string) {
      const personId = z.uuid().parse(participantPersonId);
      return withOrg(context, async (trx) => {
        const person = await trx
          .selectFrom('people')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('id', '=', personId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!person)
          throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
        const link = await trx
          .selectFrom('person_account_links')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('person_id', '=', personId)
          .where('account_id', '=', context.actor.accountId)
          .where('verified_at', 'is not', null)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (!link)
          throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
        const rows = await trx
          .selectFrom('waiver_documents')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('published_at', 'is not', null)
          .where('retired_at', 'is', null)
          .where('template_unreviewed', '=', false)
          .orderBy('name')
          .orderBy('version', 'desc')
          .execute();
        return waiverDocumentListSchema.parse({
          items: rows.map(documentView),
        });
      });
    },

    async create(context: OrgContext, input: WaiverDocumentCreate) {
      const value = waiverDocumentCreateSchema.parse(input);
      return withOrg(context, async (trx) => {
        await requireDocumentManager(trx, context);
        const id = newId();
        await trx
          .insertInto('waiver_documents')
          .values({
            id,
            org_id: context.orgId,
            name: value.name,
            body_html: bodyHtml(value.bodyText),
            requires: value.requires,
            renewal: value.renewal,
          })
          .execute();
        const row = await trx
          .selectFrom('waiver_documents')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        await appendAuditEvent(trx, context, {
          action: 'waiver.created',
          entityType: 'waiver_document',
          entityId: id,
          changes: { name: { tier: 'internal', after: value.name } },
        });
        return documentView(row);
      });
    },

    async update(
      context: OrgContext,
      documentId: string,
      input: WaiverDocumentUpdate,
    ) {
      const id = z.uuid().parse(documentId);
      const value = waiverDocumentUpdateSchema.parse(input);
      return withOrg(context, async (trx) => {
        await requireDocumentManager(trx, context);
        const current = await trx
          .selectFrom('waiver_documents')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!current)
          throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
        if (current.version !== value.expectedVersion)
          throw new WaiversError(409, 'CONFLICT', 'Waiver version changed');
        const nextHtml = bodyHtml(value.bodyText);
        let updatedId = id;
        if (current.published_at) {
          updatedId = newId();
          await trx
            .insertInto('waiver_documents')
            .values({
              id: updatedId,
              org_id: context.orgId,
              name: value.name,
              body_html: nextHtml,
              version: current.version + 1,
              requires: value.requires,
              renewal: value.renewal,
              supersedes_id: id,
            })
            .execute();
        } else {
          if (current.template_unreviewed && nextHtml === current.body_html)
            throw new WaiversError(
              409,
              'CONFLICT',
              'Replace the default waiver text before reviewing it.',
            );
          await trx
            .updateTable('waiver_documents')
            .set({
              name: value.name,
              body_html: nextHtml,
              requires: value.requires,
              renewal: value.renewal,
              template_unreviewed: false,
              version: sql<number>`version + 1`,
            })
            .where('org_id', '=', context.orgId)
            .where('id', '=', id)
            .execute();
        }
        const row = await trx
          .selectFrom('waiver_documents')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', updatedId)
          .executeTakeFirstOrThrow();
        await appendAuditEvent(trx, context, {
          action: current.published_at
            ? 'waiver.version_created'
            : 'waiver.updated',
          entityType: 'waiver_document',
          entityId: updatedId,
          changes: {
            version: {
              tier: 'internal',
              before: current.version,
              after: row.version,
            },
          },
        });
        return documentView(row);
      });
    },

    async publish(
      context: OrgContext,
      documentId: string,
      expectedVersion: number,
    ) {
      const id = z.uuid().parse(documentId);
      return withOrg(context, async (trx) => {
        await requireDocumentManager(trx, context);
        const current = await trx
          .selectFrom('waiver_documents')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!current)
          throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
        if (current.version !== expectedVersion)
          throw new WaiversError(409, 'CONFLICT', 'Waiver version changed');
        if (current.template_unreviewed)
          throw new WaiversError(
            409,
            'CONFLICT',
            'Replace the default waiver text before publishing.',
          );
        if (current.published_at)
          throw new WaiversError(
            409,
            'CONFLICT',
            'Published waivers are immutable.',
          );
        await trx
          .updateTable('waiver_documents')
          .set({ published_at: new Date() })
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .execute();
        const ancestors = await ancestorIds(trx, context.orgId, id);
        for (const previousId of ancestors.slice(1)) {
          await trx
            .updateTable('waiver_documents')
            .set({ retired_at: new Date() })
            .where('org_id', '=', context.orgId)
            .where('id', '=', previousId)
            .where('published_at', 'is not', null)
            .where('retired_at', 'is', null)
            .execute();
        }
        const published = await trx
          .selectFrom('waiver_documents')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        await appendAuditEvent(trx, context, {
          action: 'waiver.published',
          entityType: 'waiver_document',
          entityId: id,
          changes: {
            version: { tier: 'internal', after: current.version },
          },
        });
        return documentView(published);
      });
    },

    async sign(
      context: OrgContext,
      documentId: string,
      input: WaiverSignatureCreate,
      request: { ip: string | null; userAgent: string | null },
    ) {
      const id = z.uuid().parse(documentId);
      const value = waiverSignatureCreateSchema.parse(input);
      return withOrg(context, async (trx) => {
        const document = await trx
          .selectFrom('waiver_documents')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', id)
          .where('published_at', 'is not', null)
          .where('retired_at', 'is', null)
          .where('template_unreviewed', '=', false)
          .executeTakeFirst();
        if (!document)
          throw new WaiversError(
            404,
            'NOT_FOUND',
            'Published waiver was not found',
          );
        const participant = await trx
          .selectFrom('people')
          .select(['id', 'date_of_birth'])
          .where('org_id', '=', context.orgId)
          .where('id', '=', value.participantPersonId)
          .where('status', '=', 'active')
          .forUpdate()
          .executeTakeFirst();
        if (!participant)
          throw new WaiversError(404, 'NOT_FOUND', 'Participant was not found');
        const org = await trx
          .selectFrom('organizations')
          .select('timezone')
          .where('id', '=', context.orgId)
          .executeTakeFirstOrThrow();
        const age = ageOnDate(
          participant.date_of_birth.toISOString().slice(0, 10),
          orgToday(org.timezone),
        );
        const isMinor = age < 18;
        const relationship = await trx
          .selectFrom('person_account_links')
          .select('relationship')
          .where('org_id', '=', context.orgId)
          .where('person_id', '=', value.participantPersonId)
          .where('account_id', '=', context.actor.accountId)
          .where('verified_at', 'is not', null)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        const canSignAsGuardian = relationship?.relationship === 'guardian';
        const canSignAsParticipant =
          relationship?.relationship === 'self' && !isMinor;
        if (document.requires === 'both' && isMinor)
          throw new WaiversError(
            409,
            'CONFLICT',
            'This waiver requires participant and guardian signatures. Minors cannot sign their own waivers.',
          );
        if (
          (document.requires === 'guardian_if_minor' &&
            (isMinor ? !canSignAsGuardian : !canSignAsParticipant)) ||
          (document.requires === 'participant' &&
            (isMinor || !canSignAsParticipant)) ||
          (document.requires === 'both' &&
            !(
              (canSignAsParticipant &&
                value.signerPersonId === value.participantPersonId) ||
              (canSignAsGuardian &&
                value.signerPersonId !== value.participantPersonId)
            ))
        )
          throw new WaiversError(404, 'NOT_FOUND', 'Waiver was not found');
        if (value.signerPersonId) {
          const signerPerson = await trx
            .selectFrom('person_account_links as link')
            .innerJoin('people as person', (join) =>
              join
                .onRef('person.org_id', '=', 'link.org_id')
                .onRef('person.id', '=', 'link.person_id'),
            )
            .select('link.id')
            .where('link.org_id', '=', context.orgId)
            .where('link.person_id', '=', value.signerPersonId)
            .where('link.account_id', '=', context.actor.accountId)
            .where('link.relationship', '=', 'self')
            .where('link.verified_at', 'is not', null)
            .where('link.revoked_at', 'is', null)
            .where('person.status', '=', 'active')
            .executeTakeFirst();
          if (!signerPerson)
            throw new WaiversError(404, 'NOT_FOUND', 'Signer was not found');
        }
        if (
          value.method === 'online_drawn' &&
          (!value.signatureFileId ||
            !(await trx
              .selectFrom('files')
              .select('id')
              .where('org_id', '=', context.orgId)
              .where('id', '=', value.signatureFileId)
              .where('deleted_at', 'is', null)
              .executeTakeFirst()))
        )
          throw new WaiversError(
            400,
            'VALIDATION_ERROR',
            'A completed signature image is required.',
          );
        if (value.registrationId) {
          const registration = await trx
            .selectFrom('registrations')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('id', '=', value.registrationId)
            .where('person_id', '=', value.participantPersonId)
            .executeTakeFirst();
          if (!registration)
            throw new WaiversError(
              404,
              'NOT_FOUND',
              'Registration was not found',
            );
        }
        if (document.requires === 'both') {
          let signaturesQuery = trx
            .selectFrom('waiver_signatures')
            .select(['signer_account_id', 'signer_person_id'])
            .where('org_id', '=', context.orgId)
            .where('waiver_document_id', '=', document.id)
            .where('document_version', '=', document.version)
            .where('participant_person_id', '=', value.participantPersonId);
          signaturesQuery = value.registrationId
            ? signaturesQuery.where(
                'registration_id',
                '=',
                value.registrationId,
              )
            : signaturesQuery.where('registration_id', 'is', null);
          const signatures = await signaturesQuery.execute();
          if (
            signatures.some(
              (signature) =>
                signature.signer_account_id === context.actor.accountId,
            )
          )
            throw new WaiversError(
              409,
              'CONFLICT',
              'The other signer must use a different account.',
            );
          const participantAlreadySigned = signatures.some(
            (signature) =>
              signature.signer_person_id === value.participantPersonId,
          );
          const guardianAlreadySigned = signatures.some(
            (signature) =>
              signature.signer_person_id !== value.participantPersonId,
          );
          const signingAsParticipant =
            canSignAsParticipant &&
            value.signerPersonId === value.participantPersonId;
          if (
            (signingAsParticipant && participantAlreadySigned) ||
            (!signingAsParticipant && guardianAlreadySigned)
          )
            throw new WaiversError(
              409,
              'CONFLICT',
              'This signer has already signed the current waiver version.',
            );
        }
        const text = bodyText(document.body_html);
        const hash = createHash('sha256').update(text, 'utf8').digest();
        const signedAt = new Date();
        const signatureId = newId();
        await trx
          .insertInto('waiver_signatures')
          .values({
            id: signatureId,
            org_id: context.orgId,
            waiver_document_id: document.id,
            document_version: document.version,
            document_hash: hash,
            participant_person_id: value.participantPersonId,
            signer_account_id: context.actor.accountId,
            signer_person_id: value.signerPersonId,
            signer_name_typed: value.signerNameTyped,
            signature_file_id: value.signatureFileId,
            method: value.method,
            registration_id: value.registrationId,
            ip: request.ip,
            user_agent: request.userAgent,
            signed_at: signedAt,
          })
          .execute();
        const row = await trx
          .selectFrom('waiver_signatures')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('id', '=', signatureId)
          .executeTakeFirstOrThrow();
        await appendAuditEvent(trx, context, {
          action: 'waiver.signed',
          entityType: 'waiver_signature',
          entityId: signatureId,
          changes: {
            documentVersion: { tier: 'internal', after: document.version },
            documentHash: { tier: 'restricted', after: hash.toString('hex') },
          },
          ip: request.ip,
          userAgent: request.userAgent,
        });
        return signatureView(row);
      });
    },

    async listSignatures(context: OrgContext, participantPersonId: string) {
      const personId = z.uuid().parse(participantPersonId);
      return withOrg(context, async (trx) => {
        const personIds = await mergedPersonLineage(
          trx,
          context.orgId,
          personId,
        );
        const linked = await trx
          .selectFrom('person_account_links')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('person_id', 'in', personIds)
          .where('account_id', '=', context.actor.accountId)
          .where('verified_at', 'is not', null)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        if (!linked) await requireDocumentManager(trx, context);
        const rows = await trx
          .selectFrom('waiver_signatures')
          .selectAll()
          .where('org_id', '=', context.orgId)
          .where('participant_person_id', 'in', personIds)
          .orderBy('signed_at', 'desc')
          .execute();
        return waiverSignatureListSchema.parse({
          items: rows.map(signatureView),
        });
      });
    },

    async signedPdf(
      context: OrgContext,
      signatureId: string,
    ): Promise<Uint8Array> {
      const id = z.uuid().parse(signatureId);
      return withOrg(context, async (trx) => {
        const row = await trx
          .selectFrom('waiver_signatures')
          .innerJoin('waiver_documents', (join) =>
            join
              .onRef(
                'waiver_documents.id',
                '=',
                'waiver_signatures.waiver_document_id',
              )
              .onRef(
                'waiver_documents.org_id',
                '=',
                'waiver_signatures.org_id',
              ),
          )
          .select([
            'waiver_signatures.id as id',
            'waiver_signatures.participant_person_id as participant_person_id',
            'waiver_signatures.signer_account_id as signer_account_id',
            'waiver_signatures.signer_name_typed as signer_name_typed',
            'waiver_signatures.method as method',
            'waiver_signatures.signed_at as signed_at',
            'waiver_signatures.document_hash as document_hash',
            'waiver_documents.name as name',
            'waiver_documents.body_html as body_html',
          ])
          .where('waiver_signatures.org_id', '=', context.orgId)
          .where('waiver_signatures.id', '=', id)
          .executeTakeFirst();
        if (!row)
          throw new WaiversError(
            404,
            'NOT_FOUND',
            'Signed waiver was not found',
          );
        if (row.signer_account_id !== context.actor.accountId) {
          const personIds = await mergedPersonLineage(
            trx,
            context.orgId,
            row.participant_person_id,
          );
          const linked = await trx
            .selectFrom('person_account_links')
            .select('id')
            .where('org_id', '=', context.orgId)
            .where('person_id', 'in', personIds)
            .where('account_id', '=', context.actor.accountId)
            .where('verified_at', 'is not', null)
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
          if (!linked) await requireDocumentManager(trx, context);
        }
        return renderPdf(
          row.name,
          bodyText(row.body_html),
          row.signer_name_typed,
          row.method,
          row.signed_at.toISOString(),
          row.document_hash.toString('hex'),
        );
      });
    },
  };
}
