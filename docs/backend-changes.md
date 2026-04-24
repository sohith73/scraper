# Dashboard backend — optional patch

**Status:** Optional. The scraper currently works end-to-end against the
unmodified dashboard backend via `GET /api/clients/all` (no auth) and
`POST /addjob` (no auth beyond the role-string convention).

This doc exists so the change — if/when the dashboard team wants it — is a
one-file diff with zero ambiguity.

## Change 1: `GET /operations/clients` — thin aggregator for the scraper UI

### Why

The scraper's client picker needs `{ email, name, hasProfile, profileUpdatedAt }` per client. Today it falls back to `GET /api/clients/all` (which returns the full `UserModel` projection) + an
inference that every returned row is pickable. That works, but:

- It pulls more columns than we need.
- It doesn't tell the operator *which clients are actually onboarded*
  (i.e. have a `ProfileModel`).

### Diff

Add `Controllers/operations/ListClients.js`:

```js
// flashfire-dashboard-backend-main/Controllers/operations/ListClients.js
import { UserModel } from '../../Schema_Models/UserModel.js';
import { ProfileModel } from '../../Schema_Models/ProfileModel.js';

// Aggregator for operator-facing tools (the JobRight scraper).
// Returns { email, name, hasProfile, profileUpdatedAt } per client so the
// UI can render a picker with an "onboarded" badge without pulling the
// full UserModel projection.
export default async function ListClients(req, res) {
    try {
        const users = await UserModel.find({}, { email: 1, name: 1 }).lean();
        const emails = users.map((u) => String(u.email).toLowerCase());
        const profiles = await ProfileModel.find(
            { email: { $in: emails } },
            { email: 1, updatedAt: 1 },
        ).lean();
        const byEmail = new Map();
        for (const p of profiles) {
            byEmail.set(String(p.email).toLowerCase(), p.updatedAt);
        }
        const data = users.map((u) => {
            const e = String(u.email).toLowerCase();
            return {
                email: e,
                name: u.name || '',
                hasProfile: byEmail.has(e),
                profileUpdatedAt: byEmail.get(e) || null,
            };
        });
        res.status(200).json({ success: true, data, count: data.length });
    } catch (err) {
        console.error('ListClients error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
}
```

Register the route in `Routes.js`:

```diff
@@
 import { reconcileExclusionJobsHandler } from "./Controllers/operations/reconcileExclusionJobs.js";
+import ListClients from "./Controllers/operations/ListClients.js";
@@
 app.post('/operations/client-operations', getClientOperations);
 app.put('/operations/client-operations', updateClientOperations);
+app.get('/operations/clients', ListClients);
 app.post('/operations/reconcile-exclusion-jobs', reconcileExclusionJobsHandler);
```

Optional (recommended) — guard behind a shared service token so only the
scraper can call it:

```js
// Middleware check (small):
if (req.headers['x-service-token'] !== process.env.DASHBOARD_SERVICE_TOKEN) {
    return res.status(401).json({ success: false, message: 'bad service token' });
}
```

Corresponding scraper-side change in `src/clients/dashboard/listClients.js`:

```diff
-const LIST_CLIENTS_PATH = '/api/clients/all';
+const LIST_CLIENTS_PATH = '/operations/clients';
```

And `src/clients/common/httpClient.js` already attaches `X-Service-Token`
when `DASHBOARD_SERVICE_TOKEN` is set.

### Test checklist

1. `curl http://localhost:8086/operations/clients` returns `{success:true, data:[...], count}`.
2. Each `data[i]` has `email`, `name`, `hasProfile`, `profileUpdatedAt`.
3. With `DASHBOARD_SERVICE_TOKEN` set and a mismatched header → 401.

---

## Change 2: `AddJob.js` — accept `role: 'scraper'`

**Status:** Not needed. The scraper currently sends `role: 'operations'`
with `operationsEmail: 'scraper@flashfirehq'` + `operationsName: 'JobRightScraper'`, which `AddJob.js` handles correctly today. The job ends up
with `createdByRole: 'operations'` and `operatorName: 'JobRightScraper'`.

If the dashboard team wants a distinct provenance string (e.g. for
reporting / filtering scraped-vs-manual jobs), the change is:

```diff
@@ AddJob.js
-        const isOpsRole = role === 'operations' || role === 'operator';
+        const isOpsRole = role === 'operations' || role === 'operator' || role === 'scraper';
@@
-        if (isOpsRole) {
-            jobDetails.createdByRole = 'operations';
-            jobDetails.timeline = ['Added'];
+        if (isOpsRole) {
+            jobDetails.createdByRole = role === 'scraper' ? 'scraper' : 'operations';
+            jobDetails.timeline = role === 'scraper'
+                ? ['Added by scraper']
+                : ['Added'];
```

And `JobModel.createdByRole`'s enum needs `'scraper'` added.

Scraper-side, change `src/clients/dashboard/pushJob.js → buildPushJobPayload`:

```diff
-        role: 'operations',
+        role: 'scraper',
```

Leave alone until reporting needs it.
