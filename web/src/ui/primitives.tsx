import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { Fragment, cloneElement, isValidElement, useId, useState } from 'react';
import { Link as RouterLink } from 'react-router';

const join = (...values: (string | undefined | false)[]) =>
  values.filter(Boolean).join(' ');

export function Button({
  secondary,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  secondary?: boolean;
}): React.JSX.Element {
  return (
    <button
      {...props}
      className={join('button', secondary && 'secondary', className)}
    />
  );
}

export function IconButton({
  label,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
}): React.JSX.Element {
  return (
    <button
      {...props}
      aria-label={label}
      className={join('icon-button', className)}
    />
  );
}

export function Link({
  to,
  children,
  className,
  ...props
}: PropsWithChildren<
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string }
>): React.JSX.Element {
  return (
    <RouterLink to={to} {...props} className={join('ui-link', className)}>
      {children}
    </RouterLink>
  );
}

type FieldProps = PropsWithChildren<{
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  error?: string | undefined;
  className?: string;
}>;
export function Field({
  label,
  children,
  required,
  hint,
  error,
  className,
}: FieldProps): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const control = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, {
        id: (children.props as { id?: string }).id ?? id,
        'aria-invalid': Boolean(error),
        'aria-describedby':
          [hint ? hintId : '', error ? errorId : '']
            .filter(Boolean)
            .join(' ') || undefined,
      })
    : children;
  return (
    <label className={join('field', className)}>
      <span>
        {label}
        {required && <b className="required"> *</b>}
      </span>
      {control}
      {hint && <small id={hintId}>{hint}</small>}
      {error && (
        <small id={errorId} className="field-error" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}

export function Input(
  props: InputHTMLAttributes<HTMLInputElement>,
): React.JSX.Element {
  return <input {...props} className={join('ui-input', props.className)} />;
}
export function Textarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
): React.JSX.Element {
  return (
    <textarea {...props} className={join('ui-textarea', props.className)} />
  );
}
export function Select({
  options,
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  options?: (string | { value: string; label: string })[];
}): React.JSX.Element {
  return (
    <span className="select-wrap">
      <select {...props} className={join(className)}>
        {options?.map((option) =>
          typeof option === 'string' ? (
            <option key={option}>{option}</option>
          ) : (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ),
        )}
        {props.children}
      </select>
      <span className="select-chevron" aria-hidden="true">
        ⌄
      </span>
    </span>
  );
}
export function Checkbox(
  props: InputHTMLAttributes<HTMLInputElement>,
): React.JSX.Element {
  return (
    <input
      {...props}
      type="checkbox"
      className={join('ui-checkbox', props.className)}
    />
  );
}
export function Radio(
  props: InputHTMLAttributes<HTMLInputElement>,
): React.JSX.Element {
  return (
    <input
      {...props}
      type="radio"
      className={join('ui-radio', props.className)}
    />
  );
}
export function Switch({
  label,
  checked,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
}): React.JSX.Element {
  return (
    <label className="ui-switch">
      <input {...props} type="checkbox" role="switch" checked={checked} />
      <span className="ui-switch-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?:
    'neutral' | 'confirmed' | 'pending' | 'wait-list' | 'bad' | 'ok' | 'warn';
}): React.JSX.Element {
  const oldTone = tone === 'neutral' ? '' : tone;
  return <span {...props} className={join('badge', oldTone, className)} />;
}
export function StatusPill(
  props: Parameters<typeof Badge>[0],
): React.JSX.Element {
  return <Badge {...props} />;
}

export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return <section {...props} className={join('ui-card', className)} />;
}
export function Table({
  className,
  ...props
}: HTMLAttributes<HTMLTableElement>): React.JSX.Element {
  return <table {...props} className={join('ui-table', className)} />;
}

