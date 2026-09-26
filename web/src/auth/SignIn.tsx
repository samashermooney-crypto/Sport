export function SignIn(): React.JSX.Element {
  return (
    <div className="auth-shell">
      <header className="auth-chrome">
        <span className="auth-brand">Athlentry</span>
      </header>
      <main className="auth-main">
        <section className="auth-panel" aria-labelledby="signin-heading">
          <h1 id="signin-heading">Sign in</h1>
          <p>Account access is being set up.</p>
        </section>
      </main>
    </div>
  );
}
