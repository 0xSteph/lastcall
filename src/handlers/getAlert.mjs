// GET /v1/plans/{id}/alert?c=<index>&s=<contactSecret> -> 200 contact view

import { getEvents } from '../lib/db.mjs';
import { json, route } from '../lib/http.mjs';
import { contactView, loadForContact } from '../lib/plans.mjs';

export const handler = route(async (event) => {
  const { plan, index } = await loadForContact(event);
  return json(200, contactView(plan, await getEvents(plan.id), index));
});
