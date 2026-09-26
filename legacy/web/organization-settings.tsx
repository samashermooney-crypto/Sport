import { useState } from "react";
import { api } from "./api";
import { Button, ErrorBox, Field, Loading, PageTitle, useData } from "./components";
type Organization = {id:string;name:string;timezone:string;currency:string};
export function OrganizationSettings() {
  const {data,error,loading,reload}=useData<Organization|null>("/organization-settings",null);
  const [notice,setNotice]=useState("");
  return <><PageTitle title="Organization Settings"/><main className="content-page"><ErrorBox error={error}/>{notice && <p role="status">{notice}</p>}{loading ? <Loading/> : data && <Editor key={JSON.stringify(data)} initial={data} refresh={reload} saved={()=>{setNotice("Organization settings saved. Refresh other open pages to use the updated settings.");reload();}}/>}</main></>;
}
function Editor({initial,saved,refresh}:{initial:Organization;saved:()=>void;refresh:()=>void}) {
  const [name,setName]=useState(initial.name),[timezone,setTimezone]=useState(initial.timezone),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  return <form className="member-access-form organization-settings-form" onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError("");try{await api("/organization-settings",{method:"PUT",body:JSON.stringify({name,timezone,previous:{name:initial.name,timezone:initial.timezone}})});saved();}catch(err){setError((err as Error).message);}finally{setBusy(false);}}}>
    <ErrorBox error={error}/>{error && <Button type="button" secondary disabled={busy} onClick={refresh}>Reload current settings</Button>}<Field label="Organization name" required><input required maxLength={150} value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></Field>
    <Field label="Time zone" required><input required list="organization-timezones" value={timezone} onChange={e=>setTimezone(e.target.value)} disabled={busy}/><datalist id="organization-timezones">{["America/New_York","America/Chicago","America/Denver","America/Los_Angeles","America/Phoenix","Pacific/Honolulu","America/Anchorage","Europe/London","UTC"].map(zone=><option key={zone} value={zone}/>)}</datalist></Field>
    <p>Use an IANA time zone such as America/Chicago. Changing it affects local schedule display, imports and date boundaries. Existing event instants remain unchanged.</p>
    <p>Currency: {initial.currency}. This foundation records amounts in USD.</p>
    <Button disabled={busy}>{busy?"Saving…":"Save settings"}</Button>
  </form>;
}
