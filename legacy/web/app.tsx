import { Landing } from "./landing";
import { AccountAuth } from "./account-auth";
import { ConsoleAccess } from "./account-access";
import { OrganizationSettings } from "./organization-settings";
import { ProgramStaff } from "./program-staff";
import { ScheduleImport } from "./schedule-import";
import { PaymentPlanReport } from "./payment-plan-report";
import { PaymentPlans } from "./payment-plans";
import { ActivityAttendance, AttendanceReport } from "./attendance";
import { TeamPropertyReport } from "./team-report";
import { StaffRoles } from "./staff-roles";
import { useCallback, useEffect, useState } from "react";
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  CalendarDays,
  ChartNoAxesCombined,
  ClipboardList,
  Plug,
  Settings,
  Monitor,
  MessageSquare,
  Search,
  ChevronDown,
  LogOut,
  UserRound,
} from "lucide-react";
import { api, ApiError } from "./api";
import { Standings, StandingsSettings } from "./standings";
import {
  Button,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageTitle,
} from "./components";
import { menus } from "./navigation";
import {
  Dashboard,
  ProgramEditor,
  ProgramHome,
  Programs,
  ProgramSummary,
} from "./programs";
import { Registrations, Invoices, InvoiceDetail } from "./operations";
import { Teams, TeamProfile, TeamBuilder, RosterSettings } from "./teams";
import {
  Members,
  MemberEditor,
  MemberProfile,
  HouseholdEditor,
  HouseholdProfile,
} from "./members";
import {
  Locations,
  LocationEditor,
  Discounts,
  DiscountEditor,
  Credits,
} from "./directory";
import { Schedule } from "./schedule";
import {
  WebsitePages,
  WebsitePageEditor,
  WebsiteMenu,
  WebsiteTheme,
  PublicWebsite,
} from "./website";
import { RegistrationOptions } from "./program-options";
import { FormSettings } from "./forms";
import { TerminologySettings } from "./terminology";
import {
  Products,
  ProductEditor,
  StoreManager,
  StorePreview,
  ProductPurchase,
  Orders,
  OrderDetail,
} from "./commerce";
import {
  Composer,
  MessageHistory,
  MessageDetail,
  EmailContacts,
  EmailTemplates,
  MessagingSettings,
} from "./messaging";
import "./styles.css";
import "./admin-platform.css";
type Session = {
  user: { id: string; name: string; email: string; role: string };
  organization: { id: string; name: string };
};
export default function App() {
  const location = useLocation();
  if (location.pathname === "/welcome") return <Landing />;
  if (["/forgot-password", "/reset-password", "/accept-invitation"].includes(location.pathname)) return <AccountAuth key={location.pathname + location.search} mode={location.pathname.slice(1) as "forgot-password" | "reset-password" | "accept-invitation"} />;
  return location.pathname.startsWith("/site/") ? (
    <PublicWebsite />
  ) : (
    <AdminApp />
  );
}
function AdminApp() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState("");
  const [sessionRevision, setSessionRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setSessionError("");
    api<Session>("/session")
      .then(value => { if (active) setSession(value); })
      .catch(error => { if (active && !(error instanceof ApiError && error.status === 401)) setSessionError(error.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionRevision]);
  if (loading) return <Loading />;
  if (sessionError) return <main className="content-page"><h1>Could not load your session</h1><ErrorBox error={sessionError}/><Button onClick={() => setSessionRevision(v => v + 1)}>Retry</Button></main>;
  if (!session)
    return <Login onLogin={() => api<Session>("/session").then(setSession)} />;
  return (
    <Shell
      session={session}
      logout={async () => {
        await api("/auth/logout", { method: "POST" });
        setSession(null);
      }}
    />
  );
}
function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-page">
      <div className="login-brand">
        <span className="brand-mark">A</span>
        <strong>ATHLENTRY</strong>
      </div>
      <form
        className="login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/auth/login", {
              method: "POST",
              body: JSON.stringify({ email, password }),
            });
            await onLogin();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>Welcome back.</h1>
        <p>Sign in to manage your organization.</p>
        <ErrorBox error={error} />
        <Field label="Email address">
          <input
            autoComplete="username"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            autoComplete="current-password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
        <p><Link to="/forgot-password">Forgot your password?</Link></p>
        {import.meta.env.DEV && <details>
          <summary>Local demonstration account</summary>
          <p>
            admin@athlentry.local
            <br />
            AthlentryDemo!2026
          </p>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setEmail("admin@athlentry.local");
              setPassword("AthlentryDemo!2026");
            }}
          >
            Fill demo credentials
          </button>
        </details>}
      </form>
      <p className="login-caption"><Link to="/welcome">Discover Athlentry ↗</Link></p>
    </div>
  );
}
function Shell({ session, logout }: { session: Session; logout: () => Promise<void> }) {
  const [open, setOpen] = useState(""),
    [account, setAccount] = useState(false),
    [searching, setSearching] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const closeSearch = useCallback(() => setSearching(false), []);
  const location = useLocation();
  useEffect(() => {
    setOpen("");
    setAccount(false);
    window.scrollTo(0, 0);
  }, [location.pathname, location.search]);
  const icons = [
    ClipboardList,
    MessageSquare,
    CalendarDays,
    ChartNoAxesCombined,
    Monitor,
    Plug,
    Settings,
  ];
  return (
    <div className="admin-platform">
      <header className="topbar">
        <Link to="/" className="brand-mark" aria-label="Athlentry dashboard">
          A
        </Link>
        <Link className="org-name" to="/">
          {session.organization.name}
          <ChevronDown size={13} />
        </Link>
        <Link className="site-link" to={`/site/${session.organization.id}`}>
          Site
        </Link>
        <nav className="main-navigation">
          {menus.map((menu, index) => {
            const Icon = icons[index];
            return (
              <div
                className="nav-group"
                key={menu.name}
                onMouseEnter={() => setOpen(menu.name)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen("");
                }}
              >
                <button
                  className={
                    open === menu.name ? "nav-trigger selected" : "nav-trigger"
                  }
                  onClick={() => setOpen(menu.name)}
                  aria-expanded={open === menu.name}
                >
                  <Icon size={18} />
                  <span>{menu.name}</span>
                </button>
                {open === menu.name && (
                  <div className={"mega-menu menu-" + menu.name.toLowerCase()}>
                    {menu.groups.map((group, groupIndex) => (
                      <div
                        className={"menu-section menu-section-" + groupIndex}
                        key={group.name}
                      >
                        <h4>{group.name}</h4>
                        {group.items.filter(([, to]) => to !== "/settings/admin-users" || session.user.role === "owner").map(([label, to]) => (
                          <Link key={label} to={to}>
                            {label}
                          </Link>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <button className="header-search" aria-label="Search" onClick={() => setSearching(true)}>
          <Search size={16} />
          <span>Search…</span>
        </button>
        <div className="account-menu">
          <button onClick={() => setAccount(!account)}>
            Hi, {session.user.name.split(" ")[0]}!<ChevronDown size={13} />
          </button>
          {account && (
            <div className="dropdown-menu">
              <small>{session.user.email}</small>
              <span className="account-role">
                <UserRound size={14} />
                {session.user.role}
              </span>
              <Link to="/account/security">Change password</Link>
              <button disabled={loggingOut} onClick={async () => {
                if (loggingOut) return;
                setLoggingOut(true); setLogoutError("");
                try { await logout(); }
                catch { setLogoutError("Sign-out could not be confirmed. Check your connection and try signing out again."); }
                finally { setLoggingOut(false); }
              }}>
                <LogOut size={14} /> {loggingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          )}
        </div>
      </header>
      {open && (
        <button
          className="menu-dismiss"
          aria-label="Close navigation menu"
          onClick={() => setOpen("")}
        />
      )}
      <div className="app-content">
        <ErrorBox error={logoutError}/>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/settings/admin-users" element={<ConsoleAccess currentUser={session.user} />} />
          <Route path="/account/security" element={<AccountAuth mode="change-password" />} />
          <Route
            path="/programs"
            element={<Programs key={location.search} />}
          />
          <Route
            path="/program-summary"
            element={<ProgramSummary standalone />}
          />
          <Route path="/payment-plans" element={<PaymentPlanReport />} />
          <Route path="/programs/new" element={<ProgramEditor />} />
          <Route path="/programs/:id" element={<ProgramHome />} />
          <Route path="/programs/:id/edit" element={<ProgramEditor />} />
          <Route
            path="/programs/:id/options"
            element={<RegistrationOptions key={location.pathname} />}
          />
          <Route
            path="/settings/registration"
            element={<RegistrationOptions key={location.pathname} />}
          />
          <Route
            path="/programs/:id/payment-plans"
            element={<PaymentPlans key={location.pathname} />}
          />
          <Route path="/programs/:id/teams" element={<Teams />} />
          <Route
            path="/settings/registration/fields"
            element={<FormSettings key={location.pathname} />}
          />
          <Route
            path="/settings/registration/waivers"
            element={<FormSettings key={location.pathname} waivers />}
          />
          <Route
            path="/programs/:id/form-fields"
            element={<FormSettings key={location.pathname} />}
          />
          <Route
            path="/programs/:id/waivers"
            element={<FormSettings key={location.pathname} waivers />}
          />
          <Route path="/programs/:id/people" element={<Registrations />} />
          <Route path="/programs/:id/staff" element={<ProgramStaff />} />
          <Route path="/programs/:id/schedule" element={<Schedule />} />
          <Route
            path="/programs/:id/standings"
            element={<Standings key={location.pathname} />}
          />
          <Route
            path="/programs/:id/standings/rules"
            element={<StandingsSettings key={location.pathname} />}
          />
          <Route
            path="/settings/standings"
            element={<StandingsSettings key={location.pathname} />}
          />
          <Route path="/members" element={<Members />} />
          <Route
            path="/settings/terminology"
            element={<TerminologySettings />}
          />
          <Route
            path="/settings/members"
            element={<FormSettings key={location.pathname} profile />}
          />
          <Route path="/members/new" element={<MemberEditor />} />
          <Route
            path="/members/:id"
            element={<MemberProfile key={location.pathname} consoleRole={session.user.role} />}
          />
          <Route path="/members/:id/edit" element={<MemberEditor />} />
          <Route path="/households/new" element={<HouseholdEditor />} />
          <Route
            path="/households/:id"
            element={<HouseholdProfile key={location.pathname} />}
          />
          <Route path="/households/:id/edit" element={<HouseholdEditor />} />
          <Route path="/locations" element={<Locations />} />
          <Route path="/locations/new" element={<LocationEditor />} />
          <Route path="/locations/:id/edit" element={<LocationEditor />} />
          <Route path="/discount-codes" element={<Discounts />} />
          <Route path="/discount-codes/new" element={<DiscountEditor />} />
          <Route path="/discount-codes/:id/edit" element={<DiscountEditor />} />
          <Route path="/credits" element={<Credits />} />
          <Route
            path="/products"
            element={<Products key={location.pathname} />}
          />
          <Route path="/products/new" element={<ProductEditor />} />
          <Route path="/products/:id/edit" element={<ProductEditor />} />
          <Route path="/products/store" element={<StoreManager />} />
          <Route
            path="/programs/:id/products"
            element={<Products key={location.pathname} />}
          />
          <Route path="/store" element={<StorePreview />} />
          <Route path="/store/products/:id" element={<ProductPurchase />} />
          <Route path="/orders" element={<Orders key={location.search} />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route
            path="/messaging/compose"
            element={<Composer key={location.pathname + location.search} />}
          />
          <Route
            path="/messaging/compose/:id"
            element={<Composer key={location.pathname} />}
          />
          <Route
            path="/messaging/sent"
            element={
              <MessageHistory key={location.pathname + location.search} />
            }
          />
          <Route
            path="/messaging/texts"
            element={<MessageHistory key={location.pathname} />}
          />
          <Route path="/messaging/messages/:id" element={<MessageDetail />} />
          <Route path="/messaging/contacts" element={<EmailContacts />} />
          <Route path="/messaging/templates" element={<EmailTemplates />} />
          <Route path="/settings/organization" element={<OrganizationSettings />} />
          <Route path="/settings/email" element={<MessagingSettings />} />
          <Route path="/settings/sms" element={<MessagingSettings sms />} />
          <Route path="/teams" element={<Teams />} />
          <Route path="/teams/:teamId" element={<TeamProfile />} />
          <Route
            path="/programs/:id/team-builder"
            element={<TeamBuilder key={location.pathname} />}
          />
          <Route
            path="/programs/:id/roster-settings"
            element={<RosterSettings />}
          />
          <Route path="/reports/attendance" element={<AttendanceReport />} />
          <Route
            path="/activities/:id/attendance"
            element={<ActivityAttendance />}
          />
          <Route path="/reports/teams" element={<TeamPropertyReport />} />
          <Route path="/registrations" element={<Registrations />} />
          <Route path="/invoices" element={<Invoices />} />
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/schedule/import" element={<ScheduleImport key={location.pathname} />} />
          <Route path="/programs/:id/schedule/import" element={<ScheduleImport key={location.pathname} />} />
          <Route path="/calendar" element={<Schedule />} />
          <Route path="/website/pages" element={<WebsitePages />} />
          <Route path="/website/pages/new" element={<WebsitePageEditor />} />
          <Route
            path="/website/pages/:id/edit"
            element={<WebsitePageEditor key={location.pathname} />}
          />
          <Route
            path="/website/mobile"
            element={<WebsitePageEditor mobile />}
          />
          <Route path="/website/menu" element={<WebsiteMenu />} />
          <Route path="/website/editor" element={<WebsiteTheme />} />
          <Route path="/settings/staff" element={<StaffRoles />} />
          <Route path="*" element={<Unfinished />} />
        </Routes>
      </div>
      <footer className="footer">
        <Link to="/" className="footer-brand">
          A <span>ATHLENTRY</span>
        </Link>
        <span>Northstar Youth Sports · Local workspace</span>
      </footer>
      {searching && (
        <Modal title="Search Athlentry" onClose={closeSearch}>
          <GlobalSearch close={closeSearch} />
        </Modal>
      )}
    </div>
  );
}
function GlobalSearch({ close }: { close: () => void }) {
  const [value, setValue] = useState(""),
    navigate = useNavigate();
  const [records, setRecords] = useState<{ kind: string; id: string; label: string; detail: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setRecords([]); setError("");
    if (value.trim().length < 2) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      api("/search?q=" + encodeURIComponent(value.trim()), { signal: controller.signal })
        .then((data) => { if (!controller.signal.aborted) setRecords(data.results); })
        .catch((e) => { if (!controller.signal.aborted) setError(e.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [value]);
  const matches = menus
    .flatMap((m) => m.groups.flatMap((g) => g.items))
    .filter(([name]) => name.toLowerCase().includes(value.toLowerCase()));
  return (
    <div className="modal-body">
      <input
        autoFocus
        aria-label="Search programs, members, invoices, and pages"
        placeholder="Search programs, members, invoices…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {value.trim().length >= 2 && <section aria-label="Matching records" aria-live="polite">
        {loading ? <p>Searching…</p> : error ? <p role="alert">{error}</p> : !records.length ? <p>No matching records.</p> : <div className="search-records">{records.map((record) => <button type="button" key={record.kind + record.id} onClick={() => { close(); navigate(record.path); }}><small>{record.kind}</small><strong>{record.label}</strong><span>{record.detail}</span></button>)}</div>}
      </section>}
      <h3>Pages</h3>
      <div className="search-results">
        {matches.map(([name, path], i) => (
          <button
            key={name + i}
            onClick={() => {
              close();
              navigate(path);
            }}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}
function Unfinished() {
  const location = useLocation(),
    entry = menus
      .flatMap((m) => m.groups.flatMap((g) => g.items))
      .find(([, path]) => path === location.pathname);
  return (
    <>
      <PageTitle title={entry?.[0] ?? "Page unavailable"} />
      <main className="content-page">
        <h2>We couldn’t find this page.</h2>
        <p>The address may be incorrect or the page may have moved. Use the navigation above or return to your dashboard.</p>
        <Link to="/">Return to Dashboard</Link>
      </main>
    </>
  );
}
