import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract.js';

import {
  aidProgramCreateSchema,
  aidProgramListSchema,
  aidProgramReplaceSchema,
  aidProgramSchema,
} from './aid-programs.js';
import {
  aidDecisionBodySchema,
  aidDecisionResponseSchema,
  aidQueueSchema,
} from './aid-review.js';
import {
  autopayAuthorizationListSchema,
  staffMethodOptionsSchema,
} from './autopay-authorizations.js';
import { creditBalanceSchema } from './credit-balances.js';
import {
  glCodeBodySchema,
  glCodeListSchema,
  glCodeReplaceSchema,
  glCodeSchema,
} from './gl-codes.js';
import {
  installmentStaffActionSchema,
  installmentStaffListSchema,
  installmentStaffResultSchema,
} from './installment-staff-actions.js';
import {
  installmentTemplateBodySchema,
  installmentTemplateSchema,
  installmentTemplateListSchema,
} from './installment-templates.js';
import {
  journalMappingResponseSchema,
  journalMappingSaveSchema,
  journalMappingSchema,
} from './journal-mapping.js';
import {
  manualInstallmentIntentSchema,
  manualInstallmentListSchema,
} from './manual-installment-pay.js';
import { runFinanceNoticeJob } from './money-notice-job.js';
import { payerReceiptListSchema } from './payer-receipts.js';
import { payoutReconciliationSchema } from './reconciliation.js';
import {
  createFinanceRouter,
  offlinePaymentBodySchema,
  offlinePaymentReceiptSchema,
  refundBodySchema,
  refundResponseSchema,
  refundApprovalResponseSchema,
  refundApprovalDecisionSchema,
  payoutJournalBodySchema,
  payoutJournalResponseSchema,
  savedJournalResponseSchema,
  setupIntentResponseSchema,
  savedPaymentMethodsResponseSchema,
  staffCreditIssueSchema,
  staffCreditIssueResponseSchema,
  payerCreditApplySchema,
  payerCreditApplyResponseSchema,
  paymentMethodActionResponseSchema,
  connectLinkResponseSchema,
  connectStatusResponseSchema,
  checkoutPaymentBodySchema,
  checkoutPaymentResponseSchema,
  staffInvoiceBodySchema,
  staffInvoiceResponseSchema,
  aidAwardBodySchema,
  aidAwardResponseSchema,
  invoiceDetailSchema,
  voidInvoiceBodySchema,
  voidInvoiceResponseSchema,
  payerInvoiceListSchema,
  autopayRevocationResponseSchema,
  staffMethodConsentBodySchema,
  staffMethodConsentResponseSchema,
  stripeClientConfigSchema,
} from './routes.js';
import {
  taxRateBodySchema,
  taxRateListSchema,
  taxRateReplaceSchema,
  taxRateSchema,
} from './tax-rates.js';
import { yearEndStatementSchema } from './year-end-statements.js';

