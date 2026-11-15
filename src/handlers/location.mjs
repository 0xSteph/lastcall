// POST /v1/plans/{id}/location?s=<ownerSecret>  body {lat, lng, accuracy?}
//   -> 200 owner view; 409 already_safe | closed.
//
// A location fix changes no timing, so the workflow is not nudged: alerts sent from
// now on read the newest fix from the plan.

import { conflict, json, readJsonBody, route } from '../lib/http.mjs';
import { locationChanges } from '../lib/actions.mjs';
import { loadForOwner, mutatePlan, ownerView } from '../lib/plans.mjs';
import { validateLocation } from '../lib/validate.mjs';

export const handler = route(async (event) => {
  const plan = await loadForOwner(event);
  const location = validateLocation(readJsonBody(event), 'body');
  const result = await mutatePlan(plan, (current, now) => {
    if (current.status === 'safe') throw conflict('already_safe', 'This plan is already checked in safe.');
    if (current.status === 'closed') throw conflict('closed', 'This plan is closed.');
    return locationChanges(current, location, now);
  }, { nudgeWorkflow: false });
  return json(200, ownerView(result.plan, result.events));
});
