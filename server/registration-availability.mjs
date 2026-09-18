export function registrationAvailability(program, timezone, instant = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(instant);
  if (program.status === "Completed") return { open: false, reason: "This program has completed." };
  if (["Closed", "Coming Soon", "Sold Out"].includes(program.registration_status))
    return { open: false, reason: `Registration: ${program.registration_status}.` };
  if (program.registration_start && today < program.registration_start)
    return { open: false, reason: "Registration has not opened yet." };
  if (program.registration_end && today > program.registration_end)
    return { open: false, reason: "Registration has closed." };
  return { open: true, reason: "" };
}
