import { Temporal } from '@js-temporal/polyfill';

export function toOrgDate(instant: string, timeZone: string): string {
  return Temporal.Instant.from(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

export function orgToday(
  timeZone: string,
  now: Temporal.Instant = Temporal.Now.instant(),
): string {
  return now.toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function startOfOrgDay(date: string, timeZone: string): string {
  return Temporal.PlainDate.from(date)
    .toZonedDateTime({ timeZone, plainTime: '00:00' })
    .toInstant()
    .toString();
}

export function orgLocalToInstant(
  localDateTime: string,
  timeZone: string,
): string {
  return Temporal.PlainDateTime.from(localDateTime)
    .toZonedDateTime(timeZone, { disambiguation: 'reject' })
    .toInstant()
    .toString();
}

export function ageOnDate(dateOfBirth: string, onDate: string): number {
  const birth = Temporal.PlainDate.from(dateOfBirth);
  const on = Temporal.PlainDate.from(onDate);
  if (Temporal.PlainDate.compare(on, birth) < 0) {
    throw new RangeError('onDate must not precede dateOfBirth');
  }
  const leapBirthday = birth.month === 2 && birth.day === 29 && !on.inLeapYear;
  const birthday = leapBirthday
    ? Temporal.PlainDate.from({ year: on.year, month: 3, day: 1 })
    : Temporal.PlainDate.from({
        year: on.year,
        month: birth.month,
        day: birth.day,
      });
  return (
    on.year -
    birth.year -
    (Temporal.PlainDate.compare(on, birthday) < 0 ? 1 : 0)
  );
}
