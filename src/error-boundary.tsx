import { Component, type ReactNode } from "react";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="content-page" style={{maxWidth:640,margin:"40px auto",padding:24}}>
      <h1>This page could not be displayed</h1>
      <p>A page error interrupted the application. Reload to try again. Unsaved form entries will be lost.</p>
      <p>If the error happened while saving, review the record after reloading before submitting the change again.</p>
      <button className="button" type="button" onClick={()=>window.location.reload()}>Reload application</button>
      <p><a href="/">Return to dashboard</a></p>
    </main>;
  }
}
