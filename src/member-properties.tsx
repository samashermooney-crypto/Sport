import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "./api";
import { Button, Check, ErrorBox, Loading, useData } from "./components";
export type CollectionSettings = {
  require_address: boolean;
  collect_adult_mobile: boolean;
  require_adult_mobile: boolean;
  collect_child_mobile: boolean;
  collect_secondary_email: boolean;
  require_secondary_email: boolean;
  today: string;
};
export const emptyCollectionSettings: CollectionSettings = {
  require_address: false,
  collect_adult_mobile: true,
  require_adult_mobile: false,
  collect_child_mobile: true,
  collect_secondary_email: false,
  require_secondary_email: false,
  today: "",
};
type Properties = {
  collect_adult_mobile: boolean;
  require_adult_mobile: boolean;
  collect_child_mobile: boolean;
  collect_secondary_email: boolean;
  require_secondary_email: boolean;
  version: number;
  require_address: boolean;
  require_profile_completion: boolean;
};
export function MemberPropertySettings() {
  const { data, loading, error, reload } = useData<Properties>(
    "/settings/member-properties",
    {
      ...emptyCollectionSettings,
      version: 1,
      require_profile_completion: false,
    },
  );
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  if (loading) return <Loading />;
  return (
    <section className="settings-section">
      <h2>Basic Field Settings</h2>
      <ErrorBox error={error || failure} />
      {notice && <p role="status">{notice}</p>}
      {(
        [
          ["require_address", "Require Member Address"],
          [
            "collect_secondary_email",
            "Collect Parent/Adult Secondary Email Address",
          ],
          [
            "require_secondary_email",
            "Require Parent/Adult Secondary Email Address",
          ],
          [
            "collect_adult_mobile",
            "Collect Parent/Adult Mobile Number During Registration",
          ],
          [
            "require_adult_mobile",
            "Require Parent/Adult Mobile Number When Collecting During Registration",
          ],
          [
            "collect_child_mobile",
            "Collect Child Mobile Number During Registration",
          ],
          [
            "require_profile_completion",
            "Require members to fill in empty required member profile fields within their family account when they log in",
          ],
        ] as const
      ).map(([key, label]) => (
        <Check
          key={key}
          disabled={busy || !!error}
          checked={data[key]}
          onChange={async (event) => {
            const value = event.target.checked;
            if (busy) return;
            setBusy(true);
            setFailure("");
            setNotice("");
            try {
              await api("/settings/member-properties", {
                method: "PUT",
                body: JSON.stringify({ ...data, [key]: value }),
              });
              reload();
              setNotice("Member profile settings saved.");
            } catch (e) {
              setFailure((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {label}
        </Check>
      ))}
      <p>
        Members must complete required family profiles before accessing the
        member portal, including registration. Profile editing and account
        settings remain available.
      </p>
    </section>
  );
}
type Completion = {
  required: boolean;
  profiles: { id: string; name: string; missing: string[] }[];
};
export function MemberCompletionGate({
  org,
  children,
}: {
  org: string;
  children: ReactNode;
}) {
  const [params] = useSearchParams();
  const program = params.get("program");
  const resumeQuery = program ? `&program=${encodeURIComponent(program)}` : "";
  const { data, loading, error, reload } = useData<Completion>(
    `/member/${org}/profile-completion`,
    { required: false, profiles: [] },
  );
  if (loading) return <Loading />;
  if (error)
    return (
      <>
        <ErrorBox error={error} />
        <Button onClick={reload}>Try again</Button>
      </>
    );
  if (!data.required) return <>{children}</>;
  return (
    <section>
      <h1>Complete your family profiles</h1>
      <p>
        Complete the required information below to continue to your member
        account.
      </p>
      <ul>
        {data.profiles.map((p) => (
          <li key={p.id}>
            <Link
              to={`/site/${org}/account/profile?person=${encodeURIComponent(p.id)}${resumeQuery}`}
            >
              {p.name || "Member profile"}
            </Link>
            <p>Required: {p.missing.join(", ")}</p>
          </li>
        ))}
      </ul>
      <Button onClick={reload}>Check again</Button>
    </section>
  );
}
