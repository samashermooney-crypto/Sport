import { useState } from 'react';

import {
  Avatar,
  Badge,
  Board,
  Bracket,
  Button,
  Calendar,
  ChatThread,
  Chart,
  Combobox,
  Card,
  DataList,
  DataTable,
  DateInput,
  DateRangeInput,
  Field,
  FileUpload,
  GlobalSearch,
  Input,
  MoneyInput,
  PageHeader,
  Pagination,
  PhoneInput,
  PrintLayout,
  QRCode,
  RichTextEditor,
  Select,
  SignaturePad,
  StatTile,
  Stepper,
  Tag,
  Textarea,
  TimeInput,
  Timeline,
  Tabs,
} from '../index';
import { Dialog, Drawer, Sheet } from '../overlays';
import { AppShell } from '../shell';

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

export function Showcase(): React.JSX.Element {
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

  return (
    <AppShell
      orgName="Athlentry Demo Club"
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Design system', to: '/__ui', current: true },
            { label: 'Programs', to: '/__ui' },
          ],
        },
        { label: 'Schedule', items: [{ label: 'Calendar', to: '/__ui' }] },
        { label: 'Money', items: [{ label: 'Invoices', to: '/__ui' }] },
      ]}
      mobileTabs={[
        { label: 'Home', to: '/__ui', current: true },
        { label: 'Programs', to: '/__ui' },
        { label: 'Schedule', to: '/__ui' },
        { label: 'Money', to: '/__ui' },
        { label: 'More', to: '/__ui' },
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
