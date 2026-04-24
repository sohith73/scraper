import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMutex } from '../../src/playwright/mutex.js';
import { createSessionService } from '../../src/playwright/session.js';

// fakeBrowser: a minimal stand-in that exposes { withContext(opts, fn) } and
// builds a fake `ctx` whose `newPage()` returns a `fakePage` programmed
// with the responses we want.
function makeBrowser({ pageScript }) {
    return {
        calls: [],
        async withContext(opts, fn) {
            this.calls.push(opts);
            const page = pageScript();
            const ctx = { newPage: async () => page };
            return fn(ctx);
        },
    };
}

// fakeLocator: minimal Playwright-locator shape. A locator derived from an
// "error-text" regex (`/invalid.../`) is the one `performLoginViaForm`
// races against the success-nav promise — we make its `waitFor` hang
// forever so it never wins unless a test explicitly wants the "rejected
// login" path.
function fakeLocator({ hangingWaitFor = false } = {}) {
    const self = {
        first: () => self,
        click: async () => undefined,
        fill: async () => undefined,
        waitFor: hangingWaitFor
            ? () => new Promise(() => {})
            : async () => undefined,
    };
    return self;
}

// makeProbePage: returns a `page` whose `.evaluate` returns a scripted
// session-probe result. Used when tests want to assert probe behaviour
// without worrying about goto / click.
function makeProbePage(probeResult) {
    return {
        url: () => 'https://jobright.ai/',
        evaluate: async () => probeResult,
        goto: async () => undefined,
        getByText: (arg) =>
            fakeLocator({ hangingWaitFor: arg instanceof RegExp }),
        getByRole: () => fakeLocator(),
        waitForURL: async () => undefined,
        close: async () => undefined,
    };
}

const ENV = {
    JOBRIGHT_BASE: 'https://jobright.ai',
    JOBRIGHT_EMAIL: '',
    JOBRIGHT_PASSWORD: '',
};

test('probeSession: logged-in -> ok({loggedIn:true, userInfo})', async () => {
    const browser = makeBrowser({
        pageScript: () =>
            makeProbePage({
                status: 200,
                body: { success: true, result: { userId: 'u-123' } },
            }),
    });
    const session = createSessionService({
        env: ENV,
        browser,
        mutex: createMutex(),
    });
    const r = await session.probeSession();
    assert.equal(r.ok, true);
    assert.equal(r.value.loggedIn, true);
    assert.equal(r.value.userInfo.userId, 'u-123');
});

test('probeSession: anonymous -> loggedIn:false', async () => {
    const browser = makeBrowser({
        pageScript: () =>
            makeProbePage({ status: 200, body: { success: true, result: null } }),
    });
    const session = createSessionService({
        env: ENV,
        browser,
        mutex: createMutex(),
    });
    const r = await session.probeSession();
    assert.equal(r.ok, true);
    assert.equal(r.value.loggedIn, false);
    assert.equal(r.value.userInfo, null);
});

test('ensureLoggedIn: noop when probe says logged-in', async () => {
    const browser = makeBrowser({
        pageScript: () =>
            makeProbePage({
                status: 200,
                body: { success: true, result: { userId: 'u-1' } },
            }),
    });
    const session = createSessionService({
        env: ENV,
        browser,
        mutex: createMutex(),
    });
    const r = await session.ensureLoggedIn();
    assert.equal(r.ok, true);
    assert.equal(r.value.action, 'noop');
});

test('ensureLoggedIn headless: NEEDS_REAUTH when creds missing and probe fails', async () => {
    const browser = makeBrowser({
        pageScript: () =>
            makeProbePage({ status: 401, body: { success: false, result: null } }),
    });
    const session = createSessionService({
        env: { ...ENV, JOBRIGHT_EMAIL: '', JOBRIGHT_PASSWORD: '' },
        browser,
        mutex: createMutex(),
    });
    const r = await session.ensureLoggedIn();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'NEEDS_REAUTH');
});

