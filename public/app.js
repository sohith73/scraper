// Vanilla JS UI for the scraper. No bundler. Fetches live from local /api.
// Three panes: client list · profile + scrape controls · run console.

const API = '/api';

// Phases in execution order, used to render the static timeline skeleton.
const PHASE_SEQUENCE = [
    { key: 'loading-profile', label: 'Loading client profile from dashboard' },
    { key: 'loading-exclusions', label: 'Loading excluded companies + locations' },
    { key: 'loading-resume', label: 'Fetching linked resume' },
    { key: 'summarising', label: 'Passing profile + resume to gpt-4o-mini' },
    { key: 'searching', label: 'Querying JobRight (paginates until target met)' },
    { key: 'filtering', label: 'Analysing jobs with AI (pick / skip / borderline)' },
    { key: 'enriching', label: 'Validating job completeness' },
    { key: 'preflight', label: 'Applying exclusion guard + dedupe' },
    { key: 'pushing', label: 'Pushing picks to client dashboard' },
];

const TERMINAL_PHASES = new Set(['done', 'failed', 'aborted']);
// Non-terminal but SSE stays open — operator action required.
const PAUSED_PHASES = new Set(['awaiting-relaxation']);

const state = {
    clients: [],
    filter: '',
    selectedEmail: null,
    profile: null,
    exclusions: null,
    summary: null,
    savedRecord: null,  // last-persisted { intent, overrides, meta } for this client
    run: null,
    eventSource: null,
    decisionsVisible: true,
    decisionsFilter: 'all', // all | pick | skip
    // Latest feedback entry per jobId for the current client — drives button
    // highlight state. `{ [jobId]: { verdict, entryId } }`.
    feedbackByJob: {},
    // Operator-edited "About this candidate" draft + saved baseline. Baseline
    // comes from the persisted intent (or freshly-built summary). Draft is
    // dirty when it differs.
    aboutDraft: '',
    aboutBaseline: '',
};

const $ = (id) => document.getElementById(id);

function setStatus(id, message, { error = false } = {}) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', Boolean(error));
}

