import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  ArrowUpDown,
  Download,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "./api";
export function useData<T>(path: string, initial: T) {
  const [data, setData] = useState<T>(initial),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setLoading(true);
    api<T>(path, { signal: controller.signal })
      .then((d) => {
        if (live) {
          setData(d);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [path, version]);
  return { data, error, loading, reload: () => setVersion((v) => v + 1) };
}
export function PageTitle({
  title,
  crumbs,
}: {
  title: string;
  crumbs?: { label: string; to: string }[];
}) {
  return (
    <div className="page-title">
      {crumbs && (
        <div className="breadcrumbs">
          {crumbs.map((c) => (
            <span key={c.to}>
              <Link to={c.to}>{c.label}</Link> /{" "}
            </span>
          ))}
          {title}
        </div>
      )}
      <h1>{title}</h1>
    </div>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div className="error-box" role="alert">
      {error}
    </div>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span />
      Loading…
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Button({
  children,
  secondary = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return (
    <button className={secondary ? "button secondary" : "button"} {...props}>
      {children}
    </button>
  );
}
export function Field({
  label,
  children,
  required,
  hint,
}: {
  label: string;
  children: ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {required && <b className="required"> *</b>}
      </span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return <div className="field" role="group" aria-labelledby={labelId}><span id={labelId}>{label}</span>{children}</div>;
}
export function Select({
  options,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: (string | { value: string; label: string })[];
}) {
  return (
    <div className="select-wrap">
      <select {...props}>
        {options.map((o) =>
          typeof o === "string" ? (
            <option key={o} value={o}>
              {o}
            </option>
          ) : (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ),
        )}
      </select>
      <ChevronDown size={13} />
    </div>
  );
}
export function Check({
  children,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { children: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...props} />
      <span>{children}</span>
    </label>
  );
}
export function DateInput({
  onChange,
  onInput,
  type = "date",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      type={type}
      onChange={onChange}
      onInput={(event) => {
        onInput?.(event);
        onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>);
      }}
    />
  );
}
export function Tabs({
  items,
  value,
  onChange,
}: {
  items: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={value === i}
          className={value === i ? "active" : ""}
          onClick={() => onChange(i)}
        >
          {i}
        </button>
      ))}
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = "Search by name",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="searchbox">
      <Search size={15} />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
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
  empty = "No records match your filters.",
  pagination = false,
  initialPageSize = 10,
  details,
  groupBy,
}: {
  rows: T[];
  columns: Column<T>[];
  empty?: string;
  pagination?: boolean;
  initialPageSize?: number;
  details?: (row: T) => ReactNode;
  groupBy?: (row: T) => { key: string; label: string };
}) {
  const [sort, setSort] = useState<{ key: string; dir: number } | null>(null),
    [page, setPage] = useState(0),
    [size, setSize] = useState(initialPageSize);
  const ordered = [...rows];
  const col = columns.find((c) => c.key === sort?.key);
  if (sort && col?.sort)
    ordered.sort((a, b) => {
      const av = col.sort!(a),
        bv = col.sort!(b);
      return (
        (typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv))) * sort.dir
      );
    });
  // Stable sorting preserves each group's selected column order.
  if (groupBy) ordered.sort((a,b) => groupBy(a).key.localeCompare(groupBy(b).key));
  const last = Math.max(0, Math.ceil(ordered.length / size) - 1),
    current = Math.min(page, last),
    visible = pagination
      ? ordered.slice(current * size, (current + 1) * size)
      : ordered;
  return (
    <>
      <div className="table-scroll" role="region" aria-label="Scrollable data table" tabIndex={0}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.className} aria-sort={c.sort ? (sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none") : undefined}>
                  {c.sort ? (
                    <button
                      className="sort-button"
                      onClick={() =>
                        setSort({
                          key: c.key,
                          dir: sort?.key === c.key ? -sort.dir : 1,
                        })
                      }
                    >
                      {c.label}
                      <ArrowUpDown size={11} />
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, index) => (
              <Fragment key={row.id}>
                {groupBy && (index === 0 || groupBy(visible[index-1]).key !== groupBy(row).key) && <tr className="table-group-row"><th colSpan={columns.length}>{groupBy(row).label}</th></tr>}
                <tr>
                  {columns.map((c) => (
                    <td key={c.key} className={c.className}>
                      {c.render
                        ? c.render(row)
                        : String(
                            (row as Record<string, unknown>)[c.key] ?? "—",
                          )}
                    </td>
                  ))}
                </tr>
                {details &&
                  (() => {
                    const content = details(row);
                    return content ? (
                      <tr className="table-detail-row">
                        <td colSpan={columns.length}>{content}</td>
                      </tr>
                    ) : null;
                  })()}
              </Fragment>
            ))}
          </tbody>
        </table>
        {!visible.length && <Empty>{empty}</Empty>}
      </div>
      {pagination && (
        <div className="pagination">
          <Button
            secondary
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
            aria-label="Previous page"
          >
            <ChevronLeft size={14} />
          </Button>
          <span>
            {current + 1} / {last + 1}
          </span>
          <Button
            secondary
            disabled={current === last}
            onClick={() => setPage(current + 1)}
            aria-label="Next page"
          >
            <ChevronRight size={14} />
          </Button>
          <span>Show</span>
          <Select
            aria-label="Items per page"
            options={["10", "25", "50", "100"]}
            value={size}
            onChange={(e) => {
              setSize(+e.target.value);
              setPage(0);
            }}
          />
          <span>items per page · {rows.length} total</span>
        </div>
      )}
    </>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  drawer = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  drawer?: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const d = ref.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    d.showModal();
    const listener = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    d.addEventListener("cancel", listener);
    return () => {
      d.removeEventListener("cancel", listener);
      d.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={(wide ? "modal wide" : "modal") + (drawer ? " drawer" : "")}
    >
      <div className="modal-title">
        <h2 id={titleId}>{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ExportButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button secondary disabled={disabled} onClick={onClick}>
      <Download size={13} /> Export to CSV
    </Button>
  );
}
