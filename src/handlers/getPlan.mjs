// GET /v1/plans/{id}?s=<ownerSecret> -> 200 owner view

import { getEvents } from '../lib/db.mjs';
import { json, route } from '../lib/http.mjs';
import { loadForOwner, ownerView } from '../lib/plans.mjs';

export const handler = route(async (event) => {
  const plan = await loadForOwner(event);
  return json(200, ownerView(plan, await getEvents(plan.id)));
});
