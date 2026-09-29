import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiToolsScreen } from './AiToolsScreen';

describe('AI tools feature gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders no AI UI and makes no request when disabled', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const view = render(<AiToolsScreen orgId="org-demo" enabled={false} />);

    expect(view.container.firstChild).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
