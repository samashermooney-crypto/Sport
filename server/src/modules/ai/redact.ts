const EMAIL_PATTERN = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE_PATTERN =
  /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

export function redactSensitive(text: string): {
  text: string;
  redactions: number;
} {
  let redactions = 0;
  const text0 = text.replaceAll(EMAIL_PATTERN, () => {
    redactions += 1;
    return '[email redacted]';
  });
  const result = text0.replaceAll(PHONE_PATTERN, () => {
    redactions += 1;
    return '[phone redacted]';
  });
  return { text: result, redactions };
}
