// JR filter payload — type guard.
//
// Why: JR's Java backend deserialises every field with strict types. A
// single string-vs-array mismatch returns:
//   "JSON parse error: Cannot construct instance of `java.util.ArrayList` ...
//    no String-argument constructor/factory method to deserialize from
//    String value ('Technician')"
// — bubbling up as opaque `FILTER_UPDATE_FAILED status=400`. The existing
// recon (`docs/reconnaissance.md`) + production failures pin down the
// canonical types for every field. This module asserts them BEFORE we
// POST so we fail with a precise, actionable error instead of waiting on
// JR's stack trace.
//
// Source of truth — verified live 2026-04-25:
//   ARRAY-of-string  : skills, excludedSkills, companies, excludedCompanies,
//                      excludedTitle, companyCategory
//   ARRAY-of-int     : jobTypes, seniority, workModel
//   ARRAY-of-object  : jobTaxonomyList, locations
//   ARRAY-of-int|null: minYearsOfExperienceRange, companyStages, roleType,
//                      excludeCompanyCategory
//   STRING           : jobTitle, country
//   STRING|null      : city, recommendationPreference, hiddenJobsOnly
//   NUMBER|null      : annualSalaryMinimum, daysAgo, radiusRange
//   BOOLEAN          : isH1BOnly, excludeSecurityClearance, excludeUsCitizen
//   BOOLEAN|null     : excludeStaffingAgency

import { z } from 'zod';

// --- helpers -------------------------------------------------------------

const stringArray = z.array(z.string()).optional();
const intArray = z.array(z.number().int()).optional();
const nullableIntArray = z.union([z.array(z.number().int()), z.null()]).optional();
const nullableNumber = z.union([z.number(), z.null()]).optional();
const nullableString = z.union([z.string(), z.null()]).optional();
const nullableBool = z.union([z.boolean(), z.null()]).optional();

const taxonomyEntry = z.object({
    taxonomyId: z.string(),
    title: z.string(),
}).passthrough();

const locationEntry = z.object({
    city: z.string(),
    radiusRange: z.number().int(),
}).passthrough();

// --- the schema ---------------------------------------------------------

export const JR_FILTER_SCHEMA = z.object({
    // Required scalars
    jobTitle: z.string(),
    country: z.string(),

    // Always arrays — JR rejects strings / nulls here. We allow strings
    // OR objects in the company-style fields because JR's UI sometimes
    // hydrates them as `{companyName}` records depending on the saved
    // filter; the deserialiser accepts both as long as it's an array.
    jobTaxonomyList: z.array(taxonomyEntry),
    skills: z.array(z.union([z.string(), z.record(z.any())])),
    companies: z.array(z.union([z.string(), z.record(z.any())])),
    excludedCompanies: z.array(z.union([z.string(), z.record(z.any())])),
    excludedTitle: z.array(z.union([z.string(), z.record(z.any())])),
    companyCategory: z.array(z.union([z.string(), z.record(z.any())])),
    jobTypes: z.array(z.number().int()),
    seniority: z.array(z.number().int()),
    workModel: z.array(z.number().int()),
    locations: z.array(locationEntry),

    // Nullable arrays / scalars — JR is inconsistent across these:
    //   excludedSkills: string array OR null
    //   minYearsOfExperienceRange: 2-tuple of ints OR null
    //   companyStages: STRING array (e.g. ["3","5"]) OR null
    //   roleType: SINGLE STRING ("IC"/"Manager") OR null  ← not array!
    //   excludeCompanyCategory: int array OR null
    excludedSkills: z.union([z.array(z.string()), z.null()]).optional(),
    minYearsOfExperienceRange: nullableIntArray,
    companyStages: z.union([z.array(z.string()), z.null()]).optional(),
    roleType: z.union([z.string(), z.null()]).optional(),
    excludeCompanyCategory: nullableIntArray,

    // Scalars / nullables
    city: nullableString,
    annualSalaryMinimum: nullableNumber,
    daysAgo: nullableNumber,
    radiusRange: z.number().int(),
    isH1BOnly: z.boolean(),
    excludeSecurityClearance: z.boolean(),
    excludeUsCitizen: z.boolean(),
    excludeStaffingAgency: nullableBool,
    hiddenJobsOnly: nullableString,
    recommendationPreference: nullableString,
}).passthrough(); // tolerate forward-compat fields JR may add

// validateJRFilter: returns { ok, issues } — never throws. Use BEFORE POST
// to /swan/filter/update/filter. Returns the validated payload on success
// (zod has stripped nothing because of .passthrough()).
//
// input  : payload object
// output : { ok: true, value }  |  { ok: false, issues: [{path,message}] }
export function validateJRFilter(payload) {
    const result = JR_FILTER_SCHEMA.safeParse(payload);
    if (result.success) return { ok: true, value: result.data };
    return {
        ok: false,
        issues: result.error.issues.map((iss) => ({
            path: iss.path.join('.'),
            expected: iss.expected,
            received: iss.received,
            message: iss.message,
        })),
    };
}
