# Accessibility keyboard pass

Use this script with the seeded `e2e` organizations, once with a 1440 × 900
viewport and once with an iPhone 13 viewport. Sign in with the role named by
each journey. Keep the pointer away from the page: Tab and Shift+Tab move focus,
Enter or Space activates controls, arrow keys move within documented composite
widgets, and Escape closes a dismissible overlay. Record the route, role,
viewport, browser, result, and any blocking control in the acceptance record.
Repeat any journey whose role, route, or controls have changed.

For each page reached, run the page's Playwright axe check where one exists. A
manual pass does not replace axe, and an axe pass does not replace this keyboard
review. Focus must remain visible, follow a sensible reading order, and return
to the invoking control after a dialog, drawer, or sheet closes. Every action
must have an announced name and outcome. No journey should require pointer-only
input; drag-and-drop views must expose their keyboard move controls.

## Journeys

| #   | Flow and keyboard checks                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Organization sign-up, MFA, admin invite, and role change: complete every field, submit each step, enter MFA, and confirm the revoked session is announced.                |
| 2   | Guardian invitation and child medical edit: accept the invite, move through the form, save, and verify status feedback without exposing restricted values to other roles. |
| 3   | Import 2,000 people (desktop): reach file selection, preview, validation errors, rollback, and completion using keyboard controls.                                        |
| 4   | Volleyball season wizard and team generation: operate each wizard step, divisions, generator, and review actions.                                                         |
| 5   | Season rollover (desktop): navigate the preview table, inspect changes, and confirm or cancel the commit.                                                                 |
| 6   | Stripe mock onboarding and partial refund: traverse onboarding, invoice/payment details, approval dialog, and result announcement.                                        |
| 7   | Installment autopay failure and retry: reach the retry action, update a card, and verify success or failure feedback.                                                     |
| 8   | Family registration for two children: select participants, answer forms, accept waiver, choose ACH, review total, submit, and confirm the receipt in English and Spanish. |
| 9   | Returning-family registration: use saved profiles and verify the short path remains keyboard-operable.                                                                    |
| 10  | Waitlist offer: open the offer, review its expiry and terms, accept, and confirm the resulting status.                                                                    |
| 11  | External team entry: enter captain details, add players, and navigate invitation status.                                                                                  |
| 12  | Tryout scoring and placement: check in, enter offline scores, move a player using the board's keyboard alternative, and accept an offer with deposit.                     |
| 13  | Coach compliance: review missing credentials, submit one, and confirm activation after approval.                                                                          |
| 14  | Concussion report and return-to-play: enter the report and move through clearance controls and status announcements.                                                      |
| 15  | Schedule generation: configure, review, apply, publish, and verify the notification result.                                                                               |
| 16  | Rainout and reschedule: create a closure, inspect notifications, request a reschedule, and approve it.                                                                    |
| 17  | Coach game day: record attendance, edit lineup, reach the minimum-play warning, enter a score, and sync.                                                                  |
| 18  | Double-elimination tournament (desktop): navigate bracket rounds and keyboard alternatives, including external-team results.                                              |
| 19  | Swim meet results (desktop): enter event results and inspect team-scoring feedback.                                                                                       |
| 20  | Officials assignment and pay: accept or decline an assignment, reassign it, and review the pay batch.                                                                     |
| 21  | Bilingual campaign: move through audience, English and Spanish content, quiet hours, schedule, and unsubscribe controls.                                                  |
| 22  | Team chat: navigate messages and compose, and verify guardian inclusion for a minor without relying on color alone.                                                       |
| 23  | Volunteer shift: sign up, check in, and review the buyout option and resulting requirement status.                                                                        |
| 24  | Academy tuition: inspect monthly tuition and proration, request a makeup class, and review level promotion.                                                               |
| 25  | Federation league (desktop): enter clubs, assign shared fields, record results, and navigate standings.                                                                   |
| 26  | Reports and privacy deletion (desktop): save and schedule a report; separately keyboard-navigate privacy review and deletion confirmation.                                |
| 27  | New-organization onboarding: visit each checklist link, complete a setup task, and verify its completion state.                                                           |

## Record

```text
Date / reviewer:
Commit:
Browser and viewport:
Journey # and role:
Routes visited:
Keyboard pass: pass / fail
axe result or report link:
Blocking control and reproduction steps:
```
