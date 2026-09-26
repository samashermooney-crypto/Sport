import sanitizeHtml from "sanitize-html";
export const cleanHtml = (value) =>
  sanitizeHtml(value, {
    allowedTags: [
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
    ],
    allowedAttributes: { a: ["href", "title"], "*": ["style"] },
    allowedStyles: {
      "*": {
        "text-align": [/^(left|right|center)$/],
        color: [/^#[0-9a-f]{3,6}$/i],
      },
    },
    allowedSchemes: ["https", "http", "mailto"],
    allowProtocolRelative: false,
  });
