import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  Combobox,
  DateRangeInput,
  FileUpload,
  MoneyInput,
  sanitizeRichHtml,
} from './extended';

describe('rich text allow-list', () => {
  it('keeps supported formatting while removing executable markup and attributes', () => {
    const sanitized = sanitizeRichHtml(
      '<p onclick="alert(1)">Hello <strong>team</strong><script>alert(2)</script></p><a href="javascript:alert(3)" title="safe">link</a><img src="x" onerror="alert(4)">',
    );

    expect(sanitized).toContain('<p>Hello <strong>team</strong>alert(2)</p>');
    expect(sanitized).toContain('<a title="safe">link</a>');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('<img');
  });

  it('allows secure links and strips unsupported attributes', () => {
    expect(
      sanitizeRichHtml(
        '<a href="https://example.invalid" target="_blank">Site</a>',
      ),
    ).toBe('<a href="https://example.invalid">Site</a>');
  });

  it('reports async combobox queries separately from selected option values', () => {
    const onChange = vi.fn();
    const onQueryChange = vi.fn();
    render(
      <Combobox
        label="Participant"
        options={[{ value: 'jordan', label: 'Jordan Lee' }]}
        value=""
        onChange={onChange}
        onQueryChange={onQueryChange}
      />,
    );
    const input = screen.getByRole('combobox', { name: 'Participant' });

    fireEvent.change(input, { target: { value: 'Jor' } });
    expect(onQueryChange).toHaveBeenLastCalledWith('Jor');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'Jordan Lee' } });
    expect(onChange).toHaveBeenLastCalledWith('jordan');
    expect(onQueryChange).toHaveBeenLastCalledWith('');
  });

  it('converts monetary input to integer cents without floating-point drift', () => {
    const onChange = vi.fn();
    render(<MoneyInput aria-label="Fee" value={0} onChange={onChange} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Fee' }), {
      target: { value: '1.005' },
    });
    expect(onChange).toHaveBeenLastCalledWith(101);
  });

  it('exposes both date-range changes and selected upload files', () => {
    const onStartChange = vi.fn();
    const onEndChange = vi.fn();
    const onFiles = vi.fn();
    const file = new File(['roster'], 'roster.csv', { type: 'text/csv' });
    render(
      <>
        <DateRangeInput
          start="2026-01-01"
          end="2026-01-31"
          onStartChange={onStartChange}
          onEndChange={onEndChange}
        />
        <FileUpload label="Roster file" onFiles={onFiles} />
      </>,
    );
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-02-01' },
    });
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-02-28' },
    });
    fireEvent.change(screen.getByLabelText('Roster file'), {
      target: { files: [file] },
    });
    expect(onStartChange).toHaveBeenLastCalledWith('2026-02-01');
    expect(onEndChange).toHaveBeenLastCalledWith('2026-02-28');
    expect((onFiles.mock.calls[0]?.[0] as FileList)[0]?.name).toBe(
      'roster.csv',
    );
  });
});