function fmtMs(ms) {
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

// --- /api/health ---------------------------------------------------------

async function loadHealth() {
    try {
        const res = await fetch(`${API}/health`);
        const body = await res.json();
        $('header-status').textContent = `ok · port ${body.port} · v${body.version} · node ${body.node}`;
    } catch (err) {
        $('header-status').textContent = `offline: ${err.message}`;
    }
}

// --- /api/clients --------------------------------------------------------

async function loadClients() {
    setStatus('client-list-status', 'loading clients…');
    try {
        const res = await fetch(`${API}/clients`);
        const body = await res.json();
        if (!body.success) throw new Error(body.message || body.error || 'load failed');
        state.clients = body.clients || [];
        setStatus(
            'client-list-status',
            `${state.clients.length} client${state.clients.length === 1 ? '' : 's'}`,
        );
        renderClients();
    } catch (err) {
        setStatus('client-list-status', `error: ${err.message}`, { error: true });
    }
}

function renderClients() {
    const list = $('client-list');
    const needle = state.filter.toLowerCase().trim();
    const shown = needle
        ? state.clients.filter(
              (c) =>
                  (c.name || '').toLowerCase().includes(needle) ||
                  (c.email || '').toLowerCase().includes(needle),
          )
        : state.clients;
    list.innerHTML = '';
    for (const c of shown) {
        const li = document.createElement('li');
        if (c.email === state.selectedEmail) li.classList.add('selected');
        const name = c.name || '(no name)';
        li.innerHTML = `
            <div class="name"></div>
            <div class="email"></div>
            ${c.planType ? '<div class="plan"></div>' : ''}
        `;
        li.querySelector('.name').textContent = name;
        li.querySelector('.email').textContent = c.email;
        const planEl = li.querySelector('.plan');
        if (planEl) planEl.textContent = c.planType;
        li.addEventListener('click', () => selectClient(c.email));
        list.appendChild(li);
    }
}

// --- /api/clients/:email/profile ----------------------------------------

async function selectClient(email) {
    if (state.selectedEmail === email) return;
    state.selectedEmail = email;
    state.profile = null;
    state.exclusions = null;
    state.summary = null;
    state.savedRecord = null;
    // Reset Advanced Filters UI so values from the previously-selected
    // client don't leak into the new selection.
    resetFilterInputs();
    renderClients();
    renderProfile();
    renderSummary();
    setStatus('profile-status', 'loading profile…');

    try {
        loadFeedback(email);
        const [profileRes, savedRes] = await Promise.all([
            fetch(`${API}/clients/${encodeURIComponent(email)}/profile`),
            fetch(`${API}/clients/${encodeURIComponent(email)}/filters`),
        ]);
        const body = await profileRes.json();
        if (!body.success) {
            setStatus('profile-status', `error: ${body.message || body.error}`, { error: true });
            return;
        }
        state.profile = body.profile;
        state.exclusions = body.exclusions;

        // Pre-populate Advanced Filters + cache the intent so the next
        // Scrape click skips the summariser entirely (AI cost = $0).
        const savedBody = await savedRes.json().catch(() => null);
        const saved = savedBody?.record || null;
        if (saved) {
            state.savedRecord = saved;
            if (saved.intent) {
                state.summary = {
                    intent: saved.intent,
                    cacheHit: true,
                    resumeFound: false,
                };
                renderSummary();
            }
            applySavedOverrides(saved);
        }

        renderProfile();
        setStatus(
            'profile-status',
            saved
                ? `loaded saved filters (${saved.meta?.savedAt?.slice(0, 10) || 'unknown date'})`
                : '',
        );
    } catch (err) {
        setStatus('profile-status', `error: ${err.message}`, { error: true });
    }
}

// resetFilterInputs: reset every Advanced Filters control to its DEFAULT
// (not blank). Called when switching clients so stale values don't carry
// over. The two clearance/citizenship excludes default to ON because
// every Flashfire client we work with is on F-1 / OPT / H-1B; matching
// US-citizen-only / clearance-required postings is a guaranteed waste of
// dashboard slots. Date posted defaults to past 24 h so we surface only
// fresh roles. Saved per-client overrides (applySavedOverrides) override
// any of these afterwards.
function resetFilterInputs() {
    const el = (id) => $(id);
    if (el('filter-country')) el('filter-country').value = '';
    if (el('filter-daysAgo')) el('filter-daysAgo').value = '1';
    if (el('filter-seniority')) el('filter-seniority').value = '';
    if (el('filter-yoe')) el('filter-yoe').value = '';
    if (el('filter-salary')) el('filter-salary').value = '';
    for (const cb of document.querySelectorAll(
        'input[name="employmentTypes"],input[name="workModels"],input[name="companyStages"]',
    )) {
        cb.checked = false;
    }
    if (el('filter-excludeStaffing')) el('filter-excludeStaffing').checked = false;
    if (el('filter-excludeClearance')) el('filter-excludeClearance').checked = true;
    if (el('filter-excludeCitizen')) el('filter-excludeCitizen').checked = true;
    if (el('filter-remarks')) { el('filter-remarks').value = ''; updateRemarksCount(); }
}

// yoeRangeFromSelect: map "2-4" style values to { min, max } integers.
function yoeRangeFromSelect(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    const m = raw.match(/^(\d+)-(\d+)$/);
    if (!m) return null;
    return { min: Number(m[1]), max: Number(m[2]) };
}

// yoeSelectFromRange: reverse — pick the select value that matches stored min/max.
// Falls back to closest bucket when the exact pair isn't in the option list.
function yoeSelectFromRange(min, max) {
    if (!Number.isInteger(min) && !Number.isInteger(max)) return '';
    const lo = Number.isInteger(min) ? min : 0;
    const hi = Number.isInteger(max) ? max : 40;
    const opts = ['0-1', '0-2', '2-4', '4-6', '5-8', '8-12', '10-40'];
    for (const o of opts) {
        const [a, b] = o.split('-').map(Number);
        if (a === lo && b === hi) return o;
    }
    return '';
}

function updateRemarksCount() {
    const ta = $('filter-remarks');
    const counter = $('filter-remarks-count');
    if (!ta || !counter) return;
    counter.textContent = `${ta.value.length} / 1000`;
}

// applySavedOverrides: populate Advanced Filters from a saved record's
// intent + overrides. Explicit overrides win over the intent's values.
function applySavedOverrides(saved) {
    const intent = saved.intent || {};
    const ov = saved.overrides || {};
    const pick = (k) => (k in ov ? ov[k] : intent[k]);

    if (typeof pick('country') === 'string' && $('filter-country')) {
        $('filter-country').value = pick('country');
    }
    if (Number.isInteger(pick('daysAgo'))) $('filter-daysAgo').value = String(pick('daysAgo'));
    if (typeof pick('seniority') === 'string' && $('filter-seniority')) {
        $('filter-seniority').value = pick('seniority');
    }
    const yoeSel = yoeSelectFromRange(pick('minYearsOfExperience'), pick('maxYearsOfExperience'));
    if (yoeSel && $('filter-yoe')) $('filter-yoe').value = yoeSel;
    if (Number.isInteger(pick('salaryMinimumUsd'))) $('filter-salary').value = String(pick('salaryMinimumUsd'));

    const setChecks = (name, values) => {
        if (!Array.isArray(values)) return;
        const set = new Set(values);
        for (const cb of document.querySelectorAll(`input[name="${name}"]`)) {
            cb.checked = set.has(cb.value);
        }
    };
    setChecks('employmentTypes', pick('employmentTypes'));
    setChecks('workModels', pick('workModels'));
    setChecks('companyStages', pick('companyStages'));

    // Tri-state: undefined → keep the default set by resetFilterInputs;
    // explicit true/false → honour the saved choice exactly.
    const setBool = (key, id) => {
        const v = pick(key);
        if (v === true || v === false) $(id).checked = v;
    };
    setBool('excludeStaffingAgency', 'filter-excludeStaffing');
    setBool('excludeSecurityClearance', 'filter-excludeClearance');
    setBool('excludeUsCitizenOnly', 'filter-excludeCitizen');

    const remarks = pick('remarks');
    if (typeof remarks === 'string' && $('filter-remarks')) {
        $('filter-remarks').value = remarks;
        updateRemarksCount();
    }

    // Open the panel so operators see what was loaded.
    const details = document.querySelector('.advanced-filters-details');
    if (details) details.open = true;
}

function renderProfile() {
    const heading = $('profile-heading');
    const buildBtn = $('build-summary');
    const scrapeBtn = $('start-scrape');
    const prefs = $('profile-preferences');
    const prefsList = $('profile-preferences-list');
    const exclEditor = $('profile-exclusions-editor');
    const raw = $('profile-raw');
    const rawJson = $('profile-raw-json');

    if (!state.selectedEmail) {
        heading.textContent = 'Select a client';
        buildBtn.disabled = true;
        scrapeBtn.disabled = true;
        prefs.hidden = exclEditor.hidden = raw.hidden = true;
        const about = $('about-candidate-section');
        if (about) about.hidden = true;
        return;
    }

    const who = state.clients.find((c) => c.email === state.selectedEmail);
    heading.textContent = who?.name ? `${who.name} · ${who.email}` : state.selectedEmail;

    if (!state.profile) {
        buildBtn.disabled = true;
        scrapeBtn.disabled = true;
        prefs.hidden = exclEditor.hidden = raw.hidden = true;
        return;
    }

    buildBtn.disabled = false;
    scrapeBtn.disabled = Boolean(state.run && !TERMINAL_PHASES.has(state.run.phase));

    prefs.hidden = false;
    const p = state.profile;
    const rows = [
        ['Roles', chipsFromList(p.preferredRoles)],
        ['Locations', chipsFromList(p.preferredLocations)],
        ['Target companies', chipsFromList(p.targetCompanies)],
        ['Experience level', p.experienceLevel],
        ['Expected salary', p.expectedSalaryRange],
        ['Visa', [p.visaStatus, p.otherVisaType].filter(Boolean).join(' / ')],
        ['Work eligibility', p.usWorkEligibility],
        ['Join time', p.joinTime],
    ].filter((r) => hasContent(r[1]));
    prefsList.innerHTML = '';
    for (const [label, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        if (value instanceof Node) {
            dd.classList.add('chips');
            dd.appendChild(value);
        } else {
            dd.textContent = value;
        }
        prefsList.append(dt, dd);
    }

    // Editable exclusions panel.
    exclEditor.hidden = false;
    state.exclCompaniesDraft = [...(state.exclusions?.excludedCompanies || [])];
    state.exclLocationsDraft = [...(state.exclusions?.excludedLocations || [])];
    state.exclBaseline = {
        companies: [...state.exclCompaniesDraft],
        locations: [...state.exclLocationsDraft],
    };
    renderExclusionsEditor();

    // About-this-candidate — seeded from saved intent if we have one.
    const aboutSection = $('about-candidate-section');
    if (aboutSection) aboutSection.hidden = false;
    const savedAbout = state.summary?.intent?.aboutCandidate
        || state.savedRecord?.intent?.aboutCandidate
        || '';
    state.aboutBaseline = savedAbout;
    state.aboutDraft = savedAbout;
    renderAboutCandidate();

    raw.hidden = false;
    rawJson.textContent = JSON.stringify(state.profile, null, 2);
}

function hasContent(v) {
    if (v instanceof Node) return true;
    if (typeof v === 'string') return v.trim().length > 0;
    return Boolean(v);
}
function chipsFromList(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    const frag = document.createDocumentFragment();
    for (const item of list) {
        const span = document.createElement('span');
        span.className = 'chip';
        span.textContent = String(item);
        frag.appendChild(span);
    }
    return frag;
}
// --- editable exclusions (synced with dashboard) ------------------------

// renderExclusionsEditor: paint the two chip columns from draft state.
// Save button enabled only when drafts differ from baseline.
function renderExclusionsEditor() {
    const coList = $('excl-companies-list');
    const loList = $('excl-locations-list');
    if (!coList || !loList) return;
    paintChips(coList, state.exclCompaniesDraft || [], 'companies');
    paintChips(loList, state.exclLocationsDraft || [], 'locations');

    const dirty = !arrayEq(state.exclCompaniesDraft, state.exclBaseline?.companies)
        || !arrayEq(state.exclLocationsDraft, state.exclBaseline?.locations);
    const saveBtn = $('excl-save');
    const resetBtn = $('excl-reset');
    if (saveBtn) saveBtn.disabled = !dirty;
    if (resetBtn) resetBtn.disabled = !dirty;
}

function paintChips(ul, items, kind) {
    ul.innerHTML = '';
    for (const item of items) {
        const li = document.createElement('li');
        li.className = 'chip';
        const label = document.createElement('span');
        label.textContent = item;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.title = 'remove';
        x.addEventListener('click', () => removeExclusionChip(kind, item));
        li.append(label, x);
        ul.appendChild(li);
    }
}

function arrayEq(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    for (let i = 0; i < sa.length; i += 1) if (sa[i] !== sb[i]) return false;
    return true;
}

function addExclusionChip(kind) {
    const input = $(kind === 'companies' ? 'excl-company-input' : 'excl-location-input');
    if (!input) return;
    const raw = (input.value || '').trim();
    if (!raw) return;
    const draft = kind === 'companies' ? state.exclCompaniesDraft : state.exclLocationsDraft;
    const exists = draft.some((v) => v.toLowerCase() === raw.toLowerCase());
    if (!exists) draft.push(raw);
    input.value = '';
    renderExclusionsEditor();
}

function removeExclusionChip(kind, value) {
    const key = kind === 'companies' ? 'exclCompaniesDraft' : 'exclLocationsDraft';
    state[key] = state[key].filter((v) => v !== value);
    renderExclusionsEditor();
}

function resetExclusions() {
    if (!state.exclBaseline) return;
    state.exclCompaniesDraft = [...state.exclBaseline.companies];
    state.exclLocationsDraft = [...state.exclBaseline.locations];
    renderExclusionsEditor();
    setStatus('excl-status', 'reverted');
}

async function saveExclusions() {
    if (!state.selectedEmail) return;
    const btn = $('excl-save');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Saving…';
    setStatus('excl-status', 'syncing to dashboard…');
    try {
        const res = await fetch(
            `${API}/clients/${encodeURIComponent(state.selectedEmail)}/exclusions`,
            {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    companies: state.exclCompaniesDraft,
                    locations: state.exclLocationsDraft,
                }),
            },
        );
        const body = await res.json();
        if (!body.success) {
            setStatus('excl-status', `save failed: ${body.message || body.error}`, { error: true });
            return;
        }
        state.exclusions = {
            excludedCompanies: body.excludedCompanies || [],
            excludedLocations: body.excludedLocations || [],
        };
        state.exclCompaniesDraft = [...state.exclusions.excludedCompanies];
        state.exclLocationsDraft = [...state.exclusions.excludedLocations];
        state.exclBaseline = {
            companies: [...state.exclCompaniesDraft],
            locations: [...state.exclLocationsDraft],
        };
        renderExclusionsEditor();
        setStatus('excl-status', 'saved ✓');
    } catch (err) {
        setStatus('excl-status', `save failed: ${err.message}`, { error: true });
    } finally {
        btn.textContent = orig;
    }
}

