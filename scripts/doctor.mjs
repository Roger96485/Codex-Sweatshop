import { CodexClient, redact } from '../src/codex.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (!['--binary', '--home', '--cwd'].includes(flag) || !process.argv[index + 1]) {
    console.error('Usage: npm run doctor -- [--binary PATH] [--home CODEX_HOME] [--cwd WORKSPACE]');
    process.exit(2);
  }
  options[flag.slice(2)] = process.argv[++index];
}
const client = new CodexClient(options);
const report = { readOnly: true, inferenceStarted: false, checks: {} };
client.on('serverRequest', request => {
  // A diagnostic probe must never grant permission or invent authentication tokens.
  report.unexpectedServerRequests ??= [];
  report.unexpectedServerRequests.push(request.method);
});
try {
  report.connection = await client.connect();
  const checks = await Promise.allSettled([client.readAccount(), client.listModels(), client.listThreads(), client.readLimits()]);
  const names = ['account', 'models', 'threads', 'limits'];
  checks.forEach((check, index) => {
    const name = names[index];
    if (check.status === 'rejected') {
      report.checks[name] = { ok: false, code: check.reason.code, error: redact(check.reason.message) };
      return;
    }
    const value = check.value;
    if (name === 'account') report.checks.account = { ok: true, signedIn: Boolean(value.account), type: value.account?.type ?? null, plan: value.account?.planType ?? null };
    if (name === 'models') report.checks.models = { ok: true, count: value.length, models: value.map(model => ({ id: model.model, efforts: model.supportedReasoningEfforts?.map(option => option.reasoningEffort) ?? [], serviceTiers: model.serviceTiers?.map(tier => tier.id) ?? model.additionalSpeedTiers ?? [] })) };
    if (name === 'threads') report.checks.threads = { ok: true, count: value.data?.length ?? 0, morePages: Boolean(value.nextCursor), statuses: [...new Set(value.data?.map(thread => thread.status?.type) ?? [])] };
    if (name === 'limits') report.checks.limits = {
      ok: true, buckets: Object.keys(value.rateLimitsByLimitId ?? {}),
      ordinaryUsageAllowed: value.ordinaryUsageAllowed ?? null,
      primary: value.rateLimits?.primary ?? null, secondary: value.rateLimits?.secondary ?? null,
      resetCreditsAvailable: value.rateLimitResetCredits?.availableCount ?? null,
    };
  });
  if (checks.some(check => check.status === 'rejected')) process.exitCode = 1;
} catch (error) {
  report.connection = client.status;
  report.error = { code: error.code, message: redact(error.message) };
  process.exitCode = 1;
} finally {
  await client.stop();
  console.log(JSON.stringify(report, null, 2));
}
