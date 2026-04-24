// Barrel — single import surface for the rest of the scraper.
// Construct one http client at boot, then thread it through the domain
// functions. Keeps each call site a single line.
//
// Example:
//   const http = createDashboardHttpClient({ baseUrl: env.DASHBOARD_BASE, serviceToken: env.DASHBOARD_SERVICE_TOKEN, logger });
//   const list = await listClients({ http });
//   if (list.ok) console.log(list.value.clients);

export { createHttpClient, HttpError } from '../common/httpClient.js';
export { listClients } from './listClients.js';
export { getProfile } from './getProfile.js';
export { getExclusions } from './getExclusions.js';
export { updateExclusions } from './updateExclusions.js';
export { pushJob, buildPushJobPayload } from './pushJob.js';