export type Column<T> = {
  key: string;
  label: ReactNode;
  render?: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  className?: string;
};
export function DataTable<T extends { id: string }>({
  rows,
  columns,
  empty = 'No records match your filters.',
  selectable = false,
  selected = [],
  onSelectionChange,
  mobileCards = true,
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: ReactNode;
  selectable?: boolean;
  selected?: string[];
  onSelectionChange?: (ids: string[]) => void;
  mobileCards?: boolean;
}): React.JSX.Element {
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(
    null,
  );
  const column = columns.find((candidate) => candidate.key === sort?.key);
  const ordered = [...rows];
  if (sort && column?.sort)
    ordered.sort((left, right) => {
      const a = column.sort?.(left) ?? '';
      const b = column.sort?.(right) ?? '';
      return (
        (typeof a === 'number' && typeof b === 'number'
          ? a - b
          : String(a).localeCompare(String(b))) * sort.direction
      );
    });
  const updateSelected = (id: string, checked: boolean) =>
    onSelectionChange?.(
      checked
        ? [...new Set([...selected, id])]
        : selected.filter((value) => value !== id),
    );
  const getValue = (row: T, item: Column<T>): ReactNode =>
    item.render
      ? item.render(row)
      : (() => {
          const value = (row as Record<string, unknown>)[item.key];
          return value === null || value === undefined
            ? '—'
            : typeof value === 'string' || typeof value === 'number'
              ? value
              : '—';
        })();
  return (
    <div
      className={`table-scroll ui-data-table${mobileCards ? ' has-mobile-cards' : ''}`}
      role="region"
      aria-label="Data table"
      tabIndex={0}
    >
      <table className="ui-table">
        <thead>
          <tr>
            {selectable && (
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={
                    rows.length > 0 &&
                    rows.every((row) => selected.includes(row.id))
                  }
                  onChange={(event) =>
                    onSelectionChange?.(
                      event.target.checked ? rows.map((row) => row.id) : [],
                    )
                  }
                />
              </th>
            )}
            {columns.map((item) => (
              <th
                className={item.className}
                key={item.key}
                aria-sort={
                  item.sort
                    ? sort?.key === item.key
                      ? sort.direction === 1
                        ? 'ascending'
                        : 'descending'
                      : 'none'
                    : undefined
                }
              >
                {item.sort ? (
                  <button
                    type="button"
                    className="sort-button"
                    onClick={() => {
                      setSort({
                        key: item.key,
                        direction:
                          sort?.key === item.key
                            ? sort.direction === 1
                              ? -1
                              : 1
                            : 1,
                      });
                    }}
                  >
                    {item.label}
                    <span aria-hidden="true">↕</span>
                  </button>
                ) : (
                  item.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => (
            <Fragment key={row.id}>
              <tr>
                {selectable && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select row ${row.id}`}
                      checked={selected.includes(row.id)}
                      onChange={(event) =>
                        updateSelected(row.id, event.target.checked)
                      }
                    />
                  </td>
                )}
                {columns.map((item) => (
                  <td
                    key={item.key}
                    data-label={
                      typeof item.label === 'string' ? item.label : undefined
                    }
                    className={item.className}
                  >
                    {getValue(row, item)}
                  </td>
                ))}
              </tr>
              {mobileCards && (
                <tr className="ui-mobile-row">
                  <td colSpan={columns.length + Number(selectable)}>
                    <article>
                      {selectable && (
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`Select row ${row.id}`}
                            checked={selected.includes(row.id)}
                            onChange={(event) =>
                              updateSelected(row.id, event.target.checked)
                            }
                          />{' '}
                          Select
                        </label>
                      )}
                      {columns.map((item) => (
                        <div key={item.key}>
                          <strong>{item.label}</strong>
                          <span>{getValue(row, item)}</span>
                        </div>
                      ))}
                    </article>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {!ordered.length && <EmptyState>{empty}</EmptyState>}
    </div>
  );
}

export function Tabs({
  items,
  value,
  onChange,
  label = 'Sections',
  className,
}: {
  items: string[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={join('tabs', className)} role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          type="button"
          role="tab"
          aria-selected={value === item}
          tabIndex={value === item ? 0 : -1}
          className={value === item ? 'active' : ''}
          key={item}
          onClick={() => {
            onChange(item);
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
  className,
}: PropsWithChildren<{
  title?: string;
  action?: ReactNode;
  className?: string;
}>): React.JSX.Element {
  return (
    <div className={join('empty', 'ui-empty-state', className)}>
      <div>
        {title && <strong>{title}</strong>}
        {children && <p>{children}</p>}
        {action}
      </div>
    </div>
  );
}
export function ErrorState({
  title = 'Something went wrong',
  children,
  onRetry,
}: PropsWithChildren<{
  title?: string;
  onRetry?: () => void;
}>): React.JSX.Element {
  return (
    <div className="ui-message error-box" role="alert">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {onRetry && (
        <Button secondary onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
export function Banner({
  tone = 'info',
  title,
  children,
  className,
}: PropsWithChildren<{
  tone?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  className?: string;
}>): React.JSX.Element {
  return (
    <div
      className={join('ui-banner', `ui-banner-${tone}`, className)}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}
export function Skeleton({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={join('ui-skeleton', className)}
    />
  );
}
export function Toast({
  tone = 'info',
  children,
  onDismiss,
}: PropsWithChildren<{
  tone?: 'info' | 'success' | 'warning' | 'error';
  onDismiss?: () => void;
}>): React.JSX.Element {
  return (
    <div
      className={join('ui-toast', `ui-toast-${tone}`)}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      {children}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          ×
        </button>
      )}
    </div>
  );
}

export type PageHeaderProps = PropsWithChildren<{
  title: string;
  description?: ReactNode;
  kicker?: string;
  actions?: ReactNode;
  className?: string;
}>;
export function PageHeader({
  title,
  description,
  kicker,
  actions,
  children,
  className,
}: PageHeaderProps): React.JSX.Element {
  return (
    <header className={join('workspace-heading', className)}>
      <div>
        {kicker && <div className="workspace-kicker">{kicker}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {children}
      </div>
      {actions && <div className="ui-page-actions">{actions}</div>}
    </header>
  );
}

export type FieldGroupProps = PropsWithChildren<
  LabelHTMLAttributes<HTMLFieldSetElement> & { label: string }
>;
export function FieldGroup({
  label,
  children,
  ...props
}: FieldGroupProps): React.JSX.Element {
  return (
    <fieldset {...props} className={join('ui-field-group', props.className)}>
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}
