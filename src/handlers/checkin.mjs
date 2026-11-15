// POST /v1/plans/{id}/checkin?s=<ownerSecret>  body {action: safe|extend|sos, minutes?, note?, location?}
// or   POST /v1/plans/{id}/checkin?s=<ownerSecret>&a=safe|extend|sos[&m=30]  with no body (ntfy buttons)
//   -> 200 owner view; 409 already_safe | closed | cannot_extend; 400 validation.

import { json, readJsonBody, route } from '../lib/http.mjs';
import { checkinChanges } from '../lib/actions.mjs';
import { loadForOwner, mutatePlan, ownerView } from '../lib/plans.mjs';
import { validateCheckin } from '../lib/validate.mjs';

export const handler = route(async (event) => {
  const plan = await loadForOwner(event);
  const input = validateCheckin(readJsonBody(event, { optional: true }), event.queryStringParameters ?? {});
  const result = await mutatePlan(plan, (current, now) => checkinChanges(current, input, now));
  return json(200, ownerView(result.plan, result.events));
});
