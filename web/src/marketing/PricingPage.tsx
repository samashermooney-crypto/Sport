import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { z } from 'zod';

import { apiGet } from '../api/client';

import './landing.css';

const publicPlansSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      monthlyPriceCents: z.number().int().nonnegative(),
      customPricing: z.boolean(),
    }),
  ),
});

function formatPrice(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function PricingPage(): React.JSX.Element {
  const plans = useQuery({
    queryKey: ['public-website-plans'],
    queryFn: () => apiGet('/website/public/plans', publicPlansSchema),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="al pricing-page">
      <a className="al-skip" href="#main">
        Skip to content
      </a>
      <header className="al-nav">
        <Link className="al-logo" to="/welcome" aria-label="Athlentry home">
          <span className="al-symbol">A</span>athlentry
        </Link>
        <nav aria-label="Main navigation">
          <Link to="/welcome">The platform</Link>
          <Link to="/pricing" aria-current="page">
            Pricing
          </Link>
          <Link to="/">Open platform</Link>
        </nav>
      </header>
      <main id="main" className="al-section pricing-page__main">
        <p className="al-label">PLANS FOR YOUR ORGANIZATION</p>
        <h1>
          Room to run
          <br />
          your next season.
        </h1>
        <p className="pricing-page__intro">
          Current monthly plans from the Athlentry plan catalog. Features depend
          on your organization’s configuration and your role.
        </p>
        {plans.isPending ? (
          <p role="status">Loading current plans…</p>
        ) : plans.isError ? (
          <p role="alert">Plan pricing could not be loaded right now.</p>
        ) : plans.data.items.length === 0 ? (
          <p role="status">No plans are currently available.</p>
        ) : (
          <ul className="pricing-page__plans" aria-label="Available plans">
            {plans.data.items.map((plan) => (
              <li className="pricing-page__plan" key={plan.key}>
                <h2>{plan.name}</h2>
                <p className="pricing-page__price">
                  {plan.customPricing
                    ? 'Custom pricing'
                    : plan.monthlyPriceCents === 0
                      ? 'Free'
                      : formatPrice(plan.monthlyPriceCents)}
                  {!plan.customPricing && plan.monthlyPriceCents > 0 && (
                    <span> / month</span>
                  )}
                </p>
                {plan.customPricing && (
                  <p>Pricing is arranged for your organization.</p>
                )}
              </li>
            ))}
          </ul>
        )}
        <Link className="al-button" to="/">
          Open Athlentry
        </Link>
      </main>
      <footer className="al-footer">
        <Link to="/welcome" className="al-logo">
          athlentry
        </Link>
        <nav aria-label="Legal information">
          <Link to="/legal/terms">Terms</Link>
          <Link to="/legal/privacy">Privacy</Link>
          <Link to="/legal/accessibility">Accessibility</Link>
        </nav>
      </footer>
    </div>
  );
}
