import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TurnstileWidget } from './TurnstileWidget';

afterEach(() => {
  delete window.turnstile;
  document.querySelector('script[src*="turnstile/v0/api.js"]')?.remove();
});

describe('Turnstile sign-up widget', () => {
  it('passes a challenge token to the form and removes the widget on unmount', () => {
    const remove = vi.fn();
    const renderWidget = vi.fn().mockReturnValue('widget-1');
    window.turnstile = { render: renderWidget, remove };
    const onToken = vi.fn();
    const view = render(
      <TurnstileWidget
        siteKey="public-test-key"
        onToken={onToken}
        onError={vi.fn()}
      />,
    );
    expect(renderWidget).toHaveBeenCalledOnce();
    const options = renderWidget.mock.calls[0]?.[1] as {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
    };
    expect(options.sitekey).toBe('public-test-key');
    expect(options.action).toBe('sign-up');
    act(() => {
      options.callback('single-use-proof');
    });
    expect(onToken).toHaveBeenCalledWith('single-use-proof');
    view.unmount();
    expect(remove).toHaveBeenCalledWith('widget-1');
  });
});
