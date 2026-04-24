// listClients: fetch every client the dashboard knows about.
//
// Why : the scraper UI needs to render a client picker. Dashboard backend
//       already exposes GET /api/clients/all returning
//       { success, data:[{userID,name,email,planType,dashboardManager,...}], count }.
//       When the dashboard team later adds GET /operations/clients (per
//       backend-changes.md), swap the path here; response shape is aligned.
// Input  : { http:<DashboardHttpClient> }
// Output : Result<{ clients: Array<{email,name,userID,planType,dashboardManager}>, count:number }>

import { ok, err } from '../common/result.js';
import { HttpError } from '../common/httpClient.js';

const LIST_CLIENTS_PATH = '/api/clients/all';

export async function listClients({ http }) {
    let res;
    try {
        res = await http.get(LIST_CLIENTS_PATH);
    } catch (e) {
        if (e instanceof HttpError) {
            return err(e.kind.toUpperCase(), e.message, { cause: e.cause });
        }
        throw e;
    }
    if (res.status !== 200) {
        return err('BAD_STATUS', `unexpected status ${res.status}`, {
            status: res.status,
            bodyJson: res.bodyJson,
        });
    }
    const body = res.bodyJson;
    if (!body || body.success !== true || !Array.isArray(body.data)) {
        return err('BAD_SHAPE', 'response missing success or data[]', { bodyJson: body });
    }
    // Normalise + drop rows missing the only field we truly need (email).
    const clients = body.data
        .filter((c) => typeof c?.email === 'string' && c.email.length > 0)
        .map((c) => ({
            email: String(c.email).toLowerCase(),
            name: typeof c.name === 'string' ? c.name : '',
            userID: typeof c.userID === 'string' ? c.userID : '',
            planType: typeof c.planType === 'string' ? c.planType : '',
            dashboardManager: typeof c.dashboardManager === 'string' ? c.dashboardManager : '',
        }));
    return ok({ clients, count: clients.length });
}