// --- /api/clients/:email/summary ---------------------------------------

async function buildSummary() {
    if (!state.selectedEmail) return;
    const btn = $('build-summary');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Summarising…';
    setStatus('console-status', 'calling gpt-4o-mini…');
    try {
        const res = await fetch(
            `${API}/clients/${encodeURIComponent(state.selectedEmail)}/summary`,
            { method: 'POST' },
        );
        const body = await res.json();
        if (!body.success) {
            const msg = body.error === 'RESUME_MISSING'
                ? `⚠ ${body.message}`
                : `summary failed: ${body.message || body.error}`;
            setStatus('console-status', msg, { error: true });
            return;
        }
        state.summary = {
            intent: body.intent,
            cacheHit: body.cacheHit,
            resumeFound: body.resumeFound,
        };
        // Auto-fill the "About this candidate" textarea from the fresh AI
        // output whenever the operator hasn't already tuned + saved it.
        // If a saved record exists and differs, leave operator edits alone.
        const aiAbout = body.intent?.aboutCandidate || '';
        if (aiAbout && !state.aboutBaseline) {
            state.aboutDraft = aiAbout;
            state.aboutBaseline = aiAbout;
        } else if (aiAbout && state.aboutBaseline === state.aboutDraft) {
            // Operator hasn't edited since last load → refresh with AI's latest draft.
            state.aboutDraft = aiAbout;
            state.aboutBaseline = aiAbout;
        }
        renderAboutCandidate();
        renderSummary();
        setStatus('console-status', body.cacheHit ? 'cached — $0 replay' : 'fresh summary computed');
        // Auto-persist the freshly-built intent so subsequent sessions see
        // it pre-populated. Saves to Mongo (scraper_client_filters) when
        // MONGO_URI is set, else to runs/client-filters/*.json. Fire-and-
        // forget — UI doesn't block on the save round-trip; failures only
        // log to console.
        persistIntentSilently(state.selectedEmail, body.intent);
    } catch (err) {
        setStatus('console-status', `error: ${err.message}`, { error: true });
    } finally {
        btn.disabled = false;
        btn.textContent = orig;
    }
}

// persistIntentSilently: best-effort write of the AI-built intent +
// current Advanced-Filter overrides to the server. Same endpoint as the
// "Save filters" button; calling it from buildSummary turns the summary
// build into the persistence trigger so operators don't have to remember
// to press Save afterwards. Only refreshes state.savedRecord on success
// so the SAVED-banner accurately reflects DB truth.
async function persistIntentSilently(email, intent) {
    if (!email || !intent) return;
    try {
        const overrides = collectFilterOverrides();
        const res = await fetch(
            `${API}/clients/${encodeURIComponent(email)}/filters`,
            {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    intent,
                    overrides: Object.keys(overrides).length ? overrides : null,
                }),
            },
        );
        const body = await res.json();
        if (body.success && body.record && state.selectedEmail === email) {
            state.savedRecord = body.record;
            renderSummaryBanner();
            renderFilterActions();
        }
    } catch (e) {
        console.warn('persistIntentSilently failed:', e.message);
    }
}

function renderSummary() {
    const section = $('intent-section');
    const json = $('summary-json');
    const meta = $('summary-meta');
    renderSummaryBanner();
    renderFilterActions();
    if (!state.summary) {
        section.hidden = true;
        return;
    }
    section.hidden = false;
    json.textContent = JSON.stringify(state.summary.intent, null, 2);
    const parts = [
        state.summary.cacheHit ? 'cache hit' : 'freshly computed',
        state.summary.resumeFound ? 'resume enriched' : 'no resume',
    ];
    meta.textContent = parts.join(' · ');
}

