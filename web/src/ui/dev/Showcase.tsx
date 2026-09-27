import { useState } from 'react';

import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
  Tabs,
} from '../index';
import { Dialog } from '../overlays';

type DemoRow = { id: string; program: string; season: string; status: string };
const rows: DemoRow[] = [
  { id: '1', program: 'Spring soccer', season: 'Spring 2026', status: 'Open' },
  { id: '2', program: 'Fall volleyball', season: 'Fall 2026', status: 'Draft' },
];

export function Showcase(): React.JSX.Element {
  const [tab, setTab] = useState('Overview');
  const [dialog, setDialog] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <main className="ui-showcase">
      <PageHeader
        kicker="ATHLENTRY UI"
        title="Design system"
        description="Shared components built from the legacy design tokens."
        actions={
          <Button
            onClick={() => {
              setDialog(true);
            }}
          >
            Open dialog
          </Button>
        }
      />
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
      <ShowcaseDialog
        open={dialog}
        onClose={() => {
          setDialog(false);
        }}
      />
    </main>
  );
}

export function ShowcaseDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  return open ? (
    <Dialog title="Example dialog" onClose={onClose}>
      <p>This is the shared modal treatment.</p>
      <Button onClick={onClose}>Done</Button>
    </Dialog>
  ) : null;
}
