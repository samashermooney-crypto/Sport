import { useEffect, useRef } from "react";
import DOMPurify from "dompurify";
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link as LinkIcon,
  Undo2,
  Redo2,
} from "lucide-react";
const allowed = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "blockquote",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
];
export const sanitized = (html: string) =>
  DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowed,
    ALLOWED_ATTR: ["href", "title"],
    ALLOW_DATA_ATTR: false,
  });
export function HtmlContent({ html }: { html: string }) {
  return (
    <div
      className="rich-content"
      dangerouslySetInnerHTML={{ __html: sanitized(html) }}
    />
  );
}
export function RichText({
  value,
  onChange,
  label = "Message",
  maxLength = 65500,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  maxLength?: number;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && node.innerHTML !== value && document.activeElement !== node)
      node.innerHTML = sanitized(value);
  }, [value]);
  const update = () => {
    const html = sanitized(ref.current?.innerHTML || "");
    onChange(html);
  };
  const command = (name: string, value?: string) => {
    if (disabled) return;
    ref.current?.focus();
    document.execCommand(name, false, value);
    update();
  };
  return (
    <div className="rich-editor">
      <div className="rich-editor-label">{label}</div>
      <div className="rich-toolbar" role="toolbar" aria-label="Text formatting">
        {[
          [Bold, "Bold", "bold"],
          [Italic, "Italic", "italic"],
          [Underline, "Underline", "underline"],
          [List, "Bulleted list", "insertUnorderedList"],
          [ListOrdered, "Numbered list", "insertOrderedList"],
          [Undo2, "Undo", "undo"],
          [Redo2, "Redo", "redo"],
        ].map(([Icon, text, cmd]) => {
          const Component = Icon as typeof Bold;
          return (
            <button
              key={String(cmd)}
              type="button"
              disabled={disabled}
              aria-label={String(text)}
              title={String(text)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => command(String(cmd))}
            >
              <Component size={15} />
            </button>
          );
        })}
        <button
          type="button"
          disabled={disabled}
          aria-label="Insert link"
          title="Insert link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = window.prompt("Link URL (https://…)");
            if (url && /^https?:\/\//i.test(url)) command("createLink", url);
          }}
        >
          <LinkIcon size={15} />
        </button>
        <select
          disabled={disabled}
          aria-label="Text style"
          defaultValue="p"
          onChange={(e) => command("formatBlock", e.target.value)}
        >
          <option value="p">Paragraph</option>
          <option value="h2">Heading</option>
          <option value="h3">Subheading</option>
          <option value="blockquote">Quote</option>
        </select>
      </div>
      <div
        ref={ref}
        className="rich-editable"
        contentEditable={!disabled}
        aria-readonly={disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-label={label}
        aria-multiline="true"
        onInput={update}
        onPaste={(e) => {
          e.preventDefault();
          const html = e.clipboardData.getData("text/html");
          if (html) command("insertHTML", sanitized(html));
          else command("insertText", e.clipboardData.getData("text/plain"));
        }}
      />
      <small className={value.length > maxLength ? "required" : ""}>
        {value.length.toLocaleString()} / {maxLength.toLocaleString()}{" "}
        characters
      </small>
    </div>
  );
}