// renderSummaryBanner: big, obvious "summary not built yet" warning so
// operators never wonder why Scrape would need 6+ seconds on first run.
function renderSummaryBanner() {
    const banner = $('summary-banner');
    if (!banner) return;
    if (!state.selectedEmail) {
        banner.hidden = true;
        return;
    }
    if (!state.summary) {
        banner.hidden = false;
        banner.classList.remove('ready');
        banner.innerHTML =
            '<span>⚠</span><span><strong>Summary not built for this client yet.</strong> Click <strong>Build Summary</strong> to compile their profile + resume into a SearchIntent, or click <strong>Scrape</strong> and it will be computed automatically.</span>';
        return;
    }
    banner.hidden = false;
    banner.classList.add('ready');
    const savedAt = state.savedRecord?.meta?.savedAt;
    const age = savedAt ? new Date(savedAt).toLocaleString() : 'just now';
    banner.innerHTML = `<span>✓</span><span><strong>Summary ready.</strong> Last saved ${age}.</span>`;
}

// renderFilterActions: enable/disable Save + Clear buttons based on state.
function renderFilterActions() {
    const saveBtn = $('save-filters');
    const clearBtn = $('clear-filters');
    if (!saveBtn || !clearBtn) return;
    saveBtn.disabled = !state.selectedEmail;
    clearBtn.disabled = !state.selectedEmail || !state.savedRecord;
    const indicator = $('filters-saved-indicator');
    if (indicator) {
        if (state.savedRecord?.meta?.savedAt) {
            indicator.textContent = `saved ${new Date(state.savedRecord.meta.savedAt).toLocaleString()}`;
        } else {
            indicator.textContent = state.selectedEmail ? 'not saved yet' : '';
        }
    }
}

// saveFiltersForCurrentClient: PUT current Advanced Filters + intent to
// the server so the next session pre-populates. No scrape is triggered.
async function saveFiltersForCurrentClient() {
    if (!state.selectedEmail) return;
    const saveBtn = $('save-filters');
    saveBtn.disabled = true;
    const orig = saveBtn.textContent;
    saveBtn.textContent = 'Saving…';
    try {
        const overrides = collectFilterOverrides();
        const res = await fetch(
            `${API}/clients/${encodeURIComponent(state.selectedEmail)}/filters`,
            {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    intent: state.summary?.intent || null,
                    overrides: Object.keys(overrides).length ? overrides : null,
                }),
            },
        );
        const body = await res.json();
        if (!body.success) {
            setStatus('profile-status', `save failed: ${body.message || body.error}`, { error: true });
            return;
        }
        state.savedRecord = body.record;
        renderSummaryBanner();
        renderFilterActions();
        setStatus('profile-status', 'filters saved');
    } catch (err) {
        setStatus('profile-status', `save failed: ${err.message}`, { error: true });
    } finally {
        saveBtn.textContent = orig;
        saveBtn.disabled = !state.selectedEmail;
    }
}

// clearSavedFiltersForCurrentClient: DELETE the stored record. Doesn't
// wipe the UI panel state — operator can re-save later.
async function clearSavedFiltersForCurrentClient() {
    if (!state.selectedEmail || !state.savedRecord) return;
    const btn = $('clear-filters');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Clearing…';
    try {
        await fetch(
            `${API}/clients/${encodeURIComponent(state.selectedEmail)}/filters`,
            { method: 'DELETE' },
        );
        state.savedRecord = null;
        renderSummaryBanner();
        renderFilterActions();
        setStatus('profile-status', 'saved filters cleared');
    } catch (err) {
        setStatus('profile-status', `clear failed: ${err.message}`, { error: true });
    } finally {
        btn.textContent = orig;
    }
}

// --- advanced-filter overrides -----------------------------------------

// collectFilterOverrides: scrape the Advanced Filters panel state into a
// partial SearchIntent that will merge onto the AI-derived intent. Empty
// / unchecked fields are omitted so the AI's choice is preserved for
// anything the operator didn't explicitly set.
function collectFilterOverrides() {
    const out = {};
    const country = $('filter-country')?.value || '';
    if (country) out.country = country;
    const daysAgo = Number.parseInt($('filter-daysAgo').value, 10);
    if (Number.isInteger(daysAgo)) out.daysAgo = daysAgo;
    const seniority = $('filter-seniority')?.value || '';
    if (seniority) out.seniority = seniority;
    const yoe = yoeRangeFromSelect($('filter-yoe')?.value || '');
    if (yoe) {
        out.minYearsOfExperience = yoe.min;
        out.maxYearsOfExperience = yoe.max;
    }
    const salary = Number.parseInt($('filter-salary').value, 10);
    if (Number.isInteger(salary)) out.salaryMinimumUsd = salary;
    const grab = (name) =>
        [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => el.value);
    const et = grab('employmentTypes'); if (et.length) out.employmentTypes = et;
    const wm = grab('workModels'); if (wm.length) out.workModels = wm;
    const cs = grab('companyStages'); if (cs.length) out.companyStages = cs;
    // Always write the boolean (true OR false) so the saved record
    // round-trips correctly. Without the explicit `false`, an operator
    // unchecking the box and saving would lose the choice on next load
    // (the default-ON applied by resetFilterInputs would re-check it).
    out.excludeStaffingAgency = $('filter-excludeStaffing').checked;
    out.excludeSecurityClearance = $('filter-excludeClearance').checked;
    out.excludeUsCitizenOnly = $('filter-excludeCitizen').checked;
    const remarks = ($('filter-remarks')?.value || '').trim();
    if (remarks) out.remarks = remarks.slice(0, 1000);
    return out;
}

// buildOverrideIntent: fold overrides onto a pre-built AI summary if we
// have one. When no summary exists, send overrides alone via
// `overrideFields` so the backend can merge them onto its fresh summariser
// output (see backend change below).
function buildOverrideIntent() {
    const overrides = collectFilterOverrides();
    const base = state.summary?.intent;
    if (!base && Object.keys(overrides).length === 0) return null;
    if (!base) return null;
    return { ...base, ...overrides };
}

// --- run lifecycle -------------------------------------------------------

