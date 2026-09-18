import { UserRound } from "lucide-react";
import { shortDate } from "./api";
import { Button, ErrorBox, Loading, useData } from "./components";
import type { Person } from "./types";

export function MemberCard({
  person,
  organizationName,
}: {
  person: Person;
  organizationName: string;
}) {
  return (
    <article className="member-idcard">
      <header>
        <strong>ATHLENTRY</strong>
        <span>{organizationName}</span>
      </header>
      <div className="member-card-details">
        <UserRound size={70} />
        <div>
          <h2>
            {person.first_name} {person.last_name}
          </h2>
          <p>
            {person.birthdate
              ? "Birthdate: " + shortDate(person.birthdate)
              : "Site Member"}
          </p>
          <p>Member since {shortDate(person.created_at)}</p>
        </div>
      </div>
      <small>Member ID: {person.id}</small>
    </article>
  );
}
export function MemberCardPreview({
  person,
  onClose,
}: {
  person: Person;
  onClose: () => void;
}) {
  const session = useData<{ organization: { name: string } } | null>(
    "/session",
    null,
  );
  if (session.loading) return <Loading />;
  if (!session.data || session.error)
    return <ErrorBox error={session.error || "Organization unavailable"} />;
  return (
    <>
      <MemberCard
        person={person}
        organizationName={session.data.organization.name}
      />
      <div className="form-actions">
        <Button secondary onClick={onClose}>
          Close
        </Button>
        <Button onClick={() => window.print()}>Print Card</Button>
      </div>
    </>
  );
}
