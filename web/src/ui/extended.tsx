import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import qrcodeGenerator from 'qrcode';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Button, Card, Input, Select, Textarea } from './primitives';

const toDateKey = (date: Date): string =>
  `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1)
    .toString()
    .padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`;

export function DateInput(
  props: InputHTMLAttributes<HTMLInputElement>,
): React.JSX.Element {
  return <Input {...props} type="date" />;
}
export function TimeInput(
  props: InputHTMLAttributes<HTMLInputElement>,
): React.JSX.Element {
  return <Input {...props} type="time" />;
}
export function DateRangeInput({
  start,
  end,
  onStartChange,
  onEndChange,
}: {
  start: string;
  end: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <div className="ui-date-range">
      <label>
        From
        <DateInput
          aria-label="Start date"
          value={start}
          onChange={(event) => {
            onStartChange(event.target.value);
          }}
        />
      </label>
      <span aria-hidden="true">to</span>
      <label>
        To
        <DateInput
          aria-label="End date"
          value={end}
          onChange={(event) => {
            onEndChange(event.target.value);
          }}
        />
      </label>
    </div>
  );
}
export function MoneyInput({
  value,
  onChange,
  currency = 'USD',
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number | '';
  onChange: (cents: number | '') => void;
  currency?: string;
}): React.JSX.Element {
  return (
    <span className="ui-money-input">
      <span aria-hidden="true">
        {new Intl.NumberFormat('en-US', { style: 'currency', currency })
          .format(0)
          .replace(/[\d.,\s]/g, '')}
      </span>
      <Input
        {...props}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={value === '' ? '' : (value / 100).toFixed(2)}
        onChange={(event) => {
          onChange(dollarsToCents(event.target.value));
        }}
      />
    </span>
  );
}

