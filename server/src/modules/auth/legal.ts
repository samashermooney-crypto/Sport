export const localLegalDocuments = {
  terms: {
    version: 'draft-2026-09-26',
    text: `DRAFT — requires legal review. Athlentry provides accounts for managing youth and amateur sports. You must provide accurate account information and use the service lawfully. A parent or guardian must manage registrations and legal consent for a child under 18. Organization rules and published program terms also apply. Report safety concerns to your organization immediately.`,
  },
  privacy: {
    version: 'draft-2026-09-26',
    text: `DRAFT — requires legal review. Athlentry stores account identity, contact information, date of birth, organization memberships, and sports activity to operate the service. Organizations control their own participant records. Sensitive medical and safety details are limited to authorized roles. We use necessary cookies for sign-in and do not use account data for advertising. You may request access, correction, or deletion subject to required legal retention.`,
  },
} as const;

export const localLegalDocumentsEs = {
  terms: {
    version: 'draft-2026-09-26-es',
    text: 'BORRADOR — requiere revisión legal. Athlentry ofrece cuentas para administrar deportes juveniles y aficionados. Debes proporcionar información correcta sobre tu cuenta y utilizar el servicio conforme a la ley. Un padre, madre o tutor debe gestionar las inscripciones y el consentimiento legal de los menores de 18 años. También se aplican las reglas de la organización y las condiciones publicadas del programa. Informa inmediatamente a tu organización sobre cualquier preocupación de seguridad.',
  },
  privacy: {
    version: 'draft-2026-09-26-es',
    text: 'BORRADOR — requiere revisión legal. Athlentry almacena la identidad de la cuenta, los datos de contacto, la fecha de nacimiento, las membresías en organizaciones y la actividad deportiva para operar el servicio. Las organizaciones controlan sus propios registros de participantes. Los datos médicos y de seguridad sensibles están limitados a los roles autorizados. Utilizamos cookies necesarias para iniciar sesión y no usamos los datos de la cuenta para publicidad. Puedes solicitar acceso, corrección o eliminación, sujeto a los plazos de conservación exigidos por ley.',
  },
} as const;

export function legalDocumentsForLocale(locale: 'en' | 'es') {
  return locale === 'es' ? localLegalDocumentsEs : localLegalDocuments;
}