async function startScrape() {
    if (!state.selectedEmail) return;
    const countEl = $('scrape-count');
    const count = Number.parseInt(countEl.value, 10);
    if (!Number.isInteger(count) || count < 1 || count > 50) {
        setStatus('console-status', 'invalid count (1–50)', { error: true });
        return;
    }

    closeEventSource();
    state.run = null;
    renderRun();

    const scrapeBtn = $('start-scrape');
    scrapeBtn.disabled = true;
    setStatus('console-status', 'starting run…');

    try {
        const who = state.clients.find((c) => c.email === state.selectedEmail);
        const overrideIntent = buildOverrideIntent();
        const overrideFields = state.summary?.intent ? null : collectFilterOverrides();
        const res = await fetch(`${API}/runs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                clientEmail: state.selectedEmail,
                clientName: who?.name || '',
                count,
                // overrideIntent: full intent (only set when operator built
                // the summary first + we folded overrides onto it).
                // overrideFields: partial overrides — backend merges onto
                // the summariser's fresh output. Use this path when the
                // summary isn't prebuilt.
                overrideIntent,
                overrideFields,
            }),
        });
        const body = await res.json();
        if (!body.success || !body.run?.id) {
            setStatus('console-status', `start failed: ${body.message || body.error}`, { error: true });
            scrapeBtn.disabled = false;
            return;
        }
        state.run = body.run;
        renderRun();
        subscribeToRun(body.run.id);
    } catch (err) {
        setStatus('console-status', `error: ${err.message}`, { error: true });
        scrapeBtn.disabled = false;
    }
}

function subscribeToRun(runId) {
    const es = new EventSource(`${API}/runs/${encodeURIComponent(runId)}/events`);
    state.eventSource = es;
    es.addEventListener('state', (ev) => {
        try {
            state.run = JSON.parse(ev.data);
            renderRun();
            if (TERMINAL_PHASES.has(state.run.phase)) {
                closeEventSource();
                onRunTerminal();
            }
        } catch (err) {
            console.error('bad SSE payload', err);
        }
    });
    es.onerror = () => {
        // EventSource auto-reconnects, but once the run is terminal the
        // server ends the stream and we get an error. Treat as "done".
        if (state.run && TERMINAL_PHASES.has(state.run.phase)) {
            closeEventSource();
            return;
        }
        setStatus('console-status', 'sse disconnected, retrying…', { error: true });
    };
}

function closeEventSource() {
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }
}

async function abortRun() {
    if (!state.run) return;
    const btn = $('abort-run');
    btn.disabled = true;
    btn.textContent = 'Aborting…';
    try {
        // If the run is parked at awaiting-relaxation, /abort sets the
        // flag but the pipeline poll only re-checks every 500ms. Also
        // post a `decline` to /expand so the relaxation poll exits even
        // if the abort flag race-loses; both paths flip phase to terminal.
        const runId = state.run.id;
        if (state.run.phase === 'awaiting-relaxation') {
            try {
                await fetch(`${API}/runs/${encodeURIComponent(runId)}/expand`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accept: false }),
                });
            } catch { /* ignore — the abort POST below is the real exit */ }
        }
        await fetch(`${API}/runs/${encodeURIComponent(runId)}/abort`, { method: 'POST' });
    } finally {
        btn.disabled = false;
        btn.textContent = 'Abort';
    }
}

// clearRun: wipe the run-console UI without aborting the in-flight run.
// Useful when the operator wants to start a new run for another client
// while the previous one is still phasing through. The run keeps going
// in the background; subscription is dropped here. State machine on the
// server is unchanged.
function clearRun() {
    closeEventSource();
    state.run = null;
    state.picks = null;
    setStatus('console-status', '');
    setStatus('picks-status', '');
    renderRun();
    // Reset the client-side decisions panel + 0-jobs hint banner so the
    // console looks like a fresh page load.
    const dec = $('decisions-section');
    if (dec) dec.hidden = true;
    const hint = $('no-jobs-hint');
    if (hint) hint.hidden = true;
    const relax = $('relaxation-prompt');
    if (relax) relax.hidden = true;
}

function onRunTerminal() {
    $('start-scrape').disabled = false;
    const phase = state.run.phase;
    if (phase === 'done') {
        const n = state.run.progress?.pushed?.pushed ?? 0;
        const searched = state.run.progress?.searched?.totalNormalized ?? 0;
        if (n === 0 && searched === 0) {
            setStatus('console-status', 'done — 0 jobs (see banner above for why)', { error: true });
        } else if (n === 0) {
            setStatus(
                'console-status',
                `done — ${searched} jobs scanned but 0 pushed. All were skipped, blocked, or duplicates.`,
            );
        } else {
            setStatus('console-status', `done — ${n} pushed in ${fmtMs(state.run.durationMs)}`);
        }
    } else if (phase === 'failed') {
        const code = state.run.error?.code || '';
        const msg = state.run.error?.message || '';
        const display = code === 'RESUME_MISSING' && msg ? msg : `failed — ${code}`;
        setStatus('console-status', display, { error: true });
    } else if (phase === 'aborted') {
        setStatus('console-status', 'aborted');
    }
    loadPicks();
}

async function loadPicks() {
    if (!state.run) return;
    try {
        const res = await fetch(`${API}/runs/${encodeURIComponent(state.run.id)}`);
        const body = await res.json();
        if (!body.success) return;
        // Full run has .picks; summary SSE only had picksCount
        state.run = body.run;
        renderRun();
    } catch {
        /* ignore — display falls back to whatever SSE left us */
    }
}

function renderRun() {
    const emptySec = $('run-empty');
    const runSec = $('run-section');
    const abortBtn = $('abort-run');
    const resumeBtn = $('resume-run');
    const picksSec = $('picks-section');
    const decisionsSec = $('decisions-section');

    if (!state.run) {
        emptySec.hidden = false;
        runSec.hidden = true;
        picksSec.hidden = true;
        decisionsSec.hidden = true;
        abortBtn.hidden = true;
        resumeBtn.hidden = true;
        return;
    }

    emptySec.hidden = true;
    runSec.hidden = false;

    const r = state.run;
    const resumedPrefix = r.resumedFrom ? `↻ resumed · ` : '';
    $('run-heading').textContent = `Run · ${resumedPrefix}${r.phase}`;
    $('run-meta').textContent = [
        `id: ${r.id.slice(0, 8)}…`,
        `count: ${r.requestedCount}`,
        r.resumedFrom ? `resumed from: ${String(r.resumedFrom).slice(0, 8)}…` : '',
        `elapsed: ${fmtMs(r.durationMs || (Date.now() - Date.parse(r.createdAt)))}`,
        r.eventSeq != null ? `seq: ${r.eventSeq}` : '',
    ].filter(Boolean).join(' · ');

    // Abort button stays visible while the run is still alive — including
    // when paused for relaxation input.
    abortBtn.hidden = TERMINAL_PHASES.has(r.phase);
    resumeBtn.hidden = r.phase !== 'failed';

    renderTimeline(r);
    renderRunStats(r);
    renderError(r);
    renderNoJobsHint(r);
    renderRelaxationPrompt(r);

    // Picks only once we have the full run (after terminal).
    if (Array.isArray(r.picks) && r.picks.length > 0) {
        picksSec.hidden = false;
        renderPicks(r.picks);
    } else if (TERMINAL_PHASES.has(r.phase)) {
        picksSec.hidden = false;
        renderPicks([]);
    } else {
        picksSec.hidden = true;
    }

    renderDecisions(r);
}

// renderDecisions: the "why picked / why skipped" table. Lights up as soon
// as the filter phase starts emitting data.
function renderDecisions(r) {
    const sec = $('decisions-section');
    const decisions = Array.isArray(r.progress?.decisions) ? r.progress.decisions : [];
    if (decisions.length === 0) {
        sec.hidden = true;
        return;
    }
    sec.hidden = false;

    const picked = decisions.filter((d) => d.pick).length;
    const skipped = decisions.length - picked;
    $('decisions-count').textContent = `(${picked} picked / ${skipped} skipped)`;

    const tbody = $('decisions-table').querySelector('tbody');
    const toggle = $('decisions-toggle');
    if (!toggle.checked) {
        tbody.innerHTML = '';
        return;
    }

    const filtered = decisions.filter((d) => {
        if (state.decisionsFilter === 'pick') return d.pick === true;
        if (state.decisionsFilter === 'skip') return d.pick !== true;
        return true;
    });

    // Sort: picks first (desc score), then skipped (desc score).
    filtered.sort((a, b) => {
        if (a.pick !== b.pick) return a.pick ? -1 : 1;
        return (b.score || 0) - (a.score || 0);
    });

    tbody.innerHTML = '';
    for (const d of filtered) {
        const tr = document.createElement('tr');
        const kind = d.pick ? 'pick' : d.score >= 55 ? 'borderline' : 'skip';
        tr.className = `row-${kind}`;
        const v = document.createElement('td');
        v.className = 'verdict';
        v.textContent = d.pick ? 'PICK' : kind === 'borderline' ? 'BORDER' : 'SKIP';
        const s = document.createElement('td');
        s.className = 'score';
        s.textContent = String(d.score ?? 0);
        const t = document.createElement('td');
        t.textContent = d.title || '';
        const c = document.createElement('td');
        c.textContent = d.company || '';
        const reason = document.createElement('td');
        reason.className = 'reason';
        reason.textContent = d.reason || '';
        const fb = document.createElement('td');
        fb.appendChild(buildFeedbackButtons({
            jobId: d.jobId,
            title: d.title,
            company: d.company,
            aiPick: d.pick,
            aiScore: d.score,
            aiReason: d.reason,
        }));
        tr.append(v, s, t, c, reason, fb);
        tbody.appendChild(tr);
    }
}

// ---- About this candidate (operator-editable frame) -------------------

function renderAboutCandidate() {
    const ta = $('about-candidate');
    const meta = $('about-candidate-meta');
    const saveBtn = $('about-save');
    const revertBtn = $('about-revert');
    const count = $('about-char-count');
    if (!ta) return;
    if (ta.value !== state.aboutDraft) ta.value = state.aboutDraft || '';
    if (count) count.textContent = `${(state.aboutDraft || '').length} / 2000`;
    const dirty = (state.aboutDraft || '') !== (state.aboutBaseline || '');
    if (saveBtn) saveBtn.disabled = !state.selectedEmail || !dirty;
    if (revertBtn) revertBtn.disabled = !dirty;
    if (meta) {
        if (state.aboutBaseline) {
            meta.textContent = dirty ? '· edited, not saved' : '· saved';
        } else {
            meta.textContent = '· not generated yet — click Build Summary';
        }
    }
}

async function saveAboutCandidate() {
    if (!state.selectedEmail) return;
    const btn = $('about-save');
    if (btn) btn.disabled = true;
    setStatus('about-status', 'saving…');
    try {
        // The saved-filter record is the source of truth for the intent
        // used on next scrape. Update its `aboutCandidate` in place.
        // If no record exists yet, seed one from the current summary.
        const baseIntent = state.savedRecord?.intent
            || state.summary?.intent
            || null;
        if (!baseIntent) {
            setStatus('about-status', 'cannot save: click Build Summary first', { error: true });
            renderAboutCandidate();
            return;
        }
        const nextIntent = { ...baseIntent, aboutCandidate: state.aboutDraft };
        const res = await fetch(
            `${API}/clients/${encodeURIComponent(state.selectedEmail)}/filters`,
            {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    intent: nextIntent,
                    overrides: state.savedRecord?.overrides || null,
                }),
            },
        );
        const body = await res.json();
        if (!body.success) {
            setStatus('about-status', `save failed: ${body.message || body.error}`, { error: true });
            return;
        }
        state.savedRecord = body.record;
        state.aboutBaseline = state.aboutDraft;
        // Also update the in-memory summary intent so next scrape uses it
        // even if saved-record isn't re-read.
        if (state.summary?.intent) state.summary.intent.aboutCandidate = state.aboutDraft;
        renderAboutCandidate();
        renderSummaryBanner();
        renderFilterActions();
        setStatus('about-status', 'saved ✓ — next scrape will use this');
    } catch (err) {
        setStatus('about-status', `save error: ${err.message}`, { error: true });
    } finally {
        renderAboutCandidate();
    }
}

function revertAboutCandidate() {
    state.aboutDraft = state.aboutBaseline || '';
    renderAboutCandidate();
    setStatus('about-status', 'reverted');
}

// ---- Feedback loop (Phase 2) -------------------------------------------

// loadFeedback: pull every saved event for the selected client, build a
// jobId→latest-entry index so buttons can highlight state.
async function loadFeedback(email) {
    state.feedbackByJob = {};
    if (!email) return;
    try {
        const res = await fetch(`${API}/clients/${encodeURIComponent(email)}/feedback`);
        const body = await res.json();
        if (!body.success) return;
        const map = {};
        for (const e of body.entries || []) {
            // Latest entry per jobId wins (entries are appended in order).
            if (e.jobId) map[e.jobId] = { verdict: e.verdict, entryId: e.id };
        }
        state.feedbackByJob = map;
    } catch {
        /* ignore — feedback is advisory */
    }
}

// buildFeedbackButtons: render two calibrate buttons for one row. `decision`
// describes what the AI said so we can map (AI verdict × operator click) to
// one of the four feedback verdicts.
// decision: { jobId, title, company, aiPick, aiScore, aiReason }
function buildFeedbackButtons(decision) {
    const wrap = document.createElement('div');
    wrap.style.whiteSpace = 'nowrap';
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'fb-btn fb-up';
    up.textContent = '👍';
    up.title = decision.aiPick
        ? 'Confirm pick (good_pick)'
        : 'Rescue: this should have been picked (good_skip)';
    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'fb-btn fb-down';
    down.textContent = '👎';
    down.title = decision.aiPick
        ? 'Reject: AI picked a bad one (bad_pick)'
        : 'Confirm skip (bad_skip)';

    const existing = state.feedbackByJob[decision.jobId];
    if (existing) {
        if (existing.verdict === 'good_pick' || existing.verdict === 'good_skip') {
            up.classList.add('active-up');
        }
        if (existing.verdict === 'bad_pick' || existing.verdict === 'bad_skip') {
            down.classList.add('active-down');
        }
    }

    up.addEventListener('click', () => {
        const verdict = decision.aiPick ? 'good_pick' : 'good_skip';
        submitFeedback(decision, verdict);
    });
    down.addEventListener('click', () => {
        const verdict = decision.aiPick ? 'bad_pick' : 'bad_skip';
        submitFeedback(decision, verdict);
    });

    wrap.append(up, down);
    return wrap;
}

async function submitFeedback(decision, verdict) {
    if (!state.selectedEmail) return;
    setStatus('feedback-status', 'saving feedback…');
    try {
        const res = await fetch(
            `${API}/clients/${encodeURIComponent(state.selectedEmail)}/feedback`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    jobId: decision.jobId,
                    title: decision.title || '',
                    company: decision.company || '',
                    verdict,
                    aiPick: !!decision.aiPick,
                    aiScore: Number.isInteger(decision.aiScore) ? decision.aiScore : 0,
                    aiReason: decision.aiReason || '',
                    sourceRunId: state.run?.id || '',
                }),
            },
        );
        const body = await res.json();
        if (!body.success) {
            setStatus('feedback-status', `feedback failed: ${body.message || body.error}`, { error: true });
            return;
        }
        state.feedbackByJob[decision.jobId] = {
            verdict: body.entry.verdict,
            entryId: body.entry.id,
        };
        setStatus('feedback-status', `saved — ${verdict} (AI will use this next scrape)`);
        // Repaint so button highlight follows state.
        if (state.run) renderRun();
    } catch (e) {
        setStatus('feedback-status', `feedback error: ${e.message}`, { error: true });
    }
}

async function resumeRun() {
    if (!state.run || state.run.phase !== 'failed') return;
    const btn = $('resume-run');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Resuming…';
    setStatus('console-status', 'resuming run…');
    try {
        const res = await fetch(`${API}/runs/${encodeURIComponent(state.run.id)}/resume`, {
            method: 'POST',
        });
        const body = await res.json();
        if (!body.success || !body.run?.id) {
            setStatus('console-status', `resume failed: ${body.message || body.error}`, { error: true });
            return;
        }
        closeEventSource();
        state.run = body.run;
        renderRun();
        subscribeToRun(body.run.id);
    } catch (err) {
        setStatus('console-status', `resume error: ${err.message}`, { error: true });
    } finally {
        btn.disabled = false;
        btn.textContent = orig;
    }
}

function renderTimeline(r) {
    const list = $('run-timeline');
    list.innerHTML = '';
    // While paused on relaxation, highlight the LAST completed phase
    // (pushing) instead of leaving the timeline blank.
    const effectivePhase = r.phase === 'awaiting-relaxation' ? 'pushing' : r.phase;
    const currentIdx = PHASE_SEQUENCE.findIndex((p) => p.key === effectivePhase);
    const terminal = TERMINAL_PHASES.has(r.phase);
    for (let i = 0; i < PHASE_SEQUENCE.length; i += 1) {
        const phase = PHASE_SEQUENCE[i];
        const li = document.createElement('li');
        li.textContent = phase.label;

        let status;
        if (!terminal && currentIdx === i) status = 'active';
        else if (currentIdx > i || terminal) status = 'done';
        else status = '';
        if (status) li.classList.add(status);

        // Per-phase sub-line when we have progress data.
        const sub = phaseSubline(phase.key, r.progress);
        if (sub) {
            const span = document.createElement('span');
            span.className = 'sub';
            span.textContent = sub;
            li.appendChild(span);
        }
        list.appendChild(li);
    }
    // Terminal marker row
    if (terminal) {
        const li = document.createElement('li');
        li.textContent = r.phase === 'done' ? 'Done' : r.phase === 'failed' ? 'Failed' : 'Aborted';
        li.classList.add(r.phase);
        list.appendChild(li);
    }
}

function phaseSubline(key, progress) {
    if (!progress) return '';
    if (key === 'summarising' && progress.intent) {
        const roles = progress.intent.roles || [];
        return `intent: ${roles.slice(0, 3).join(', ') || '—'}`;
    }
    if (key === 'searching' && progress.searched) {
        const s = progress.searched;
        const liSkip = s.linkedInSkipped ? `, ${s.linkedInSkipped} LinkedIn skipped` : '';
        return `${s.totalNormalized} jobs${liSkip} (${fmtMs(s.durationMs)})`;
    }
    if (key === 'filtering' && progress.filtered) {
        const f = progress.filtered;
        return `${f.picked} picked, ${f.skipped} skipped, ${f.borderline} borderline (${fmtMs(f.durationMs)})`;
    }
    if (key === 'enriching' && progress.enriched) {
        const e = progress.enriched;
        return `ready ${e.ready}, sparse ${e.sparse}`;
    }
    if (key === 'preflight' && progress.preflight) {
        const p = progress.preflight;
        return `pushable ${p.pushable}, blocked-co ${p.blockedCompany}, blocked-loc ${p.blockedLocation}, dup ${p.localDuplicate}`;
    }
    if (key === 'pushing' && progress.pushed) {
        const p = progress.pushed;
        return `pushed ${p.pushed}, dup ${p.duplicates}, blocked ${p.blocked}, err ${p.errors} (${fmtMs(p.durationMs)})`;
    }
    return '';
}

function renderRunStats(r) {
    const el = $('run-stats');
    if (!r.progress?.pushed) {
        el.hidden = true;
        return;
    }
    const p = r.progress.pushed;
    const cost = r.progress.cost;
    el.hidden = false;
    let costRows = '';
    if (cost && (cost.totalTokens > 0 || cost.calls > 0)) {
        const usd = cost.usd < 0.01 ? `$${cost.usd.toFixed(4)}` : `$${cost.usd.toFixed(4)}`;
        costRows = `
            <dt>AI cost</dt><dd>${usd} (${cost.model || 'gpt-4o-mini'})</dd>
            <dt>AI calls</dt><dd>${cost.calls} · ${cost.cacheHits} cached · ${cost.totalTokens.toLocaleString()} tokens</dd>
        `;
    }
    el.innerHTML = `
        <dt>Pushed</dt><dd>${p.pushed}</dd>
        <dt>Duplicates</dt><dd>${p.duplicates}</dd>
        <dt>Blocked</dt><dd>${p.blocked}</dd>
        <dt>Errors</dt><dd>${p.errors}</dd>
        ${costRows}
    `;
}

// renderNoJobsHint: inline warning when JR returned 0 jobs. Identifies
// which filters are most likely to have tightened the result to nothing
// and nudges the operator toward the specific field to relax.
function renderNoJobsHint(r) {
    const el = $('no-jobs-hint');
    if (!el) return;
    const terminal = TERMINAL_PHASES.has(r.phase);
    const searched = r.progress?.searched?.totalNormalized ?? 0;
    // Only show on a completed run where JR itself returned nothing. If JR
    // returned jobs but nothing pushed, that's a different problem (all
    // skipped/dupe) which renderRun's status line already covers.
    if (!terminal || r.phase !== 'done' || searched > 0) {
        el.hidden = true;
        return;
    }

    const intent = r.progress?.intent || {};
    const culprits = [];
    if (Number.isInteger(intent.daysAgo) && intent.daysAgo <= 3) {
        culprits.push(`<li><strong>Date posted</strong> = past ${intent.daysAgo}d — widen to <code>past week</code> or <code>past month</code></li>`);
    }
    if (Array.isArray(intent.workModels) && intent.workModels.length === 1) {
        culprits.push(`<li><strong>Work model</strong> = ${intent.workModels[0]} only — try unchecking or adding a second model</li>`);
    }
    if (Number.isInteger(intent.minYearsOfExperience) && Number.isInteger(intent.maxYearsOfExperience)) {
        const span = intent.maxYearsOfExperience - intent.minYearsOfExperience;
        if (span <= 3) {
            culprits.push(`<li><strong>YoE</strong> = ${intent.minYearsOfExperience}–${intent.maxYearsOfExperience} — narrow range; try the next wider bucket</li>`);
        }
    }
    if (Number.isInteger(intent.salaryMinimumUsd) && intent.salaryMinimumUsd >= 150000) {
        culprits.push(`<li><strong>Min salary</strong> = $${intent.salaryMinimumUsd.toLocaleString()} — try a lower floor; many postings omit salary</li>`);
    }
    if (Array.isArray(intent.locations) && intent.locations.length > 0 && intent.locations.length <= 4) {
        culprits.push(`<li><strong>Locations</strong> limited to ${intent.locations.length} cities — add Remote, or clear locations for nationwide</li>`);
    }
    if (intent.seniority && (intent.seniority === 'intern' || intent.seniority === 'exec')) {
        culprits.push(`<li><strong>Seniority</strong> = ${intent.seniority} — very narrow; try <code>mid</code> or <code>senior</code></li>`);
    }

    el.hidden = false;
    const bullets = culprits.length
        ? `<strong>Most likely culprits:</strong><ul>${culprits.join('')}</ul>`
        : `<strong>Filters look reasonable individually — the combination just has no matching postings today.</strong> Try loosening the most restrictive one or changing the role.`;
    el.innerHTML = `
        ⚠ <strong>JR returned 0 jobs for this filter.</strong>
        <div style="margin-top:4px">The entire combination of filters + role produced no matches on JobRight. This isn't a bug — filters AND together and one tight one can zero the result.</div>
        <div style="margin-top:8px">${bullets}</div>
        <div style="margin-top:6px" class="muted">Full filter payload: <code>GET /api/runs/${r.id}/log</code></div>
    `;
}

// renderRelaxationPrompt: pipeline now auto-relaxes (no operator pause),
// so this banner becomes a passive read-out of which filters got widened
// during the run. Shows up while pagination is still running AND in the
// final state so the operator can see "we asked for 4, here's what we
// changed to get them".
function renderRelaxationPrompt(r) {
    const el = $('relaxation-prompt');
    if (!el) return;
    const applied = Array.isArray(r.progress?.appliedRelaxations)
        ? r.progress.appliedRelaxations
        : [];
    if (applied.length === 0) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    const list = applied
        .map((a) => `<li><strong>${a.label}</strong>: <code>${a.from}</code> → <code>${a.to}</code></li>`)
        .join('');
    el.innerHTML = `
        <div><strong>🔧 Auto-changed filters</strong>
        <span class="muted">— pipeline widened these to hit the target count.</span></div>
        <ul style="margin:6px 0 0 18px;padding:0">${list}</ul>
    `;
}

async function submitRelaxation(accept) {
    if (!state.run) return;
    const acceptBtn = $('relaxation-accept');
    const declineBtn = $('relaxation-decline');
    if (acceptBtn) acceptBtn.disabled = true;
    if (declineBtn) declineBtn.disabled = true;

    let planIndex = 0;
    const checked = document.querySelector('input[name="relaxation-choice"]:checked');
    if (checked) planIndex = Number.parseInt(checked.value, 10) || 0;

    setStatus('console-status', accept ? 'widening + continuing…' : 'declining…');
    try {
        const res = await fetch(`${API}/runs/${encodeURIComponent(state.run.id)}/expand`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ accept, planIndex }),
        });
        const body = await res.json();
        if (!body.success) {
            setStatus('console-status', `expand failed: ${body.message || body.error}`, { error: true });
            if (acceptBtn) acceptBtn.disabled = false;
            if (declineBtn) declineBtn.disabled = false;
            return;
        }
        // SSE is still open — pipeline will flip phase back to SEARCHING
        // within ~500ms and updates will flow again automatically.
    } catch (err) {
        setStatus('console-status', `expand error: ${err.message}`, { error: true });
        if (acceptBtn) acceptBtn.disabled = false;
        if (declineBtn) declineBtn.disabled = false;
    }
}

function renderError(r) {
    const el = $('run-error');
    if (!r.error) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    el.innerHTML = '';
    const code = document.createElement('strong');
    code.textContent = r.error.code;
    const msg = document.createElement('div');
    msg.textContent = r.error.message || '';
    el.append(code, msg);
}

function renderPicks(picks) {
    const tbody = $('picks-table').querySelector('tbody');
    tbody.innerHTML = '';
    $('picks-count').textContent = picks.length ? `(${picks.length})` : '(none)';
    for (const p of picks) {
        const tr = document.createElement('tr');
        const statusCls = (p.outcome || 'pushed').toLowerCase();
        tr.innerHTML = `
            <td><span class="pick-status ${statusCls}"></span></td>
            <td></td>
            <td></td>
            <td></td>
            <td></td>
        `;
        tr.children[0].querySelector('.pick-status').textContent = p.outcome || 'pushed';
        tr.children[1].textContent = p.title || '';
        tr.children[2].textContent = p.company || '';
        if (p.applyUrl) {
            const a = document.createElement('a');
            a.href = p.applyUrl;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'open';
            tr.children[3].appendChild(a);
        } else {
            tr.children[3].textContent = '—';
        }
        // Pushed picks are always AI-picked — map thumbs to good_pick / bad_pick.
        tr.children[4].appendChild(buildFeedbackButtons({
            jobId: p.jobId,
            title: p.title,
            company: p.company,
            aiPick: true,
            aiScore: 0,
            aiReason: '',
        }));
        tbody.appendChild(tr);
    }
}

// --- wiring -------------------------------------------------------------

$('client-search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderClients();
});
$('build-summary').addEventListener('click', buildSummary);
$('start-scrape').addEventListener('click', startScrape);
$('abort-run').addEventListener('click', abortRun);
$('clear-run')?.addEventListener('click', clearRun);
$('save-filters')?.addEventListener('click', saveFiltersForCurrentClient);
$('clear-filters')?.addEventListener('click', clearSavedFiltersForCurrentClient);

$('excl-add-company')?.addEventListener('click', () => addExclusionChip('companies'));
$('excl-add-location')?.addEventListener('click', () => addExclusionChip('locations'));
$('excl-company-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addExclusionChip('companies'); }
});
$('excl-location-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addExclusionChip('locations'); }
});
$('excl-save')?.addEventListener('click', saveExclusions);
$('excl-reset')?.addEventListener('click', resetExclusions);

$('filter-remarks')?.addEventListener('input', updateRemarksCount);

$('about-candidate')?.addEventListener('input', (e) => {
    state.aboutDraft = e.target.value;
    renderAboutCandidate();
});
$('about-save')?.addEventListener('click', saveAboutCandidate);
$('about-revert')?.addEventListener('click', revertAboutCandidate);

$('resume-run')?.addEventListener('click', resumeRun);
$('decisions-toggle')?.addEventListener('change', (e) => {
    state.decisionsVisible = e.target.checked;
    if (state.run) renderDecisions(state.run);
});
document.querySelectorAll('input[name="decisions-filter"]').forEach((el) => {
    el.addEventListener('change', (e) => {
        if (e.target.checked) {
            state.decisionsFilter = e.target.value;
            if (state.run) renderDecisions(state.run);
        }
    });
});

window.addEventListener('beforeunload', closeEventSource);

await loadHealth();
await loadClients();
renderRun();