function dollarsToCents(value: string): number | '' {
  if (value === '') return '';
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match) return '';
  const whole = BigInt(match[1] || '0');
  const fraction = match[2] ?? '';
  const cents = BigInt((fraction + '00').slice(0, 2));
  const rounded = cents + (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);
  return Number(whole * 100n + rounded);
}
export function PhoneInput(
  props: InputHTMLAttributes<HTMLInputElement>,
): React.JSX.Element {
  return <Input {...props} type="tel" autoComplete="tel" inputMode="tel" />;
}
export function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder = 'Select…',
  loading = false,
  onQueryChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  loading?: boolean;
  onQueryChange?: (query: string) => void;
}): React.JSX.Element {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const selected = options.find((option) => option.value === value);
  const inputValue = query ?? selected?.label ?? value;
  return (
    <span className="ui-combobox">
      <input
        aria-label={label}
        aria-busy={loading}
        aria-autocomplete="list"
        list={`${id}-options`}
        value={inputValue}
        placeholder={placeholder}
        onChange={(event) => {
          const query = event.target.value;
          const option = options.find((candidate) => candidate.label === query);
          if (option) {
            setQuery(null);
            onChange(option.value);
            onQueryChange?.('');
            return;
          }
          setQuery(query);
          if (!query) onChange('');
          onQueryChange?.(query);
        }}
      />
      <datalist id={`${id}-options`}>
        {options.map((option) => (
          <option key={option.value} value={option.label} />
        ))}
      </datalist>
      {loading && <span role="status">Searching…</span>}
    </span>
  );
}
export function FileUpload({
  label = 'Choose file',
  accept,
  multiple,
  onFiles,
}: {
  label?: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: FileList | null) => void;
}): React.JSX.Element {
  const id = useId();
  return (
    <label className="ui-file-upload">
      <span>{label}</span>
      <input
        id={id}
        aria-label={label}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(event) => {
          onFiles(event.target.files);
        }}
      />
    </label>
  );
}
export function Avatar({
  name,
  src,
  size = 'medium',
}: {
  name: string;
  src?: string | null;
  size?: 'small' | 'medium' | 'large';
}): React.JSX.Element {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  return (
    <span
      className={`ui-avatar ui-avatar-${size}`}
      role="img"
      aria-label={name}
    >
      {src ? <img src={src} alt="" /> : initials}
    </span>
  );
}
export function Tag({
  children,
  onRemove,
  removeLabel = 'tag',
}: PropsWithChildren<{
  onRemove?: () => void;
  removeLabel?: string;
}>): React.JSX.Element {
  return (
    <span className="ui-tag">
      {children}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${removeLabel}`}
          onClick={onRemove}
        >
          ×
        </button>
      )}
    </span>
  );
}
export function DataList({
  items,
}: {
  items: { label: ReactNode; value: ReactNode }[];
}): React.JSX.Element {
  return (
    <dl className="ui-data-list">
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Calendar({
  events,
  view = 'month',
  initialDate,
  onViewChange,
  resources,
}: {
  events: {
    id: string;
    title: string;
    date: string;
    time?: string;
    endTime?: string;
    resource?: string;
  }[];
  view?: 'month' | 'week' | 'day' | 'agenda' | 'resource';
  initialDate?: string;
  onViewChange?: (
    view: 'month' | 'week' | 'day' | 'agenda' | 'resource',
  ) => void;
  resources?: string[];
}): React.JSX.Element {
  const [cursor, setCursor] = useState(
    () => new Date(`${initialDate ?? toDateKey(new Date())}T00:00:00`),
  );
  const [localView, setLocalView] = useState(view);
  const calendarGridRef = useRef<HTMLDivElement>(null);
  const activeView = onViewChange ? view : localView;
  const monthHeading = cursor.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  const days = useMemo(() => {
    if (activeView === 'day') return [new Date(cursor)];
    if (activeView === 'week') {
      const start = new Date(cursor);
      start.setDate(cursor.getDate() - cursor.getDay());
      return Array.from({ length: 7 }, (_, index) => {
        const day = new Date(start);
        day.setDate(start.getDate() + index);
        return day;
      });
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(first.getDate() - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      return day;
    });
  }, [activeView, cursor]);
  const heading =
    activeView === 'day'
      ? cursor.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      : activeView === 'week'
        ? `${days[0]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) ?? ''} – ${days[6]?.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) ?? ''}`
        : activeView === 'resource'
          ? cursor.toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })
          : monthHeading;
  const moveCursor = (direction: -1 | 1) => {
    const next = new Date(cursor);
    if (activeView === 'day') next.setDate(cursor.getDate() + direction);
    else if (activeView === 'week')
      next.setDate(cursor.getDate() + 7 * direction);
    else next.setMonth(cursor.getMonth() + direction);
    setCursor(next);
  };
  const moveGridFocus = (
    event: React.KeyboardEvent<HTMLDivElement>,
    day: Date,
  ) => {
    const dayDelta: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const delta = dayDelta[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = new Date(day);
    next.setDate(day.getDate() + delta);
    setCursor(next);
    requestAnimationFrame(() => {
      calendarGridRef.current
        ?.querySelector<HTMLElement>(`[data-date="${toDateKey(next)}"]`)
        ?.focus();
    });
  };
  const views = [
    'month',
    'week',
    'day',
    'agenda',
    ...(resources ? ['resource' as const] : []),
  ] as const;
  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const visibleEvents = events.filter((event) => {
    if (activeView === 'resource') return event.date === toDateKey(cursor);
    const date = new Date(`${event.date}T00:00:00`);
    return firstDay && lastDay && date >= firstDay && date <= lastDay;
  });
  return (
    <section className={`ui-calendar ui-calendar-${activeView}`}>
      <header>
        <div>
          <Button
            secondary
            onClick={() => {
              moveCursor(-1);
            }}
            aria-label={`Previous ${activeView}`}
          >
            ‹
          </Button>
          <Button
            secondary
            onClick={() => {
              setCursor(new Date());
            }}
          >
            Today
          </Button>
          <Button
            secondary
            onClick={() => {
              moveCursor(1);
            }}
            aria-label={`Next ${activeView}`}
          >
            ›
          </Button>
          <h2>{heading}</h2>
        </div>
        <div role="group" aria-label="Calendar view">
          {views.map((item) => (
            <Button
              key={item}
              secondary={activeView !== item}
              aria-pressed={activeView === item}
              onClick={() => {
                if (!onViewChange) setLocalView(item);
                onViewChange?.(item);
              }}
            >
              {item}
            </Button>
          ))}
        </div>
      </header>
      {activeView === 'resource' && resources ? (
        <div
          className="ui-resource-calendar"
          role="table"
          aria-label={`Resource schedule for ${heading}`}
        >
          <div className="ui-resource-time" role="row">
            <strong role="columnheader">Space</strong>
            {Array.from({ length: 16 }, (_, index) => index + 6).map((hour) => (
              <time role="columnheader" key={hour}>
                {new Date(2000, 0, 1, hour).toLocaleTimeString('en-US', {
                  hour: 'numeric',
                })}
              </time>
            ))}
          </div>
          {resources.map((resource) => (
            <div className="ui-resource-row" role="row" key={resource}>
              <strong role="rowheader">{resource}</strong>
              <div
                className="ui-resource-slots"
                role="cell"
                aria-colspan={16}
                aria-label={`${resource} time slots`}
              >
                {Array.from({ length: 16 }, (_, index) => (
                  <span aria-hidden="true" key={index} />
                ))}
                {visibleEvents
                  .filter((event) => event.resource === resource)
                  .map((event) => {
                    const [hourText = '8', minuteText = '0'] =
                      event.time?.split(':') ?? [];
                    const parsedStart =
                      Number(hourText) + Number(minuteText) / 60;
                    const startHour = Math.max(
                      6,
                      Math.min(
                        21,
                        Number.isFinite(parsedStart) ? parsedStart : 8,
                      ),
                    );
                    const startSlot = Math.floor(startHour - 6);
                    const endHour = event.endTime
                      ? Number(event.endTime.slice(0, 2)) +
                        Number(event.endTime.slice(3, 5)) / 60
                      : startHour + 1;
                    const duration = Math.max(
                      1,
                      Math.min(
                        22,
                        Number.isFinite(endHour) ? endHour : startHour + 1,
                      ) - startHour,
                    );
                    return (
                      <span
                        className="ui-resource-event"
                        key={event.id}
                        style={{
                          gridColumn: `${(startSlot + 1).toString()} / span ${Math.ceil(duration).toString()}`,
                        }}
                        title={`${event.time ?? '8:00'} · ${event.title}`}
                      >
                        {event.time && `${event.time} · `}
                        {event.title}
                      </span>
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      ) : activeView === 'agenda' ? (
        <ol className="ui-calendar-agenda">
          {[...visibleEvents]
            .sort(
              (a, b) =>
                a.date.localeCompare(b.date) ||
                (a.time ?? '').localeCompare(b.time ?? ''),
            )
            .map((event) => (
              <li key={event.id}>
                <time dateTime={event.date}>
                  {event.date} {event.time}
                </time>
                <span>{event.title}</span>
              </li>
            ))}
        </ol>
      ) : (
        <div
          className={`ui-month-grid ui-grid-${activeView}`}
          role="grid"
          aria-label={heading}
          ref={calendarGridRef}
        >
          {activeView !== 'day' && (
            <div className="ui-calendar-grid-row" role="row">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <strong role="columnheader" key={day}>
                  {day}
                </strong>
              ))}
            </div>
          )}
          {(activeView === 'month'
            ? Array.from({ length: 6 }, (_, index) =>
                days.slice(index * 7, index * 7 + 7),
              )
            : [days]
          ).map((week) => (
            <div
              className="ui-calendar-grid-row"
              role="row"
              key={week[0] ? toDateKey(week[0]) : 'empty'}
            >
              {week.map((day) => {
                const dateKey = toDateKey(day);
                return (
                  <div
                    role="gridcell"
                    aria-label={day.toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                    aria-selected={dateKey === toDateKey(cursor)}
                    tabIndex={dateKey === toDateKey(cursor) ? 0 : -1}
                    data-date={dateKey}
                    key={dateKey}
                    className={
                      activeView === 'month' &&
                      day.getMonth() !== cursor.getMonth()
                        ? 'outside'
                        : ''
                    }
                    onKeyDown={(event) => {
                      moveGridFocus(event, day);
                    }}
                    onFocus={() => {
                      if (dateKey !== toDateKey(cursor)) setCursor(day);
                    }}
                  >
                    <time dateTime={dateKey}>{day.getDate()}</time>
                    {visibleEvents
                      .filter((event) => event.date === dateKey)
                      .map((event) => (
                        <span className="ui-calendar-event" key={event.id}>
                          {event.time && `${event.time} · `}
                          {event.title}
                        </span>
                      ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
export function Timeline({
  items,
}: {
  items: { title: string; date: string; detail?: ReactNode; tone?: string }[];
}): React.JSX.Element {
  return (
    <ol className="ui-timeline">
      {items.map((item, index) => (
        <li key={`${item.date}-${index.toString()}`} className={item.tone}>
          <time>{item.date}</time>
          <div>
            <strong>{item.title}</strong>
            {item.detail && <p>{item.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
export function StatTile({
  label,
  value,
  detail,
  trend,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  trend?: 'up' | 'down';
}): React.JSX.Element {
  return (
    <Card className="ui-stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && (
        <small className={trend ? `trend-${trend}` : ''}>{detail}</small>
      )}
    </Card>
  );
}
export function Chart({
  title,
  values,
  tone = 'accent',
}: {
  title: string;
  values: { label: string; value: number }[];
  tone?: 'accent' | 'ok' | 'warn' | 'bad' | 'chrome';
}): React.JSX.Element {
  const colors = {
    accent: 'var(--accent)',
    ok: 'var(--ok)',
    warn: 'var(--warn)',
    bad: 'var(--bad)',
    chrome: 'var(--chrome)',
  } as const;
  const label = `${title}: ${values
    .map((item) => `${item.label} ${item.value.toString()}`)
    .join(', ')}`;
  return (
    <figure className="ui-chart">
      <figcaption>{title}</figcaption>
      <div className="ui-chart-canvas" role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart
            data={values}
            margin={{ top: 8, right: 8, bottom: 4, left: 0 }}
          >
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis
              dataKey="label"
              axisLine={{ stroke: 'var(--line)' }}
              tickLine={{ stroke: 'var(--line)' }}
              tick={{
                fill: 'var(--muted)',
                fontSize: 'var(--font-size-11)',
                fontFamily: 'var(--font-app)',
              }}
            />
            <YAxis
              allowDecimals={false}
              axisLine={{ stroke: 'var(--line)' }}
              tickLine={{ stroke: 'var(--line)' }}
              tick={{
                fill: 'var(--muted)',
                fontSize: 'var(--font-size-11)',
                fontFamily: 'var(--font-app)',
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-3)',
                boxShadow: 'var(--shadow-06)',
                color: 'var(--ink-2)',
                fontFamily: 'var(--font-app)',
                fontSize: 'var(--font-size-11)',
              }}
              labelStyle={{ color: 'var(--muted)', fontWeight: 600 }}
              itemStyle={{ color: 'var(--accent-600)' }}
            />
            <Bar dataKey="value" fill={colors[tone]} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
export function RichTextEditor({
  value,
  onChange,
  label = 'Message',
  maxLength = 65500,
  disabled = false,
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  maxLength?: number;
  disabled?: boolean;
}): React.JSX.Element {
  const [linkInput, setLinkInput] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TableKit,
    ],
    content: sanitizeRichHtml(value),
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'ui-rich-editable',
        role: 'textbox',
        'aria-label': label,
        'aria-multiline': 'true',
      },
    },
    onUpdate: ({ editor: updatedEditor }) => {
      onChangeRef.current(sanitizeRichHtml(updatedEditor.getHTML()));
    },
  });
  useEffect(() => {
    if (editor && !editor.isFocused) {
      const sanitized = sanitizeRichHtml(value);
      if (sanitizeRichHtml(editor.getHTML()) !== sanitized) {
        editor.commands.setContent(sanitized, { emitUpdate: false });
      }
    }
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);
  const applyLink = () => {
    const url = linkInput.trim();
    if (/^(https?:\/\/|mailto:)/i.test(url)) {
      editor?.chain().focus().setLink({ href: url }).run();
    }
    setLinkInput('');
    setLinkOpen(false);
  };
  const toolbarActions: {
    description: string;
    text: string;
    action: () => void;
  }[] = [
    {
      description: 'Bold',
      text: 'B',
      action: () => {
        editor?.chain().focus().toggleBold().run();
      },
    },
    {
      description: 'Italic',
      text: 'I',
      action: () => {
        editor?.chain().focus().toggleItalic().run();
      },
    },
    {
      description: 'Underline',
      text: 'U',
      action: () => {
        editor?.chain().focus().toggleUnderline().run();
      },
    },
    {
      description: 'Bulleted list',
      text: '• List',
      action: () => {
        editor?.chain().focus().toggleBulletList().run();
      },
    },
    {
      description: 'Numbered list',
      text: '1. List',
      action: () => {
        editor?.chain().focus().toggleOrderedList().run();
      },
    },
    {
      description: 'Undo',
      text: '↶',
      action: () => {
        editor?.chain().focus().undo().run();
      },
    },
    {
      description: 'Redo',
      text: '↷',
      action: () => {
        editor?.chain().focus().redo().run();
      },
    },
    {
      description: 'Insert table',
      text: 'Table',
      action: () => {
        editor
          ?.chain()
          .focus()
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run();
      },
    },
  ];
  return (
    <div className="ui-rich-editor">
      <div className="ui-rich-editor-label">{label}</div>
      <div
        className="ui-rich-toolbar"
        role="toolbar"
        aria-label="Text formatting"
      >
        {toolbarActions.map(({ description, text, action }) => (
          <button
            key={description}
            type="button"
            disabled={disabled || !editor}
            aria-label={description}
            title={description}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={action}
          >
            {text}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled || !editor}
          aria-label="Insert link"
          title="Insert link"
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={() => {
            setLinkOpen((open) => !open);
          }}
        >
          Link
        </button>
        <select
          disabled={disabled || !editor}
          aria-label="Text style"
          defaultValue="p"
          onChange={(event) => {
            if (!editor) return;
            if (event.target.value === 'h2')
              editor.chain().focus().toggleHeading({ level: 2 }).run();
            else if (event.target.value === 'h3')
              editor.chain().focus().toggleHeading({ level: 3 }).run();
            else if (event.target.value === 'blockquote')
              editor.chain().focus().toggleBlockquote().run();
            else editor.chain().focus().setParagraph().run();
          }}
        >
          <option value="p">Paragraph</option>
          <option value="h2">Heading</option>
          <option value="h3">Subheading</option>
          <option value="blockquote">Quote</option>
        </select>
      </div>
      {linkOpen && (
        <form
          className="ui-rich-link-form"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
        >
          <Input
            type="text"
            aria-label="Link URL"
            placeholder="https://…"
            value={linkInput}
            onChange={(event) => {
              setLinkInput(event.target.value);
            }}
          />
          <Button type="submit" disabled={!linkInput.trim()}>
            Apply link
          </Button>
        </form>
      )}
      <EditorContent
        editor={editor}
        onPaste={(event) => {
          if (disabled || !editor) return;
          event.preventDefault();
          const html = event.clipboardData.getData('text/html');
          editor.commands.insertContent(
            html
              ? sanitizeRichHtml(html)
              : event.clipboardData.getData('text/plain'),
          );
        }}
      />
      <small className={value.length > maxLength ? 'required' : ''}>
        {value.length.toLocaleString()} / {maxLength.toLocaleString()}{' '}
        characters
      </small>
    </div>
  );
}

const richTextTags = new Set([
  'P',
  'BR',
  'STRONG',
  'B',
  'EM',
  'I',
  'U',
  'S',
  'UL',
  'OL',
  'LI',
  'H1',
  'H2',
  'H3',
  'BLOCKQUOTE',
  'A',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TH',
  'TD',
  'HR',
]);
export function sanitizeRichHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const element of [...parsed.body.querySelectorAll('*')]) {
    if (!richTextTags.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const allowed =
        attribute.name === 'title' ||
        (element.tagName === 'A' && attribute.name === 'href');
      if (!allowed) element.removeAttribute(attribute.name);
    }
    if (element.tagName === 'A') {
      const href = element.getAttribute('href') ?? '';
      if (!/^(https?:\/\/|mailto:)/i.test(href))
        element.removeAttribute('href');
    }
  }
  return parsed.body.innerHTML;
}
export function SignaturePad({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const id = useId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    context?.clearRect(0, 0, canvas.width, canvas.height);
    if (!value.startsWith('data:image/')) return;
    const image = new Image();
    image.onload = () =>
      context?.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.src = value;
  }, [value]);
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) * canvas.width) / bounds.width,
      y: ((event.clientY - bounds.top) * canvas.height) / bounds.height,
    };
  };
  const startDrawing = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    const location = point(event);
    if (!canvas || !context || !location) return;
    canvas.setPointerCapture(event.pointerId);
    context.beginPath();
    context.moveTo(location.x, location.y);
    context.lineWidth = 2;
    context.lineCap = 'round';
    context.strokeStyle = getComputedStyle(canvas).color;
    drawing.current = true;
  };
  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const location = point(event);
    const context = canvasRef.current?.getContext('2d');
    if (!location || !context) return;
    context.lineTo(location.x, location.y);
    context.stroke();
  };
  const finishDrawing = () => {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (canvas) onChange(canvas.toDataURL('image/png'));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    onChange('');
  };
  return (
    <div className="ui-signature-pad">
      <label htmlFor={`${id}-canvas`}>Draw your signature</label>
      <canvas
        id={`${id}-canvas`}
        ref={canvasRef}
        width={720}
        height={140}
        aria-label="Signature drawing area"
        onPointerDown={startDrawing}
        onPointerMove={draw}
        onPointerUp={finishDrawing}
        onPointerCancel={finishDrawing}
      />
      <div>
        <label>
          Or type your full legal name
          <Input
            aria-label="Typed signature"
            autoComplete="name"
            value={value.startsWith('data:image/') ? '' : value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </label>
        {Boolean(value) && (
          <Button type="button" secondary onClick={clear}>
            Clear signature
          </Button>
        )}
      </div>
    </div>
  );
}
export function QRCode({
  value,
  label = 'QR code',
}: {
  value: string;
  label?: string;
}): React.JSX.Element {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    setSrc('');
    void qrcodeGenerator
      .toDataURL(value, { margin: 1, width: 192 })
      .then((data) => {
        if (live) setSrc(data);
      });
    return () => {
      live = false;
    };
  }, [value]);
  return src ? (
    <img className="ui-qr-code" src={src} alt={label} />
  ) : (
    <span role="status">Preparing {label}…</span>
  );
}
export function PrintLayout({
  children,
}: PropsWithChildren): React.JSX.Element {
  return <article className="ui-print-layout">{children}</article>;
}

export type BoardItem = { id: string; label: string; detail?: ReactNode };
export function Board({
  columns,
  onMove,
}: {
  columns: { id: string; title: string; items: BoardItem[] }[];
  onMove: (itemId: string, columnId: string) => void;
}): React.JSX.Element {
  const [moving, setMoving] = useState<string | null>(null);
  return (
    <div className="ui-board">
      {columns.map((column) => (
        <section
          key={column.id}
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const id = event.dataTransfer.getData('text/plain');
            if (id) onMove(id, column.id);
            setMoving(null);
          }}
        >
          <h2>
            {column.title}
            <span>{column.items.length}</span>
          </h2>
          {column.items.map((item) => (
            <Card
              key={item.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', item.id);
                setMoving(item.id);
              }}
              onDragEnd={() => {
                setMoving(null);
              }}
              className={moving === item.id ? 'is-moving' : ''}
            >
              <strong>{item.label}</strong>
              {item.detail}
              <label>
                Move to{' '}
                <Select
                  aria-label={`Move ${item.label} to`}
                  value=""
                  onChange={(event) => {
                    if (event.target.value) onMove(item.id, event.target.value);
                  }}
                >
                  <option value="">Choose column</option>
                  {columns
                    .filter((candidate) => candidate.id !== column.id)
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.title}
                      </option>
                    ))}
                </Select>
              </label>
            </Card>
          ))}
        </section>
      ))}
    </div>
  );
}

export function Bracket({
  rounds,
}: {
  rounds: {
    title: string;
    matches: { id: string; home: string; away: string; result?: string }[];
  }[];
}): React.JSX.Element {
  return (
    <div className="ui-bracket">
      {rounds.map((round) => (
        <section key={round.title}>
          <h2>{round.title}</h2>
          {round.matches.map((match) => (
            <Card key={match.id}>
              <span>{match.home}</span>
              <span>{match.away}</span>
              {match.result && <small>{match.result}</small>}
            </Card>
          ))}
        </section>
      ))}
    </div>
  );
}

export function ChatThread({
  messages,
  onSend,
}: {
  messages: { id: string; author: string; body: string; sentAt: string }[];
  onSend: (body: string) => void;
}): React.JSX.Element {
  const [body, setBody] = useState('');
  return (
    <section className="ui-chat-thread">
      <ol aria-label="Conversation messages">
        {messages.map((message) => (
          <li key={message.id}>
            <div>
              <strong>{message.author}</strong>
              <time>{message.sentAt}</time>
            </div>
            <p>{message.body}</p>
          </li>
        ))}
      </ol>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!body.trim()) return;
          onSend(body.trim());
          setBody('');
        }}
      >
        <Textarea
          aria-label="Write a message"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        <Button disabled={!body.trim()}>Send</Button>
      </form>
    </section>
  );
}
