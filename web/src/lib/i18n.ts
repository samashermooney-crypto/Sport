import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import authEn from '../i18n/en/auth.json';
import consoleEn from '../i18n/en/console.json';
import platformEn from '../i18n/en/platform.json';
import portalEn from '../i18n/en/portal.json';
import publicEn from '../i18n/en/public.json';
import shellEn from '../i18n/en/shell.json';
import siteEn from '../i18n/en/site.json';
import authEs from '../i18n/es/auth.json';
import consoleEs from '../i18n/es/console.json';
import platformEs from '../i18n/es/platform.json';
import portalEs from '../i18n/es/portal.json';
import publicEs from '../i18n/es/public.json';
import shellEs from '../i18n/es/shell.json';
import siteEs from '../i18n/es/site.json';

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
    en: {
      auth: authEn,
      console: consoleEn,
      platform: platformEn,
      portal: portalEn,
      public: publicEn,
      shell: shellEn,
      site: siteEn,
    },
    es: {
      auth: authEs,
      console: consoleEs,
      platform: platformEs,
      portal: portalEs,
      public: publicEs,
      shell: shellEs,
      site: siteEs,
    },
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