test('ensureLoggedIn headless: programmatic login drives form then probes success', async () => {
    // Scripted page: first probe says logged-out; after the form flow a
    // second probe succeeds.
    let probeCallCount = 0;
    const pageEvents = [];
    const page = {
        url: () => 'https://jobright.ai/',
        evaluate: async () => {
            probeCallCount += 1;
            if (probeCallCount === 1) {
                return { status: 200, body: { success: true, result: null } };
            }
            return { status: 200, body: { success: true, result: { userId: 'u-1' } } };
        },
        goto: async (url) => pageEvents.push(`goto:${url}`),
        getByText: (t) => {
            const isRegex = t instanceof RegExp;
            const loc = {
                first: () => loc,
                click: async () => pageEvents.push(`click-text:${t}`),
                waitFor: isRegex ? () => new Promise(() => {}) : async () => undefined,
            };
            return loc;
        },
        getByRole: (r, opts) => {
            const loc = {
                first: () => loc,
                fill: async (v) => pageEvents.push(`fill:${opts?.name || r}:${v}`),
                click: async () => pageEvents.push(`click-role:${opts?.name || r}`),
                waitFor: async () => undefined,
            };
            return loc;
        },
        waitForURL: async () => pageEvents.push('post-login'),
        waitForResponse: async () => ({
            url: () => 'https://jobright.ai/swan/auth/login/pwd',
            status: () => 200,
            json: async () => ({ success: true, result: { userId: 'u-1' } }),
        }),
        close: async () => undefined,
    };
    const browser = {
        calls: [],
        async withContext(opts, fn) {
            this.calls.push(opts);
            return fn({ newPage: async () => page });
        },
    };
    const session = createSessionService({
        env: { ...ENV, JOBRIGHT_EMAIL: 'a@b.com', JOBRIGHT_PASSWORD: 'pw' },
        browser,
        mutex: createMutex(),
    });
    const r = await session.ensureLoggedIn();
    assert.equal(r.ok, true);
    assert.equal(r.value.action, 'logged-in');
    assert.equal(r.value.userInfo.userId, 'u-1');
    // Happened through the form path, not just a probe.
    assert.ok(pageEvents.some((e) => e.startsWith('fill:Email:a@b.com')));
    assert.ok(pageEvents.some((e) => e === 'post-login'));
});

test('ensureLoggedIn headless: LOGIN_FAILED when post-form probe still anonymous', async () => {
    const page = {
        url: () => 'https://jobright.ai/',
        evaluate: async () => ({ status: 200, body: { success: true, result: null } }),
        goto: async () => undefined,
        getByText: (arg) => fakeLocator({ hangingWaitFor: arg instanceof RegExp }),
        getByRole: () => fakeLocator(),
        waitForURL: async () => undefined,
        // Login API responds success — but the subsequent probe still shows
        // anonymous, tripping the LOGIN_FAILED branch.
        waitForResponse: async () => ({
            url: () => 'https://jobright.ai/swan/auth/login/pwd',
            status: () => 200,
            json: async () => ({ success: true, result: { userId: 'u-1' } }),
        }),
        close: async () => undefined,
    };
    const browser = {
        calls: [],
        async withContext(opts, fn) {
            this.calls.push(opts);
            return fn({ newPage: async () => page });
        },
    };
    const session = createSessionService({
        env: { ...ENV, JOBRIGHT_EMAIL: 'a@b.com', JOBRIGHT_PASSWORD: 'pw' },
        browser,
        mutex: createMutex(),
    });
    const r = await session.ensureLoggedIn();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'LOGIN_FAILED');
});

test('ensureLoggedIn classifies timeouts as LOGIN_TIMEOUT', async () => {
    const page = {
        url: () => 'https://jobright.ai/',
        evaluate: async () => ({ status: 200, body: { success: true, result: null } }),
        goto: async () => undefined,
        getByText: (arg) => fakeLocator({ hangingWaitFor: arg instanceof RegExp }),
        getByRole: () => fakeLocator(),
        // waitForResponse is where the login flow waits for JR's verdict —
        // a timeout here is the canonical "JR didn't respond" case.
        waitForResponse: async () => {
            throw new Error('Timeout 30000ms exceeded.');
        },
        waitForURL: async () => undefined,
        close: async () => undefined,
    };
    const browser = {
        calls: [],
        async withContext(opts, fn) {
            this.calls.push(opts);
            return fn({ newPage: async () => page });
        },
    };
    const session = createSessionService({
        env: { ...ENV, JOBRIGHT_EMAIL: 'a@b.com', JOBRIGHT_PASSWORD: 'pw' },
        browser,
        mutex: createMutex(),
    });
    const r = await session.ensureLoggedIn();
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'LOGIN_TIMEOUT');
});

test('ensureLoggedIn({headed:true}) opens the browser in headful mode', async () => {
    const page = {
        url: () => 'https://jobright.ai/',
        evaluate: async () => ({
            status: 200,
            body: { success: true, result: { userId: 'u-1' } },
        }),
        goto: async () => undefined,
        getByText: (arg) => fakeLocator({ hangingWaitFor: arg instanceof RegExp }),
        getByRole: () => fakeLocator(),
        waitForURL: async () => undefined,
        close: async () => undefined,
    };
    const browser = {
        calls: [],
        async withContext(opts, fn) {
            this.calls.push(opts);
            return fn({ newPage: async () => page });
        },
    };
    const session = createSessionService({
        env: ENV,
        browser,
        mutex: createMutex(),
    });
    const r = await session.ensureLoggedIn({ headed: true, force: true });
    assert.equal(r.ok, true);
    assert.equal(browser.calls[0].headless, false);
});
