import { useEffect, useRef } from 'react';

interface TurnstileClient {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: 'light';
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileClient;
  }
}

const scriptUrl =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export function TurnstileWidget({
  siteKey,
  onToken,
  onError,
}: {
  siteKey: string;
  onToken: (token: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let widgetId: string | undefined;
    function render(): void {
      if (!active || !container.current || !window.turnstile || widgetId)
        return;
      widgetId = window.turnstile.render(container.current, {
        sitekey: siteKey,
        action: 'sign-up',
        theme: 'light',
        callback: onToken,
        'expired-callback': () => {
          onToken('');
          onError('Challenge expired. Complete it again.');
        },
        'error-callback': () => {
          onToken('');
          onError('Challenge could not load. Try again.');
        },
      });
    }
    function scriptError(): void {
      if (active) onError('Challenge could not load. Try again.');
    }
    let script = document.querySelector<HTMLScriptElement>(
      `script[src="${scriptUrl}"]`,
    );
    if (!script) {
      script = document.createElement('script');
      script.src = scriptUrl;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener('load', render);
    script.addEventListener('error', scriptError);
    render();
    return () => {
      active = false;
      script.removeEventListener('load', render);
      script.removeEventListener('error', scriptError);
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, onToken, onError]);

  return <div ref={container} aria-label="Bot protection challenge" />;
}
