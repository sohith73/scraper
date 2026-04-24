# JobRight filter field reference

Every key in JR's filter payload with its accepted shape, UI label, and
canonical value mapping. Discovered via MCP Playwright + direct `POST
/swan/filter/update/filter` probes 2026-04-23.

JR accepts any value server-side for most enum fields — it doesn't
validate membership. So "wrong" values are silently stored. The mapping
below is what the **UI** uses; we send the same so jobs returned match
what an operator would see if they toggled the filter in the browser.

## Field table

| Key | Type | UI label | Canonical values |
|---|---|---|---|
| `jobTitle` | string | Job Function (free text) | comma-separated titles |
| `jobTaxonomyList` | `[{taxonomyId, title}]` | Job Function (structured) | e.g. `{taxonomyId:"01-01-01", title:"Backend Engineer"}` |
| `jobTypes` | int[] | Job Type | **1**=Full-time, **2**=Contract, **3**=Part-time, **4**=Internship |
| `country` | string | Country | `"US"` (only US supported today) |
| `city` | string\|null | — | unused in UI |
| `seniority` | int[] | Seniority (top-bar chip) | **1**=Internship, **2**=Entry, **3**=Mid, **4**=Senior, **5**=Lead, **6**=Exec |
| `workModel` | int[] | Work Model | **1**=Onsite, **2**=Remote, **3**=Hybrid |
| `locations` | `[{city,radiusRange}]` | Location | `[{city:"Within US", radiusRange:25}]` for country-wide; else `[{city:"San Francisco, CA", radiusRange:25}]` |
| `radiusRange` | int (miles) | Radius | 25 default |
| `isH1BOnly` | bool | H1B Only chip | true → only jobs with H1B sponsor flag |
| `daysAgo` | int (days) | Date Posted | **1** (past 24h), **3**, **7**, **14**, **30**, `null` (any). Accepts arbitrary ints. |
| `minYearsOfExperienceRange` | `[min,max]` int array OR symbolic string | Years of Experience | `[0,2]` or alias `"Entry"`; `[3,7]` or `"Senior"`; server normalises strings to `[min,max]` on read |
| `annualSalaryMinimum` | int (USD) | Minimum Annual Salary | e.g. 100000; `null` = "Any salary" |
| `companyCategory` | string[] | Industry | free text: `"Information Technology"`, `"Artificial Intelligence (AI)"`, `"Finance"`, `"Consulting"`, `"Software"`, … |
| `excludeCompanyCategory` | string[]\|null | Excluded Industry | same set |
| `skills` | string[] | Skill | free text: `"LLMs"`, `"Python"`, `"Product Development"`, … |
| `excludedSkills` | string[]\|null | Excluded Skill | same set |
| `companies` | string[] | Target Companies | free text (company names) |
| `excludedCompanies` | string[] | Excluded Companies | free text; enforced server-side + echoed to scraper preflight |
| `excludedTitle` | string\|null | Excluded Title | free text |
| `companyStages` | string[]\|null | Company Stages | read back as strings; UI shows Seed / Series A / Series B / Series C / Series D / Public / Late Stage (values **1**-**7** observed, stored as strings) |
| `roleType` | string\|null | Role (IC/Manager) | `"IC"` or `"Manager"` (strings) — integers also stored verbatim |
| `excludeStaffingAgency` | bool\|null | Exclude staffing agencies | true = hide |
| `excludeSecurityClearance` | bool | Exclude security-clearance jobs | true = hide |
| `excludeUsCitizen` | bool | Exclude US-citizen-only jobs | true = hide |
| `hiddenJobsOnly` | bool\|null | Hidden Jobs only | rare operator-use |
| `recommendationPreference` | int\|null | — | observed null; unused |

## User question: "hours before posted"

JR's finest granularity is **days** (`daysAgo: 1` = past 24 hours). The
list payload shows relative strings like `"4 hours ago"` / `"19 hours
ago"` but the filter itself has no sub-day control. Our scraper exposes
`daysAgo` via `SearchIntent.daysAgo` and maps it to the JR filter
directly.

## UI quick-filter chips → underlying fields

| Top-bar chip | Field controlled |
|---|---|
| Country (United States) | `country` |
| Role (Backend Engineer +1) | `jobTaxonomyList` + `jobTitle` |
| Seniority (Mid Level +N) | `seniority` |
| Employment type (Full-time +N) | `jobTypes` |
| Work Model (Remote +N) | `workModel` |
| Date Posted | `daysAgo` |
| Years of Experience | `minYearsOfExperienceRange` |
| Industry | `companyCategory` |
| Hidden Jobs | `hiddenJobsOnly` |
| H1B Only | `isH1BOnly` |

## Notes / gotchas

1. **JR doesn't validate enum bounds server-side.** Sending `seniority:[99]` is "successful" but returns zero matches. Our mapper only emits values from the canonical table above.
2. **`minYearsOfExperienceRange` accepts strings that resolve to arrays.** When we send `"Entry"`, server returns `[0,2]`. Prefer sending arrays ourselves so the round-trip is deterministic.
3. **`roleType`, `companyStages`, `excludedCompanies`** are stored as strings on readback even when numbers are sent. Send strings to match.
4. **Server silently drops unknown fields.** Adding a key like `futurePreferences` to the payload won't break the call but also won't do anything.
5. **Filter is per-user and persistent.** Mutating a filter field persists until the user changes it. Our scraper always re-sends the full merged filter to avoid silent carryover.
