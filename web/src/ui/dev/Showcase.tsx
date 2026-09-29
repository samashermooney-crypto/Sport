import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';

import {
  Avatar,
  Banner,
  Badge,
  Board,
  Bracket,
  Button,
  Calendar,
  Checkbox,
  ChatThread,
  Chart,
  Combobox,
  Card,
  DataList,
  DataTable,
  DateInput,
  DateRangeInput,
  EmptyState,
  ErrorState,
  Field,
  FieldGroup,
  FileUpload,
  GlobalSearch,
  IconButton,
  Input,
  Link,
  MoneyInput,
  PageHeader,
  Pagination,
  PhoneInput,
  PrintLayout,
  QRCode,
  Radio,
  RichTextEditor,
  Select,
  SignaturePad,
  Skeleton,
  StatTile,
  StatusPill,
  Stepper,
  Switch,
  Tag,
  Textarea,
  Toast,
  TimeInput,
  Timeline,
  Tabs,
} from '../index';
import { Dialog, Drawer, Sheet, ToastRegion } from '../overlays';
import { AppShell } from '../shell';

import { PublicSiteShowcase } from './PublicSiteShowcase';

type DemoRow = { id: string; program: string; season: string; status: string };
const rows: DemoRow[] = [
  { id: '1', program: 'Spring soccer', season: 'Spring 2026', status: 'Open' },
  { id: '2', program: 'Fall volleyball', season: 'Fall 2026', status: 'Draft' },
];
const people = [
  { id: 'athlete-1', label: 'Jordan Lee', detail: 'U12 · Returning' },
  { id: 'athlete-2', label: 'Morgan Diaz', detail: 'U12 · New' },
  { id: 'athlete-3', label: 'Riley Smith', detail: 'U12 · Returning' },
];
const columnDefinitions = [
  { id: 'available', title: 'Available' },
  { id: 'team-a', title: 'Falcons' },
  { id: 'team-b', title: 'Rockets' },
];
const calendarEvents = [
  {
    id: 'event-1',
    title: 'Falcons vs. Rockets',
    date: '2026-01-14',
    time: '09:00',
    endTime: '10:30',
    resource: 'Field 1',
  },
  {
    id: 'event-2',
    title: 'Skills clinic',
    date: '2026-01-14',
    time: '13:00',
    resource: 'Field 2',
  },
  {
    id: 'event-3',
    title: 'Rockets practice',
    date: '2026-01-16',
    time: '17:30',
    resource: 'Field 1',
  },
];

type ShowcaseIconName =
  | 'manage'
  | 'messaging'
  | 'calendar'
  | 'reporting'
  | 'website'
  | 'settings'
  | 'home'
  | 'money'
  | 'chevron';

function ShowcaseIcon({
  name,
  size = 18,
}: {
  name: ShowcaseIconName;
  size?: number;
}): React.JSX.Element {
  const paths: Record<ShowcaseIconName, ReactNode> = {
    manage: (
      <>
        <rect x="4" y="4" width="16" height="18" rx="2" />
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M8 11h8M8 15h8" />
      </>
    ),
    messaging: (
      <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z" />
    ),
    calendar: (
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>
    ),
    reporting: (
      <>
        <path d="M3 3v18h18" />
        <path d="m7 14 4-4 4 3 6-7" />
      </>
    ),
    website: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1 0 2z" />
      </>
    ),
    home: (
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1z" />
    ),
    money: (
      <>
        <rect x="2" y="5" width="20" height="15" rx="2" />
        <path d="M2 9h20M16 15h2" />
      </>
    ),
    chevron: <path d="m6 9 6 6 6-6" />,
  };

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'chevron' ? 2 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

