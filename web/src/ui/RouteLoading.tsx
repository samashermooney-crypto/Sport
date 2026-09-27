export function RouteLoading({
  label = 'Loading page…',
}: {
  label?: string;
}): React.JSX.Element {
  return <main role="status">{label}</main>;
}
