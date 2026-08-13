/**
 * cath-simulator -- a fake CaTH that pushes publications at the receiver.
 *
 * Deployed separately from the receiver on purpose. The receiver must be
 * pointable at the real CaTH without this Worker anywhere near it.
 *
 *   GET  /                     what this is, and what it can run
 *   POST /run?scenario=daily   run a scenario now, get a report back
 *   cron                       daily push, 1AM UTC release, supersedes, deletes
 */
import { fetchToken } from './deliver.js';
import { dailyVolume, receiverUrl, type SimulatorEnv } from './env.js';
import { runScenario, type ScenarioName } from './scenarios.js';

const SCENARIOS: ScenarioName[] = [
  'daily',
  'supersede',
  'delete',
  'flat_files',
  'future_dated',
  'welsh',
  'retry_proof',
  'chaos',
  'health',
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function summarise(report: Awaited<ReturnType<typeof runScenario>>) {
  const attempts = report.deliveries.flatMap((d) => d.attempts);
  const statuses: Record<string, number> = {};
  for (const attempt of attempts) {
    const key = String(attempt.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  return {
    scenario: report.scenario,
    seed: report.seed,
    notes: report.notes,
    pushes: report.deliveries.length,
    delivered: report.deliveries.filter((d) => d.delivered).length,
    undelivered: report.deliveries.filter((d) => !d.delivered).length,
    totalAttempts: attempts.length,
    retriesForced: report.deliveries.reduce((sum, d) => sum + d.retries, 0),
    statuses,
    deliveries: report.deliveries,
  };
}

export default {
  async fetch(request: Request, env: SimulatorEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/' && request.method === 'GET') {
      return json({
        service: 'cath-simulator',
        pushesTo: receiverUrl(env),
        authenticated: Boolean(env.CLIENT_SECRET),
        dailyVolume: dailyVolume(env),
        scenarios: SCENARIOS,
        usage: 'POST /run?scenario=<name>&count=<n>&seed=<string>',
      });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      const requested = url.searchParams.get('scenario') as ScenarioName | null;
      if (requested && !SCENARIOS.includes(requested)) {
        return json({ error: 'unknown_scenario', scenarios: SCENARIOS }, 400);
      }

      const countParam = Number.parseInt(url.searchParams.get('count') ?? '', 10);
      const token = await fetchToken(env);

      const report = await runScenario(env, requested ?? 'daily', {
        seed: url.searchParams.get('seed') ?? undefined,
        count: Number.isFinite(countParam) ? countParam : undefined,
        token,
      });

      return json({ authenticated: Boolean(token), ...summarise(report) });
    }

    return json({ error: 'not_found', usage: 'GET / or POST /run' }, 404);
  },

  async scheduled(event: ScheduledController, env: SimulatorEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const token = await fetchToken(env);
        const hour = new Date(event.scheduledTime).getUTCHours();
        const seed = `cron-${new Date(event.scheduledTime).toISOString().slice(0, 13)}`;

        // 1AM UTC is when CaTH releases future-dated publications, so the
        // day's volume lands together with them.
        const scenarios: ScenarioName[] =
          hour === 1
            ? ['future_dated', 'daily', 'welsh']
            : ['supersede', 'delete', 'flat_files'];

        for (const scenario of scenarios) {
          const report = await runScenario(env, scenario, { seed: `${seed}-${scenario}`, token });
          const summary = summarise(report);
          console.log(
            `${scenario}: ${summary.delivered}/${summary.pushes} delivered, ` +
              `${summary.retriesForced} retries forced, statuses ${JSON.stringify(summary.statuses)}`,
          );
        }
      })(),
    );
  },
};
