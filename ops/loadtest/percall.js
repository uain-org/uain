// The same load as agents.js, reporting p95 per call type.
import * as base from './agents.js';
export * from './agents.js';
const names = Object.keys(base.options.scenarios);
export const options = {
  ...base.options,
  thresholds: Object.fromEntries(
    names.map((n) => [`http_req_duration{scenario:${n}}`, ['p(95)<100000']]),
  ),
};
