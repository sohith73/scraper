// SearchIntent — the single canonical structure the rest of the scraper
// consumes. Phase 5 summariser emits `AiIntent` (what the model produces)
// and then wraps it with authoritative exclusions from the dashboard to
// form a full `SearchIntent`.
//
// Seniority is a small closed enum so the Phase 9 filter-update step can
// map it deterministically to JobRight's integer `seniority` codes.
//
// All "extended" filter knobs are optional — gpt-4o-mini leaves them null
// when it has no profile signal, and the operator can override any of them
// via the /api/runs `overrideIntent` body.
//
// Canonical JR field mapping: see docs/filter-enums.md

import { z } from 'zod';

export const SeniorityEnum = z.enum([
    'intern',
    'entry',
    'mid',
    'senior',
    'lead',
    'exec',
]);

// Employment type aliases. The mapper maps these to JR's integer codes.
// Keep lowercase + hyphenless so the model output is stable.
export const EmploymentTypeEnum = z.enum([
    'full-time',
    'contract',
    'part-time',
    'internship',
]);

// Workstyle: where the role physically is. Redundant with `locations` in
// some cases but lets the AI express "remote-only, I don't care about city".
export const WorkModelEnum = z.enum(['onsite', 'remote', 'hybrid']);

// Role flavour — individual contributor vs. people manager.
export const RoleTypeEnum = z.enum(['ic', 'manager']);

// Company-stage buckets expressed in English so the prompt can pick from
// them without knowing JR's string indices. The mapper is responsible
// for any JR-side translation.
export const CompanyStageEnum = z.enum([
    'seed',
    'early-stage',
    'growth-stage',
    'late-stage',
    'public',
]);

// AiIntent — the exact shape we ask the model to return.
// Exclusions are deliberately NOT here; they come from the dashboard
// (ClientOperationsModel) and must not be inferred by the AI.
//
// Every "extended" field below is optional so the AI can leave them null
// when the candidate's profile gives no hint — that way a bare profile
// still yields a workable intent without hallucinated filters.
export const AiIntent = z.object({
    // Core (v1)
    roles: z.array(z.string().min(1)).max(15),
    locations: z.array(z.string().min(1)).max(15),
    seniority: SeniorityEnum,
    companies: z.array(z.string()).max(50),
    workAuth: z.string(),
    narrative: z.string(),
    futurePreferences: z.string(),

    // Extended filter knobs — optional
    employmentTypes: z.array(EmploymentTypeEnum).max(4).nullable().optional(),
    workModels: z.array(WorkModelEnum).max(3).nullable().optional(),
    daysAgo: z.number().int().min(1).max(365).nullable().optional(),
    minYearsOfExperience: z.number().int().min(0).max(40).nullable().optional(),
    maxYearsOfExperience: z.number().int().min(0).max(40).nullable().optional(),
    salaryMinimumUsd: z.number().int().min(0).max(1_000_000).nullable().optional(),
    industries: z.array(z.string()).max(15).nullable().optional(),
    skills: z.array(z.string()).max(25).nullable().optional(),
    companyStages: z.array(CompanyStageEnum).max(5).nullable().optional(),
    roleType: RoleTypeEnum.nullable().optional(),
    excludedTitles: z.array(z.string()).max(15).nullable().optional(),
    excludedSkills: z.array(z.string()).max(15).nullable().optional(),
    excludedIndustries: z.array(z.string()).max(15).nullable().optional(),
    excludeStaffingAgency: z.boolean().nullable().optional(),
    excludeSecurityClearance: z.boolean().nullable().optional(),
    excludeUsCitizenOnly: z.boolean().nullable().optional(),
});

export const ExclusionSet = z.object({
    companies: z.array(z.string()),
    locations: z.array(z.string()),
});

// SearchIntent — AI output fused with authoritative exclusions, plus
// operator-only free-text `remarks` that the AI-derived intent never
// carries. Remarks are threaded into the relevance prompt so the AI
// obeys operator directives like "no entry-level jobs" or "prefer
// fintech". Max 1000 chars to keep the downstream prompt bounded.
export const SearchIntent = AiIntent.extend({
    exclusions: ExclusionSet,
    remarks: z.string().max(1000).optional().default(''),
});

// JSON Schema (hand-written) for OpenAI Structured Outputs. Must mirror
// `AiIntent` above; the schema test enforces parity.
//
// NOTE: OpenAI's strict mode demands `additionalProperties:false` AND
// requires that every property be listed in `required`, even optional
// ones. We keep the optional filters in `required` but allow `null` in
// their type union — that's the strict-mode pattern for "optional".
export const AI_INTENT_JSON_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [
        'roles',
        'locations',
        'seniority',
        'companies',
        'workAuth',
        'narrative',
        'futurePreferences',
        'employmentTypes',
        'workModels',
        'daysAgo',
        'minYearsOfExperience',
        'maxYearsOfExperience',
        'salaryMinimumUsd',
        'industries',
        'skills',
        'companyStages',
        'roleType',
        'excludedTitles',
        'excludedSkills',
        'excludedIndustries',
        'excludeStaffingAgency',
        'excludeSecurityClearance',
        'excludeUsCitizenOnly',
    ],
    properties: {
        // Core
        roles: { type: 'array', items: { type: 'string' } },
        locations: { type: 'array', items: { type: 'string' } },
        seniority: {
            type: 'string',
            enum: ['intern', 'entry', 'mid', 'senior', 'lead', 'exec'],
        },
        companies: { type: 'array', items: { type: 'string' } },
        workAuth: { type: 'string' },
        narrative: { type: 'string' },
        futurePreferences: { type: 'string' },
        // Extended — every one uses `['type', 'null']` so the model can
        // explicitly decline to set it.
        employmentTypes: {
            type: ['array', 'null'],
            items: { type: 'string', enum: ['full-time', 'contract', 'part-time', 'internship'] },
        },
        workModels: {
            type: ['array', 'null'],
            items: { type: 'string', enum: ['onsite', 'remote', 'hybrid'] },
        },
        daysAgo: { type: ['integer', 'null'] },
        minYearsOfExperience: { type: ['integer', 'null'] },
        maxYearsOfExperience: { type: ['integer', 'null'] },
        salaryMinimumUsd: { type: ['integer', 'null'] },
        industries: { type: ['array', 'null'], items: { type: 'string' } },
        skills: { type: ['array', 'null'], items: { type: 'string' } },
        companyStages: {
            type: ['array', 'null'],
            items: {
                type: 'string',
                enum: ['seed', 'early-stage', 'growth-stage', 'late-stage', 'public'],
            },
        },
        roleType: { type: ['string', 'null'], enum: ['ic', 'manager', null] },
        excludedTitles: { type: ['array', 'null'], items: { type: 'string' } },
        excludedSkills: { type: ['array', 'null'], items: { type: 'string' } },
        excludedIndustries: { type: ['array', 'null'], items: { type: 'string' } },
        excludeStaffingAgency: { type: ['boolean', 'null'] },
        excludeSecurityClearance: { type: ['boolean', 'null'] },
        excludeUsCitizenOnly: { type: ['boolean', 'null'] },
    },
};
