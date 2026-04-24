import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    fetchCatalog,
    resolveRoles,
    _resetCache,
} from '../../src/services/search/taxonomyCatalog.js';

// Minimal JR-shaped tree for tests.
const FAKE_TREE = [
    {
        id: '01-00-00',
        display_name: 'Software/Internet/AI',
        taxonomy_name: 'Software/Internet/AI',
        second_category: [
            {
                id: '01-08-00',
                taxonomy_name: 'Data & Analytics',
                third_category: [
                    { id: '01-08-01', taxonomy_name: 'Data Analyst' },
                    { id: '01-08-02', taxonomy_name: 'Data Scientist' },
                    { id: '01-08-03', taxonomy_name: 'Data Engineer' },
                ],
            },
            {
                id: '01-06-00',
                taxonomy_name: 'Machine Learning & AI',
                third_category: [
                    { id: '01-06-01', taxonomy_name: 'Machine Learning Engineer' },
                    { id: '01-06-02', taxonomy_name: 'AI Engineer' },
                ],
            },
        ],
    },
];

function makePage(body) {
    return {
        evaluate: async () => ({ status: 200, body: { success: true, result: body }, bodyText: '' }),
    };
}

test('fetchCatalog: flattens 3-level tree into {id,title} leaves', async () => {
    _resetCache();
    const page = makePage(FAKE_TREE);
    const cat = await fetchCatalog({ page, env: { JOBRIGHT_BASE: 'https://jr' } });
    assert.equal(cat.length, 5);
    assert.deepEqual(cat.find((c) => c.id === '01-08-02'), {
        id: '01-08-02',
        title: 'Data Scientist',
        displayName: 'Data Scientist',
    });
});

test('fetchCatalog: caches result across calls', async () => {
    _resetCache();
    let fetchCount = 0;
    const page = {
        evaluate: async () => {
            fetchCount += 1;
            return { status: 200, body: { success: true, result: FAKE_TREE } };
        },
    };
    await fetchCatalog({ page, env: { JOBRIGHT_BASE: 'https://jr' } });
    await fetchCatalog({ page, env: { JOBRIGHT_BASE: 'https://jr' } });
    assert.equal(fetchCount, 1);
});

test('fetchCatalog: force:true bypasses cache', async () => {
    _resetCache();
    let fetchCount = 0;
    const page = {
        evaluate: async () => {
            fetchCount += 1;
            return { status: 200, body: { success: true, result: FAKE_TREE } };
        },
    };
    await fetchCatalog({ page, env: { JOBRIGHT_BASE: 'https://jr' } });
    await fetchCatalog({ page, env: { JOBRIGHT_BASE: 'https://jr' }, force: true });
    assert.equal(fetchCount, 2);
});

test('fetchCatalog: failure returns previous cache', async () => {
    _resetCache();
    const okPage = {
        evaluate: async () => ({ status: 200, body: { success: true, result: FAKE_TREE } }),
    };
    await fetchCatalog({ page: okPage, env: { JOBRIGHT_BASE: 'https://jr' } });

    const brokenPage = {
        evaluate: async () => ({ status: 500, body: null, bodyText: '' }),
    };
    const cat = await fetchCatalog({ page: brokenPage, env: { JOBRIGHT_BASE: 'https://jr' }, force: true });
    // force=true re-fetches but failure returns whatever we had
    assert.equal(cat.length, 5);
});

// --- resolveRoles -----------------------------------------------------

function makeCatalog() {
    return [
        { id: '01-08-01', title: 'Data Analyst' },
        { id: '01-08-02', title: 'Data Scientist' },
        { id: '01-08-03', title: 'Data Engineer' },
        { id: '01-06-01', title: 'Machine Learning Engineer' },
        { id: '01-06-02', title: 'AI Engineer' },
        { id: '01-01-01', title: 'Backend Engineer' },
    ];
}

test('resolveRoles: exact-match wins', () => {
    const r = resolveRoles({ catalog: makeCatalog(), roles: ['Data Scientist'] });
    assert.deepEqual(r.resolved, [{ taxonomyId: '01-08-02', title: 'Data Scientist' }]);
    assert.deepEqual(r.unresolved, []);
});

test('resolveRoles: case-insensitive exact match', () => {
    const r = resolveRoles({ catalog: makeCatalog(), roles: ['DATA engineer'] });
    assert.equal(r.resolved[0].taxonomyId, '01-08-03');
});

test('resolveRoles: substring fallback', () => {
    const r = resolveRoles({ catalog: makeCatalog(), roles: ['ML Engineer'] });
    // Token overlap finds "Machine Learning Engineer"
    assert.equal(r.resolved[0].taxonomyId, '01-06-01');
});

test('resolveRoles: returns unresolved for total misses', () => {
    const r = resolveRoles({
        catalog: makeCatalog(),
        roles: ['Clown', 'Astronaut'],
    });
    assert.deepEqual(r.resolved, []);
    assert.deepEqual(r.unresolved, ['Clown', 'Astronaut']);
});

test('resolveRoles: mixed hit and miss', () => {
    const r = resolveRoles({
        catalog: makeCatalog(),
        roles: ['Data Scientist', 'Underwater Basket Weaver', 'AI Engineer'],
    });
    assert.equal(r.resolved.length, 2);
    assert.deepEqual(r.unresolved, ['Underwater Basket Weaver']);
});

test('resolveRoles: dedupes same taxonomy via different titles', () => {
    const r = resolveRoles({
        catalog: makeCatalog(),
        roles: ['Data Scientist', 'data scientist', 'DATA SCIENTIST'],
    });
    assert.equal(r.resolved.length, 1);
});

test('resolveRoles: empty catalog → everything unresolved', () => {
    const r = resolveRoles({ catalog: [], roles: ['Data Scientist'] });
    assert.deepEqual(r.resolved, []);
    assert.deepEqual(r.unresolved, ['Data Scientist']);
});

test('resolveRoles: missing args → empty result', () => {
    assert.deepEqual(resolveRoles({}).resolved, []);
    assert.deepEqual(resolveRoles({ catalog: makeCatalog() }).resolved, []);
});
