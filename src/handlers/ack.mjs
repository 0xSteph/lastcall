// POST /v1/plans/{id}/ack?c=<index>&s=<contactSecret>  body {note?} or empty (?a=ack, ntfy button)
//   -> 200 contact view; 409 not_alerted | already_acknowledged | safe | closed.

import { json, readJsonBody, route } from '../lib/http.mjs';
import { ackChanges } from '../lib/actions.mjs';
import { contactView, loadForContact, mutatePlan } from '../lib/plans.mjs';
import { validateAck } from '../lib/validate.mjs';

export const handler = route(async (event) => {
  const { plan, index } = await loadForContact(event);
  const input = validateAck(readJsonBody(event, { optional: true }));
  const result = await mutatePlan(plan, (current, now) => ackChanges(current, index, input, now));
  return json(200, contactView(result.plan, result.events, index));
});
