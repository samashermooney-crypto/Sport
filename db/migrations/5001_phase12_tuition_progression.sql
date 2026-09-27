ALTER TABLE class_offerings
  ADD COLUMN proration_setting text NOT NULL DEFAULT 'session_count'
    CHECK (proration_setting IN ('session_count','full_month','no_charge_after_20th'));

ALTER TABLE class_level_recommendations
  ADD COLUMN next_offering_id uuid,
  ADD CONSTRAINT class_level_recommendations_next_offering_fk
    FOREIGN KEY (org_id,next_offering_id) REFERENCES class_offerings(org_id,id);

CREATE TABLE class_session_credits (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_enrollment_id uuid NOT NULL,
  purchased_invoice_id uuid,
  purchased_count integer NOT NULL CHECK (purchased_count > 0),
  remaining_count integer NOT NULL CHECK (remaining_count >= 0 AND remaining_count <= purchased_count),
  expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','expired','refunded')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,class_enrollment_id) REFERENCES class_enrollments(org_id,id),
  FOREIGN KEY (org_id,purchased_invoice_id) REFERENCES invoices(org_id,id)
);
CREATE INDEX class_session_credits_active_idx ON class_session_credits(org_id,class_enrollment_id,expires_on) WHERE status='active';
SELECT configure_spine_tenant_table('class_session_credits');

CREATE TABLE class_credit_redemptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_session_credit_id uuid NOT NULL,
  class_session_id uuid NOT NULL,
  class_attendance_id uuid,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','redeemed','released')),
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,class_session_credit_id,class_session_id),
  FOREIGN KEY (org_id,class_session_credit_id) REFERENCES class_session_credits(org_id,id),
  FOREIGN KEY (org_id,class_session_id) REFERENCES class_sessions(org_id,id),
  FOREIGN KEY (org_id,class_attendance_id) REFERENCES class_attendance(org_id,id)
);
CREATE INDEX class_credit_redemptions_session_idx ON class_credit_redemptions(org_id,class_session_id,status);
SELECT configure_spine_tenant_table('class_credit_redemptions');
