import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import authEn from '../i18n/en/auth.json';
import authEs from '../i18n/es/auth.json';

function savedLanguage(): string | null {
  try {
    return typeof window === 'undefined'
      ? null
      : window.localStorage.getItem('athlentry-language');
  } catch {
    return null;
  }
}
const browserLanguage =
  typeof navigator === 'undefined' ? 'en' : navigator.language;
const preference = savedLanguage();
const initialLanguage =
  preference === 'es' || preference === 'en'
    ? preference
    : browserLanguage.toLowerCase().startsWith('es')
      ? 'es'
      : 'en';

void i18n.use(initReactI18next).init({
  resources: {
    en: { auth: authEn },
    es: { auth: authEs },
  },
  lng: initialLanguage,
  fallbackLng: 'en',
  supportedLngs: ['en', 'es'],
  defaultNS: 'auth',
  interpolation: { escapeValue: false },
  initAsync: false,
});

if (typeof document !== 'undefined')
  document.documentElement.lang = initialLanguage;
i18n.on('languageChanged', (language) => {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
  try {
    if (typeof window !== 'undefined')
      window.localStorage.setItem('athlentry-language', language);
  } catch {
    // Storage can be unavailable in private browsing and local test runners.
  }
});

export { i18n };