export function Showcase(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState('Overview');
  const [dialog, setDialog] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [startDate, setStartDate] = useState('2026-01-14');
  const [endDate, setEndDate] = useState('2026-01-18');
  const [amount, setAmount] = useState<number | ''>(12500);
  const [person, setPerson] = useState('');
  const [step, setStep] = useState(1);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [calendarView, setCalendarView] = useState<
    'month' | 'week' | 'day' | 'agenda' | 'resource'
  >('month');
  const [tagVisible, setTagVisible] = useState(true);
  const [signature, setSignature] = useState('');
  const [editorValue, setEditorValue] = useState(
    '<p>Welcome to the <strong>team update</strong>.</p>',
  );
  const [assignments, setAssignments] = useState<Record<string, string>>({
    'athlete-1': 'available',
    'athlete-2': 'team-a',
    'athlete-3': 'team-b',
  });
  const [messages, setMessages] = useState([
    {
      id: 'message-1',
      author: 'Coach Morgan',
      body: 'Practice moves to Field 2 this Saturday.',
      sentAt: 'Jan 12, 2026 · 3:15 PM',
    },
  ]);
  const [search, setSearch] = useState('');
  const [searchSubmitted, setSearchSubmitted] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [scheduleAlerts, setScheduleAlerts] = useState(true);
  const [contactMethod, setContactMethod] = useState('email');
  const [retryCount, setRetryCount] = useState(0);
  const [extraSample, setExtraSample] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  const boardColumns = columnDefinitions.map((column) => ({
    ...column,
    items: people
      .filter((athlete) => assignments[athlete.id] === column.id)
      .map((athlete) => ({
        id: athlete.id,
        label: athlete.label,
        detail: <small>{athlete.detail}</small>,
      })),
  }));
  const searchResults = searchSubmitted
    ? [
        { label: 'Jordan Lee · Athlete', to: '/__ui' },
        { label: 'Spring soccer · Program', to: '/__ui' },
      ].filter((item) =>
        item.label.toLowerCase().includes(searchSubmitted.toLowerCase()),
      )
    : [];

  if (searchParams.get('surface') === 'public') {
    return <PublicSiteShowcase />;
  }

  return (
    <AppShell
      orgName="Northstar Youth Sports"
      orgSwitcher={
        <>
          <RouterLink to="/__ui" className="org-name">
            Northstar Youth Sports <ShowcaseIcon name="chevron" size={13} />
          </RouterLink>
          <RouterLink to="/__ui" className="site-link">
            Site
          </RouterLink>
        </>
      }
      actions={
        <span className="ui-account-label">
          Hi, Alex! <ShowcaseIcon name="chevron" size={13} />
        </span>
      }
      navigation={[
        {
          label: 'Manage',
          icon: <ShowcaseIcon name="manage" />,
          items: [
            { label: 'Design system', to: '/__ui', current: true },
            { label: 'Programs', to: '/__ui' },
          ],
        },
        {
          label: 'Messaging',
          icon: <ShowcaseIcon name="messaging" />,
          items: [{ label: 'Messages', to: '/__ui' }],
        },
        {
          label: 'Calendar',
          icon: <ShowcaseIcon name="calendar" />,
          items: [{ label: 'Schedule', to: '/__ui' }],
        },
        {
          label: 'Reporting',
          icon: <ShowcaseIcon name="reporting" />,
          items: [{ label: 'Reports', to: '/__ui' }],
        },
        {
          label: 'Website',
          icon: <ShowcaseIcon name="website" />,
          items: [{ label: 'Content pages', to: '/__ui' }],
        },
        {
          label: 'Settings',
          icon: <ShowcaseIcon name="settings" />,
          items: [{ label: 'Organization settings', to: '/__ui' }],
        },
      ]}
      mobileTabs={[
        {
          label: 'Home',
          to: '/__ui',
          current: true,
          icon: <ShowcaseIcon name="home" size={16} />,
        },
        {
          label: 'Programs',
          to: '/__ui',
          icon: <ShowcaseIcon name="manage" size={16} />,
        },
        {
          label: 'Schedule',
          to: '/__ui',
          icon: <ShowcaseIcon name="calendar" size={16} />,
        },
        {
          label: 'Money',
          to: '/__ui',
          icon: <ShowcaseIcon name="money" size={16} />,
        },
        {
          label: 'More',
          to: '/__ui',
          icon: <ShowcaseIcon name="settings" size={16} />,
        },
      ]}
    >
      <main className="ui-showcase">
        <PageHeader
          kicker="ATHLENTRY UI"
          title="Design system"
          description="Shared components built from the legacy design tokens."
          actions={
            <>
              <Button
                onClick={() => {
                  setDialog(true);
                }}
              >
                Open dialog
              </Button>
              <Button
                secondary
                onClick={() => {
                  setDrawer(true);
                }}
              >
                Open drawer
              </Button>
              <Button
                secondary
                onClick={() => {
                  setSheet(true);
                }}
              >
                Open sheet
              </Button>
            </>
          }
        />
        <section className="ui-showcase-section" aria-label="Core components">
          <Card>
            <Tabs
              items={['Overview', 'Components', 'States']}
              value={tab}
              onChange={setTab}
            />
            <div className="ui-showcase-content">
              <Field label="Search" hint="Filter by name or season">
                <Input placeholder="Search programs" />
              </Field>
              <Field label="Status">
                <Select options={['All statuses', 'Open', 'Draft']} />
              </Field>
              <div className="ui-showcase-badges">
                <Badge tone="confirmed">Confirmed</Badge>
                <Badge tone="pending">Pending</Badge>
                <Badge tone="wait-list">Wait list</Badge>
              </div>
              <p>
                Selected tab: {tab}; selected rows: {selected.length}
              </p>
            </div>
          </Card>
          <div className="ui-showcase-metrics">
            <StatTile
              label="Registrations"
              value="324"
              detail="18% from last week"
              trend="up"
            />
            <Chart
              title="Registration pace"
              values={[
                { label: 'Mon', value: 34 },
                { label: 'Tue', value: 51 },
                { label: 'Wed', value: 42 },
                { label: 'Thu', value: 68 },
                { label: 'Fri', value: 75 },
              ]}
            />
          </div>
          <h2>Program list</h2>
          <DataTable
            rows={rows}
            columns={[
              { key: 'program', label: 'Program', sort: (row) => row.program },
              { key: 'season', label: 'Season' },
              { key: 'status', label: 'Status' },
            ]}
            selectable
            selected={selected}
            onSelectionChange={setSelected}
          />
        </section>

        <section
          className="ui-showcase-section"
          aria-label="States and feedback"
        >
          <h2>States, choices and feedback</h2>
          <div className="ui-showcase-grid ui-showcase-state-grid">
            <Card>
              <h3>Choices and links</h3>
              <FieldGroup label="Notification preferences">
                <label className="ui-showcase-choice">
                  <Checkbox
                    checked={emailUpdates}
                    onChange={(event) => {
                      setEmailUpdates(event.target.checked);
                    }}
                  />
                  Email updates
                </label>
                <label className="ui-showcase-choice">
                  <Radio
                    name="showcase-contact-method"
                    value="email"
                    checked={contactMethod === 'email'}
                    onChange={(event) => {
                      setContactMethod(event.target.value);
                    }}
                  />
                  Email contact
                </label>
                <label className="ui-showcase-choice">
                  <Radio
                    name="showcase-contact-method"
                    value="phone"
                    checked={contactMethod === 'phone'}
                    onChange={(event) => {
                      setContactMethod(event.target.value);
                    }}
                  />
                  Phone contact
                </label>
                <Switch
                  label="Allow schedule alerts"
                  checked={scheduleAlerts}
                  onChange={(event) => {
                    setScheduleAlerts(event.target.checked);
                  }}
                />
              </FieldGroup>
              <div className="ui-showcase-inline">
                <Badge tone="confirmed">Confirmed</Badge>
                <StatusPill tone="pending">Needs review</StatusPill>
                <IconButton
                  label="Reset notification preferences"
                  onClick={() => {
                    setEmailUpdates(true);
                    setScheduleAlerts(true);
                    setContactMethod('email');
                  }}
                >
                  ↺
                </IconButton>
                <Link to="/__ui">View this design system</Link>
              </div>
            </Card>
            <Card>
              <h3>Message and loading states</h3>
              <Banner tone="info" title="Preview environment">
                This sample shows the organization’s current state.
              </Banner>
              <ErrorState
                title="Sample request failed"
                onRetry={() => {
                  setRetryCount((count) => count + 1);
                }}
              >
                {retryCount
                  ? `Retry attempted ${retryCount.toString()} times.`
                  : 'The sample is ready to retry.'}
              </ErrorState>
              <EmptyState
                title={extraSample ? 'Sample added' : 'No extra samples'}
                action={
                  !extraSample && (
                    <Button
                      type="button"
                      secondary
                      onClick={() => {
                        setExtraSample(true);
                      }}
                    >
                      Add sample
                    </Button>
                  )
                }
              >
                {extraSample
                  ? 'The added sample is available in this showcase.'
                  : 'Add one to preview the populated state.'}
              </EmptyState>
              <div className="ui-showcase-skeleton-sample">
                <span>Loading state</span>
                <Skeleton aria-label="Loading sample" />
              </div>
              <Button
                type="button"
                onClick={() => {
                  setToastVisible(true);
                }}
              >
                Show notification
              </Button>
            </Card>
          </div>
          <ToastRegion>
            {toastVisible && (
              <Toast
                tone="success"
                onDismiss={() => {
                  setToastVisible(false);
                }}
              >
                Sample notification shown.
              </Toast>
            )}
          </ToastRegion>
        </section>

        <section className="ui-showcase-section" aria-label="Form controls">
          <h2>Dates, contact and money</h2>
          <div className="ui-showcase-grid">
            <Field label="Date">
              <DateInput aria-label="Date" defaultValue="2026-01-14" />
            </Field>
            <Field label="Start time">
              <TimeInput aria-label="Start time" defaultValue="09:00" />
            </Field>
            <Field label="Phone">
              <PhoneInput aria-label="Phone" placeholder="(555) 555-0100" />
            </Field>
            <Field label="Registration fee">
              <MoneyInput
                aria-label="Registration fee"
                value={amount}
                onChange={setAmount}
              />
            </Field>
            <Field label="Participant" hint="Search by athlete name">
              <Combobox
                label="Participant"
                options={[
                  { value: 'jordan', label: 'Jordan Lee' },
                  { value: 'morgan', label: 'Morgan Diaz' },
                  { value: 'riley', label: 'Riley Smith' },
                ]}
                value={person}
                onChange={setPerson}
                placeholder="Choose a participant"
              />
            </Field>
            <div className="ui-showcase-control">
              <strong>Team document</strong>
              <FileUpload
                label="Choose a document"
                accept=".pdf,.png,.jpg"
                onFiles={(files) => {
                  setSelectedFile(
                    Array.from(files ?? [])
                      .map((file) => file.name)
                      .join(', '),
                  );
                }}
              />
              {selectedFile && <small>{selectedFile}</small>}
            </div>
            <div className="ui-showcase-control">
              <strong>Event date range</strong>
              <DateRangeInput
                start={startDate}
                end={endDate}
                onStartChange={setStartDate}
                onEndChange={setEndDate}
              />
            </div>
            <Field label="Notes">
              <Textarea aria-label="Notes" rows={2} placeholder="Add a note" />
            </Field>
          </div>
          <div className="ui-showcase-inline">
            <Avatar name="Dana Morales" size="large" />
            <Avatar name="Marcus Chen" size="medium" />
            {tagVisible && (
              <Tag
                onRemove={() => {
                  setTagVisible(false);
                }}
                removeLabel="U12"
              >
                U12
              </Tag>
            )}
            <DataList
              items={[
                { label: 'Season', value: 'Spring 2026' },
                { label: 'Division', value: 'U12 Coed' },
              ]}
            />
          </div>
          <Stepper
            steps={['Basics', 'Teams', 'Review']}
            current={step}
            onStepChange={setStep}
          />
          <Pagination
            page={page}
            pageCount={8}
            pageSize={pageSize}
            total={184}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </section>

        <section className="ui-showcase-section" aria-label="Scheduling">
          <h2>Calendar and timeline</h2>
          <Calendar
            events={calendarEvents}
            initialDate="2026-01-14"
            view={calendarView}
            onViewChange={setCalendarView}
            resources={['Field 1', 'Field 2']}
          />
          <Timeline
            items={[
              {
                date: 'Jan 12, 2026 · 9:30 AM',
                title: 'Registration received',
                detail: 'Jordan Lee · Spring soccer',
                tone: 'confirmed',
              },
              {
                date: 'Jan 12, 2026 · 9:32 AM',
                title: 'Waiver signed',
                detail: 'Season waiver · v3',
              },
              {
                date: 'Jan 12, 2026 · 9:34 AM',
                title: 'Payment complete',
                detail: '$125.00 · Visa ending 4242',
              },
            ]}
          />
        </section>

        <section
          className="ui-showcase-section"
          aria-label="Team and tournament views"
        >
          <h2>Team formation and bracket</h2>
          <Board
            columns={boardColumns}
            onMove={(itemId, columnId) => {
              setAssignments((current) => ({ ...current, [itemId]: columnId }));
            }}
          />
          <Bracket
            rounds={[
              {
                title: 'Semifinals',
                matches: [
                  {
                    id: 'semi-1',
                    home: 'Falcons',
                    away: 'Tigers',
                    result: '2 – 1',
                  },
                  { id: 'semi-2', home: 'Rockets', away: 'Lions' },
                ],
              },
              {
                title: 'Final',
                matches: [{ id: 'final', home: 'Falcons', away: 'Rockets' }],
              },
            ]}
          />
        </section>

        <section
          className="ui-showcase-section"
          aria-label="Communication and records"
        >
          <h2>Messages and rich text</h2>
          <ChatThread
            messages={messages}
            onSend={(body) => {
              setMessages((current) => [
                ...current,
                {
                  id: `message-${(current.length + 1).toString()}`,
                  author: 'Dana Morales',
                  body,
                  sentAt: 'Jan 12, 2026 · 3:20 PM',
                },
              ]);
            }}
          />
          <RichTextEditor
            value={editorValue}
            onChange={setEditorValue}
            label="Team update"
          />
        </section>

        <section
          className="ui-showcase-section"
          aria-label="Documents and search"
        >
          <h2>Signature, QR code and print layout</h2>
          <SignaturePad value={signature} onChange={setSignature} />
          <QRCode
            value="https://athlentry.example/join/demo"
            label="Team sign-up code"
          />
          <PrintLayout>
            <h3>Falcons · Spring 2026</h3>
            <p>Practice schedule and family contact sheet.</p>
          </PrintLayout>
          <div className="ui-showcase-control">
            <strong>Global search</strong>
            <small>Search people, programs and invoices.</small>
            <GlobalSearch
              value={search}
              onChange={setSearch}
              onSubmit={setSearchSubmitted}
              results={searchResults}
            />
          </div>
        </section>

        <Dialog
          title="Example dialog"
          open={dialog}
          onClose={() => {
            setDialog(false);
          }}
        >
          <p>This is the shared modal treatment.</p>
          <Button
            onClick={() => {
              setDialog(false);
            }}
          >
            Done
          </Button>
        </Dialog>
        <Drawer
          title="Example drawer"
          open={drawer}
          onClose={() => {
            setDrawer(false);
          }}
        >
          <p>Persistent side-panel content.</p>
        </Drawer>
        <Sheet
          title="Example sheet"
          open={sheet}
          onClose={() => {
            setSheet(false);
          }}
        >
          <p>Mobile bottom-sheet content.</p>
        </Sheet>
      </main>
    </AppShell>
  );
}
