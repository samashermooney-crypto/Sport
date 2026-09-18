export const menus = [
  {
    name: "Manage",
    icon: "manage",
    groups: [
      {
        name: "Programs",
        items: [
          ["All Programs", "/programs"],
          ...[
            "Camps",
            "Classes",
            "Clubs",
            "Events",
            "Leagues",
            "Tournaments",
          ].map((n, i) => [
            n,
            "/programs?type=" +
              encodeURIComponent(
                ["Camp", "Class", "Club team", "Event", "League", "Tournament"][
                  i
                ],
              ),
          ]),
        ],
      },
      {
        name: "Other Offerings",
        items: [
          ["E-Commerce Products", "/products"],
        ],
      },
      {
        name: "Logistics",
        items: [
          ["Locations", "/locations"],
          ["Members", "/members"],
          ["Teams", "/teams"],
        ],
      },
      {
        name: "Schedule",
        items: [
          ["Global Schedule", "/schedule"],
          ["Site Level Calendar", "/calendar"],
        ],
      },
      {
        name: "Financial",
        items: [
          ["Invoices", "/invoices"],
          ["Discount Codes", "/discount-codes"],
          ["Credits", "/credits"],
        ],
      },
    ],
  },
  {
    name: "Messaging",
    icon: "messaging",
    groups: [
      {
        name: "Email",
        items: [
          ["Compose a Message", "/messaging/compose"],
          ["Email Contacts", "/messaging/contacts"],
          ["Email Settings", "/settings/email"],
          ["View All Sent Emails", "/messaging/sent"],
        ],
      },
      {
        name: "Text",
        items: [
          ["Text Message Settings", "/settings/sms"],
          ["View All Sent Texts", "/messaging/texts"],
        ],
      },
    ],
  },
  {
    name: "Calendar",
    icon: "calendar",
    groups: [
      {
        name: "Calendar",
        items: [
          ["Global Schedule", "/schedule"],
          ["Site Level Calendar", "/calendar"],
        ],
      },
    ],
  },
  {
    name: "Reporting",
    icon: "reporting",
    groups: [
      {
        name: "Programs",
        items: [
          ["Program Summary", "/program-summary"],
          ["Registrations", "/registrations"],
          ["Team Properties", "/reports/teams"],
          ["Attendance", "/reports/attendance"],
        ],
      },
      { name: "E-Commerce", items: [["Product Orders", "/orders"]] },
      {
        name: "Financial",
        items: [
          ["Invoices", "/invoices"],
          ["Payment Plans", "/payment-plans"],
        ],
      },
    ],
  },
  {
    name: "Website",
    icon: "website",
    groups: [
      {
        name: "Content",
        items: [
          ["Content Pages", "/website/pages"],
          ["Menu items", "/website/menu"],
          ["Mobile homepage", "/website/mobile"],
        ],
      },
      {
        name: "Design",
        items: [
          ["Site Appearance", "/website/editor"],
        ],
      },
    ],
  },
  {
    name: "Settings",
    icon: "settings",
    groups: [
      { name: "Organization", items: [["Organization Settings", "/settings/organization"], ["Administrator Access", "/settings/admin-users"]] },
      {
        name: "Programs",
        items: [
          ["Registration Settings", "/settings/registration"],
          ["Schedules & Standings", "/settings/standings"],
          ["Staff Roles", "/settings/staff"],
          ["Terminology", "/settings/terminology"],
        ],
      },
      {
        name: "Members",
        items: [["Member Profile Settings", "/settings/members"]],
      },
    ],
  },
];