export const moduleDefinition = {
  name: 'finance',
  path: '/api/v1/finance',
  router: createFinanceRouter,
  jobs: [
    {
      name: 'finance.deliver-notices',
      cron: '* * * * *',
      run: runFinanceNoticeJob,
    },
  ],
  permissions: ['finance.manage'],
  notificationTypes: [],
  errorCodes: [],
  openapiRoutes: [
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/receipts',
      summary: 'List payer-owned settled payment receipts',
      response: payerReceiptListSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/invoices/{invoiceId}/pdf',
      summary: 'Download a payer-owned invoice PDF',
      response: z.string(),
      binary: true,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/payments/{paymentId}/receipt.pdf',
      summary: 'Download a reconciled payer payment receipt PDF',
      response: z.string(),
      binary: true,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/autopay/staff-method-options',
      summary: 'List payer invoices with unpaid future installments',
      response: staffMethodOptionsSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/me/autopay/staff-method-consents',
      summary:
        'Record payer consent for a saved method on one installment invoice',
      body: staffMethodConsentBodySchema,
      response: staffMethodConsentResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/autopay',
      summary: 'List payer-owned autopay mandates and future installments',
      response: autopayAuthorizationListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/me/autopay/{id}/revoke',
      summary: 'Revoke a payer mandate and stop future installment charges',
      response: autopayRevocationResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/statements/{year}',
      summary:
        'Read payer cash flows and donation allocations for an org tax year',
      response: yearEndStatementSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/tax-rates',
      summary: 'List product-only tax rates for finance staff',
      response: taxRateListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/tax-rates',
      summary: 'Create an idempotent product-only tax rate',
      body: taxRateBodySchema,
      response: taxRateSchema,
    },
    {
      method: 'put',
      path: '/api/v1/finance/orgs/{orgId}/tax-rates/{rateId}',
      summary: 'Replace a product-only tax rate at an exact version',
      body: taxRateReplaceSchema,
      response: taxRateSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/gl-codes',
      summary: 'List the organization GL code catalog',
      response: glCodeListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/gl-codes',
      summary: 'Create a versioned GL code with an idempotency key',
      body: glCodeBodySchema,
      response: glCodeSchema,
    },
    {
      method: 'put',
      path: '/api/v1/finance/orgs/{orgId}/gl-codes/{codeId}',
      summary: 'Replace a GL code at an exact version',
      body: glCodeReplaceSchema,
      response: glCodeSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/credits',
      summary: 'Issue an audited credit to a linked payer or active household',
      body: staffCreditIssueSchema,
      response: staffCreditIssueResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/me/credits/apply',
      summary: 'Apply payer-owned available credit to a billed invoice',
      body: payerCreditApplySchema,
      response: payerCreditApplyResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/credits',
      summary: 'Read payer-owned unexpired account and household credits',
      response: creditBalanceSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/aid-applications',
      summary: 'List restricted aid review metadata for finance staff',
      response: aidQueueSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/aid-applications/{applicationId}/decision',
      summary: 'Start review or decline an application at an exact version',
      body: aidDecisionBodySchema,
      response: aidDecisionResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/aid-programs',
      summary: 'List season aid funds for owner or finance staff',
      response: aidProgramListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/aid-programs',
      summary: 'Create an idempotent draft season aid fund',
      body: aidProgramCreateSchema,
      response: aidProgramSchema,
    },
    {
      method: 'put',
      path: '/api/v1/finance/orgs/{orgId}/aid-programs/{programId}',
      summary: 'Replace a season aid fund at an exact version',
      body: aidProgramReplaceSchema,
      response: aidProgramSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/aid-applications/{applicationId}/award',
      summary: 'Reserve a versioned aid award within the season budget',
      body: aidAwardBodySchema,
      response: aidAwardResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/invoices',
      summary:
        'List invoices billed to the signed-in account in one organization',
      response: payerInvoiceListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/invoices',
      summary: 'Issue an idempotent staff invoice with frozen refund terms',
      body: staffInvoiceBodySchema,
      response: staffInvoiceResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/invoices/{invoiceId}',
      summary: 'Read a finance invoice and its line ledger',
      response: invoiceDetailSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/invoices/{invoiceId}/void',
      summary: 'Void an unpaid invoice at an exact version',
      body: voidInvoiceBodySchema,
      response: voidInvoiceResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/stripe-client-config',
      summary:
        'Read the test-mode Stripe publishable key for authenticated payers',
      response: stripeClientConfigSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/me/installments',
      summary:
        'List payer-owned outstanding installments available for payment',
      response: manualInstallmentListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/me/installments/{installmentId}/payment-intents',
      summary: 'Reserve a payer-owned manual installment PaymentIntent',
      response: manualInstallmentIntentSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/invoices/{invoiceId}/installments',
      summary:
        'List a finance invoice installment schedule and active payer consents',
      response: installmentStaffListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/installments/{installmentId}/actions',
      summary: 'Change an installment due date or split it at an exact version',
      body: installmentStaffActionSchema,
      response: installmentStaffResultSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/installment-templates',
      summary: 'List active installment plan templates for an organization',
      response: installmentTemplateListSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/installment-templates',
      summary: 'Create a versioned installment plan template',
      body: installmentTemplateBodySchema,
      response: installmentTemplateSchema,
    },
    {
      method: 'patch',
      path: '/api/v1/finance/orgs/{orgId}/installment-templates/{templateId}',
      summary: 'Replace an installment plan template at an exact version',
      body: installmentTemplateBodySchema,
      response: installmentTemplateSchema,
    },
    {
      method: 'delete',
      path: '/api/v1/finance/orgs/{orgId}/installment-templates/{templateId}',
      summary: 'Archive an installment plan template at an exact version',
      response: paymentMethodActionResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/checkout-payment-intents',
      summary:
        'Create an idempotent test-mode PaymentIntent for a frozen checkout',
      body: checkoutPaymentBodySchema,
      response: checkoutPaymentResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/me/setup-intents',
      summary: 'Create a test-mode SetupIntent for the signed-in payer',
      response: setupIntentResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/me/payment-methods',
      summary: 'List saved payment methods for the signed-in payer',
      response: savedPaymentMethodsResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/me/payment-methods/{paymentMethodId}/default',
      summary: 'Set the signed-in payer default payment method',
      response: paymentMethodActionResponseSchema,
    },
    {
      method: 'delete',
      path: '/api/v1/finance/me/payment-methods/{paymentMethodId}',
      summary: 'Detach a saved payment method and revoke its autopay mandates',
      response: paymentMethodActionResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/connect/onboarding',
      summary: 'Create or resume Stripe Express onboarding',
      response: connectLinkResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/connect/continue',
      summary: 'Create a fresh Stripe Express onboarding link',
      response: connectLinkResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/connect/dashboard',
      summary: 'Open the enabled Stripe Express dashboard',
      response: connectLinkResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/connect/status',
      summary: 'Refresh Stripe Express requirements and payment capability',
      response: connectStatusResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/offline-payments',
      summary: 'Record an offline invoice payment',
      body: offlinePaymentBodySchema,
      response: offlinePaymentReceiptSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/refunds',
      summary: 'Create a policy-based refund to original method or credit',
      body: refundBodySchema,
      response: refundResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/refund-approvals',
      summary: 'Request a second finance approval for a refund',
      body: refundBodySchema,
      response: refundApprovalResponseSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/refund-approvals/{approvalId}/approve',
      summary: 'Approve a refund with a separate stepped-up finance session',
      response: refundApprovalDecisionSchema,
    },
    {
      method: 'post',
      path: '/api/v1/finance/orgs/{orgId}/payouts/{payoutId}/journal-export',
      summary: 'Export a reconciled payout journal with explicit GL codes',
      body: payoutJournalBodySchema,
      response: payoutJournalResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/journal-mapping',
      summary: 'Read the organization payout journal mapping',
      response: journalMappingResponseSchema,
    },
    {
      method: 'put',
      path: '/api/v1/finance/orgs/{orgId}/journal-mapping',
      summary: 'Save payout journal accounts at an exact version',
      body: journalMappingSaveSchema,
      response: journalMappingSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/payouts/{payoutId}/journal-export',
      summary:
        'Export a reconciled payout journal with saved organization accounts',
      response: savedJournalResponseSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/payouts/{payoutId}/reconciliation',
      summary: 'Read the payout and each matched Stripe movement',
      response: payoutReconciliationSchema,
    },
    {
      method: 'get',
      path: '/api/v1/finance/orgs/{orgId}/payouts/{payoutId}/reconciliation.csv',
      summary: 'Export the payout reconciliation as CSV',
      response: z.string(),
    },
  ],
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
