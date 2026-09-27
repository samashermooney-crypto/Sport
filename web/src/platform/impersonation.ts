import { useEffect, useState } from 'react';

const storageKey = 'athlentry.impersonation';
const changeEvent = 'athlentry:impersonation';

export function currentImpersonationId(): string | null {
  return typeof window === 'undefined'
    ? null
    : window.sessionStorage.getItem(storageKey);
}

export function impersonationHeaders(
  id: string | null,
): Record<string, string> {
  return id ? { 'X-Athlentry-Impersonation': id } : {};
}

export function clearImpersonation(): void {
  window.sessionStorage.removeItem(storageKey);
  window.dispatchEvent(new Event(changeEvent));
}

export function useImpersonationId(): string | null {
  const [id, setId] = useState(currentImpersonationId);
  useEffect(() => {
    const sync = () => {
      setId(currentImpersonationId());
    };
    window.addEventListener(changeEvent, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(changeEvent, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return id;
}
