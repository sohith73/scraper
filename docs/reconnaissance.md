# JobRight.ai reconnaissance — findings

Phase 0 complete. Done 2026-04-23 using MCP Playwright against `sohith@flashfirehq.com`.

## TL;DR — the pipeline is simpler than planned

Originally we expected DOM scraping + infinite-scroll + separate detail-endpoint capture. **None of that is needed.** JobRight exposes a fully populated JSON list endpoint that returns everything we need in a single call. Search = update stored filter + ask for N jobs.

Phase 9 collapses to ~40 lines. Phase 11 (detail fetcher) is effectively free — list payload already contains the fields we put into `jobDescription`.

## Core endpoints (authenticated, same-origin)

| Purpose | Method | Path | Notes |
|---|---|---|---|
| **List jobs** | `GET` | `/swan/recommend/list/jobs?refresh=true&sortCondition=0&position=0&count=N&syncRerank=false` | Returns fully hydrated jobs. Pagination via `position` + `count`. |
| **Get stored filter** | `POST` | `/swan/filter/get/filter` | Body `{}`. Returns user's current filter. |
| **Update stored filter** | `POST` | `/swan/filter/update/filter` | Body = same shape as get response. Returns `{success:true, result:true}`. |
| **Saved filter list** | `GET` | `/swan/filter/saved/list` | User's named filter presets (not needed v1). |
| **Password login** | `POST` | `/swan/auth/login/pwd` | Captured but not needed — we log in once via headed browser, cookies persist. |
| **Session probe** | `GET` | `/swan/auth/newinfo` | Good liveness check for "am I still logged in?". |
| Telemetry (SKIP) | `POST` | `/swan/event/submit` | Noise. |

## List response shape (confirmed live)

```
{
  success, errorCode, errorMsg,
  result: {
    impId,
    jobList: [
      {
        impId, displayScore, rankDesc, pos, isLiked,
        jobResult: {
          jobId,            // Mongo ObjectId string — stable dedup key
          jobTitle, jobNlpTitle,
          jobSeniority,     // "Senior Level" | ...
          jobLocation,      // free text, e.g. "United States", "Somerville, MA"
          isRemote, workModel, // "Remote" | "Onsite" | "Hybrid"
          publishTime, publishTimeDesc, employmentType,
          jobSummary,       // 1-paragraph summary
          originalUrl, applyLink, isCompanySiteLink,   // <-- real ATS URL
          jobRecruiter, jobRecruiterProfileUrl, applicantsCount,
          minYearsOfExperience,
          coreResponsibilities: [string],
          skillSummaries: [string],
          qualifications: { mustHave: [string], preferredHave: [string] },
          detailQualifications: {
            mustHave:    { yoe, education, hardSkill[{skill}], softSkill[{skill}] },
            preferredHave: { yoe, education, hardSkill, softSkill }
          },
          recommendationTags: [string],    // e.g. "H1B Sponsor Likely", "Early Applicant"
          jobTags: [string],
          recommendationScores, skillMatchingScores, industryMatchingScores,
          isH1bSponsor, isCitizenOnly, isClearanceRequired, isWorkAuthRequired,
          jobTaxonomyList, jobTaxonomyV3,
          jdLogo, firstTaxonomy, countryCode
        },
        companyResult: {
          companyId, companyName, companySize, companyDesc, companyCategories,
          companyLinkedinURL, companyFoundYear, companyLocation, companyURL,
          fundraisingCurrentStage, fundraisingTotalFunding, fundraisingLatestRounds,
          leadership, h1bAnnualJobCount, h1bTitleDistribution,
          isAgency, linkedinCompanyId
        },
        displayDebugInfo, displayUserDebugInfo
      }
    ]
  }
}
```

Individual job browsing URL (for human visits): `https://jobright.ai/jobs/info/<jobId>`.

## Filter shape (confirmed live)

All mutable via `POST /swan/filter/update/filter`:

```
{
  jobTitle: "Backend Engineer, Java Engineer",   // free-text CSV shown in UI
  jobTaxonomyList: [{ taxonomyId, title }],       // structured roles — the one that matters
  jobTypes: [int],                                 // 1=Full-time, 2=Contract (observed); verify remaining
  country: "US",
  city: null,
  seniority: [int],                                // 4=Senior, 5=?, 6=?; verify full set
  companyCategory: [],
  annualSalaryMinimum: null,
  isH1BOnly: bool,
  roleType: null,
  skills: [],
  companyStages: null,
  excludedTitle: null,
  excludedCompanies: [],
  excludedSkills: null,
  excludeStaffingAgency: null,
  minYearsOfExperienceRange: null,
  daysAgo: null,
  companies: [],
  excludeCompanyCategory: null,
  excludeSecurityClearance: bool,
  excludeUsCitizen: bool,
  hiddenJobsOnly: null,
  recommendationPreference: null,
  workModel: [int],                                 // 1=Onsite, 2=Remote, 3=Hybrid
  locations: [{ city, radiusRange }],
  radiusRange: 25
}
```

Enum values (`jobTypes`, `seniority`, `workModel`) were inferred — will verify by toggling UI chips once before shipping Phase 9.

## Auth surface

- Session travels as HTTP-only cookie(s). Persistent Chromium profile captures them automatically.
- `GET /swan/auth/newinfo` returns 200 when session is live. We'll use it as the login-expired probe.
- No visible bot-wall / CAPTCHA was triggered during recon. **Recommendation: `STEALTH=0` by default**, flip to 1 if a future run sees 403s.

## What's out / skipped

- **No separate detail endpoint needed** — list payload is sufficient. (Probing for one was denied by safety tooling; we don't need it anyway.)
- **No infinite-scroll code** — use `count=N` directly. Verified `count=3` works; Phase 9 will test upper bound empirically and cap at the JR-tolerated max.
- `/swan/event/submit`, promo/upsell endpoints (`payment/tg-offer`, `popup/*`), and unrelated features (Orion chat, resume-tailor, etc.) are outside scope.

## Decisions for downstream phases

| Original plan | Updated |
|---|---|
| Phase 9 scroll-to-N | **Delete scroll logic.** One `GET /swan/recommend/list/jobs?count=N` after `filter/update/filter`. |
| Phase 11 detail fetcher | **Delete click-and-capture.** Enrich directly from list payload by concatenating `jobSummary + coreResponsibilities + qualifications.mustHave + skillSummaries`. |
| Phase 8 generic interceptor | **Keep but slimmer.** Used only for the single list call + defensive capture of any unexpected endpoint. |
| Phase 16 stealth | **Defer.** Off by default; enable only on block. |

## Open items (defer to Phase 9 smoke test)

1. Map remaining `seniority` enum values (probably 1=Internship, 2=Entry, 3=Mid, 4=Senior, 5=Lead, 6=Exec — confirm).
2. Map remaining `jobTypes` enum values (3=Part-time? 4=Internship?).
3. Upper bound on `count` before the endpoint truncates/rate-limits.
4. Does `refresh=true` force re-ranking vs `refresh=false`? Behaviour difference in output ordering.

None of these block Phase 2.
