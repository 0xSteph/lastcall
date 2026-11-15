# Last Call

**If you don't check in, the people you trust find out.**

Last Call is a check-in safety net for anyone doing something alone: a solo hike,
a first date, a late shift, a long drive. Tell it what you're doing, when you'll
be back, and who to tell. Check in by then and nothing happens. Miss it, and Last
Call alerts your contacts one at a time, with your plan and your last known
location, until someone says "I'm on it".

It runs entirely on serverless AWS, and nothing runs while a plan is waiting.

**Try it:** the [2-minute live demo](https://d2ifh0zqxfrt39.cloudfront.net/demo.html)
creates a real plan and shows the owner's and both contacts' phones side by side.

> Last Call is not an emergency service. If someone is in danger, call your local
> emergency number.

## How it works for people

1. **Make a plan.** What you're doing, when you'll be back, and up to five
   contacts in order. Optionally details, a route link, your phone number and your
   starting location. No account: you get a private link to your plan, and each
   contact gets their own link.
2. **Get a reminder.** Before the deadline, a push with one-tap **I'm safe** and
   **+30 min** buttons.
3. **Miss it, and Last Call takes over.** You get a "you missed your check-in"
   ping and a grace period. Then your first contact gets an urgent alert: your
   plan, how overdue you are, a map of your last known location, and a call
   button. If they don't tap **I'm on it** in time, the next contact is alerted.
4. **Need help now?** Press and hold **I need help** to alert everyone at once.
5. **Back safe?** Check in any time, and everyone who was alerted gets an all-clear.

Alerts are phone push notifications through the free [ntfy](https://ntfy.sh) app
(no account needed), or Slack, Discord or any HTTPS webhook.

## How it's built

```
             ┌────────────────────────────────────────────┐
             ▼                                            │
 Advance (Lambda) ── done? ──yes──▶ end                   │
   │ applies whatever is due now,                         │
   │ sends its notifications,                             │
   │ returns seconds to the next milestone                │
   ▼ no                                                   │
 WaitForEvent (.waitForTaskToken, TimeoutSecondsPath) ────┘
   wakes on the timeout (a deadline arrived)
   or on SendTaskSuccess (check-in, "I'm on it", SOS)
```

| Service | Role |
|---|---|
| **AWS Step Functions** | One Standard execution per plan, running the loop above. `.waitForTaskToken` with a computed `TimeoutSecondsPath` parks the execution at no cost until the next deadline or until something happens. The same loop handles the reminder, the grace period, one-at-a-time escalation, SOS, extensions and the all-clear, for plans from a minute to a week long. |
| **AWS Lambda** | API handlers (create, view, check in, share location, acknowledge) and the two workflow tasks. Node.js 22 on arm64, no runtime dependencies beyond the AWS SDK in the runtime. |
| **Amazon API Gateway** | HTTP API with CORS and throttling. |
| **Amazon DynamoDB** | The source of truth: plans, contacts, events, and per-IP rate limits, in one table with TTL cleanup. |
| **Amazon S3 + CloudFront** | The static web app over HTTPS. |

Everything is one AWS SAM template: no servers, containers or pipelines.

### Reliability

- **One place for side effects.** API endpoints never send notifications. They
  record the change with a version-checked conditional write and nudge the
  workflow. Only Advance sends, and it marks each notification as sent before
  sending it, so retries and races never alert anyone twice. If a nudge is lost,
  the next wake-up catches up from the table.
- **Server time decides.** Plans can be created with a relative deadline
  (`checkInInSeconds`), and every view includes the server's `now`, so countdowns
  and deadlines are right even on a device with a wrong clock.
- **Safe outbound calls.** Notification URLs are user-supplied, so every request is
  HTTPS-only and refuses private, loopback, link-local and metadata addresses,
  with DNS checked inside the socket lookup to close the rebinding window.
- **Links are the keys.** Owner and contact secrets live in the URL fragment, so
  they never reach access logs, and are stored only as SHA-256 hashes.

## Run it yourself

Requirements: Node.js 20+, the AWS CLI, and the AWS SAM CLI, signed in to an AWS
account.

```bash
npm install
npm test                       # backend unit tests
node --test mock/              # web app and mock API tests
node scripts/deploy.mjs        # sam build + deploy, then uploads the web app
node scripts/e2e.mjs <ApiUrl>  # end-to-end test against your stack (~2.5 min)
```

The first deploy takes about 5 to 10 minutes, mostly CloudFront. To remove it,
empty the web bucket, then run `sam delete --stack-name lastcall`.

For front-end work without AWS, `node mock/server.mjs` runs an in-memory copy of
the API with real timers and serves the web app at http://localhost:8787/web/.

## Repository layout

| Path | What |
|---|---|
| `template.yaml` | AWS SAM template: API, functions, state machine, table, web hosting |
| `statemachine/lastcall.asl.json` | The Advance / WaitForEvent loop |
| `src/handlers/` | API handlers and the two workflow tasks |
| `src/lib/` | Timing rules, state changes, messages, notification presets, safe outbound HTTP |
| `web/` | Landing page, plan creation, owner page, contact alert page, live demo (vanilla JS, no build step) |
| `mock/` | In-memory mock of the API for local development, plus web tests |
| `tests/` | Backend unit tests, including a full simulated plan lifecycle |
| `scripts/` | Deploy, validate and end-to-end test scripts |
