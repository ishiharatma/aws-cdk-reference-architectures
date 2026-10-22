import { ApprovalApi, type ApiResult, type RequestView } from './api';
import { currentSession, signIn, signOut, type Session } from './auth';
import { loadConfig, type AppConfig } from './config';
import { t, toggleLanguage } from './i18n';

type Role = 'requester' | 'approver';

const TERMINAL = new Set<RequestView['status']>(['COMPLETED', 'REJECTED', 'EXPIRED']);
const STEPS: RequestView['status'][] = ['SUBMITTED', 'WAITING_APPROVAL', 'DECISION_RECEIVED'];
const POLL_MS = 3000;

/** Minimal element builder; all text goes through textContent, never innerHTML. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== undefined) el.append(c);
  return el;
}

const app = document.getElementById('app') as HTMLElement;

function roleOf(session: Session): Role | undefined {
  const groups = session.claims['cognito:groups'] ?? [];
  if (groups.includes('approvers')) return 'approver';
  if (groups.includes('requesters')) return 'requester';
  return undefined;
}

const money = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const time = (iso: string): string => new Date(iso).toLocaleString();

/** Progress bar of the DynamoDB projection, with the waiting step called out. */
function timeline(item: RequestView): HTMLElement {
  const bar = h('ol', { class: 'timeline' });
  const reached = TERMINAL.has(item.status) ? STEPS.length : STEPS.indexOf(item.status);
  STEPS.forEach((step, i) => {
    // A request that expired never received a decision.
    if (step === 'DECISION_RECEIVED' && item.status === 'EXPIRED') return;
    const state = i < reached ? 'done' : i === reached ? 'current' : 'todo';
    bar.append(h('li', { class: `step ${state}` }, t(`status.${step}`)));
  });
  bar.append(
    h(
      'li',
      { class: `step ${TERMINAL.has(item.status) ? `done end-${item.status}` : 'todo'}` },
      TERMINAL.has(item.status) ? t(`status.${item.status}`) : t('timeline.end')
    )
  );
  return bar;
}

function badge(status: RequestView['status']): HTMLElement {
  return h('span', { class: `badge s-${status}` }, t(`status.${status}`));
}

function resultLine(res: ApiResult): HTMLElement {
  const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
  return h(
    'p',
    { class: `result ${res.status < 300 ? 'ok' : 'ng'}` },
    `HTTP ${res.status} ${body}`
  );
}

// ---------------------------------------------------------------------------------------
// Requester view: submit, then watch own requests. Ids are kept per user in localStorage,
// because the requester role is not allowed to list requests (least privilege).

function requesterView(api: ApprovalApi, session: Session, config: AppConfig): HTMLElement {
  const storeKey = `ldf-demo-mine-${session.claims.sub}`;
  const mine = (): string[] => JSON.parse(localStorage.getItem(storeKey) ?? '[]') as string[];
  const remember = (id: string): void => {
    localStorage.setItem(
      storeKey,
      JSON.stringify([id, ...mine().filter((x) => x !== id)].slice(0, 20))
    );
  };
  const cache = new Map<string, RequestView>();

  const title = h('input', { name: 'title', required: '', maxlength: '200', value: 'New laptop' });
  const amount = h('input', {
    name: 'amount',
    type: 'number',
    min: '1',
    step: 'any',
    required: '',
    value: '1200',
  });
  const key = h('input', {
    name: 'key',
    maxlength: '55',
    pattern: '[A-Za-z0-9_-]{1,55}',
    placeholder: t('form.keyPlaceholder'),
  });
  const submitResult = h('div');
  const form = h(
    'form',
    { class: 'card' },
    h('h2', {}, t('form.heading')),
    h('label', {}, t('form.title'), title),
    h('label', {}, t('form.amount'), amount),
    h('label', {}, t('form.key'), key),
    h('button', { type: 'submit' }, t('form.submit')),
    submitResult
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api.send<{ requestId?: string }>(
      'POST',
      'requests',
      { title: title.value, amount: Number(amount.value) },
      key.value ? { 'Idempotency-Key': key.value } : {}
    );
    submitResult.replaceChildren(resultLine(res));
    if (res.status < 300 && res.body.requestId) {
      remember(res.body.requestId);
      void refresh();
    }
  });

  const list = h('div', { class: 'list' });
  const section = h(
    'section',
    { class: 'card' },
    h('h2', {}, t('mine.heading')),
    h('p', { class: 'hint' }, t('mine.hint')),
    list
  );

  async function refresh(): Promise<void> {
    const ids = mine();
    await Promise.all(
      ids
        .filter((id) => !TERMINAL.has(cache.get(id)?.status ?? 'SUBMITTED'))
        .map(async (id) => {
          const res = await api.send<RequestView>('GET', `requests/${encodeURIComponent(id)}`);
          if (res.status === 200) cache.set(id, res.body);
        })
    );
    list.replaceChildren(
      ...(ids.length === 0 ? [h('p', { class: 'hint' }, t('mine.empty'))] : []),
      ...ids.map((id) => {
        const item = cache.get(id);
        if (!item) return h('div', { class: 'item' }, h('code', {}, id), ' ', t('mine.pending'));
        const tryResult = h('div');
        const tryButton = h('button', { class: 'secondary' }, t('mine.trySelfApprove'));
        tryButton.addEventListener('click', async () => {
          const res = await api.send('POST', `requests/${encodeURIComponent(id)}/decision`, {
            approved: true,
          });
          tryResult.replaceChildren(
            resultLine(res),
            h('p', { class: 'hint' }, t('mine.trySelfApproveHint'))
          );
        });
        return h(
          'div',
          { class: 'item' },
          h(
            'div',
            { class: 'row' },
            h('strong', {}, item.title),
            h('span', {}, money(item.amount)),
            badge(item.status)
          ),
          h('div', { class: 'meta' }, h('code', {}, item.requestId), ` · ${time(item.createdAt)}`),
          timeline(item),
          item.status === 'WAITING_APPROVAL'
            ? h(
                'p',
                { class: 'hint wait' },
                t('mine.waitingNote', { minutes: config.approvalTimeoutMinutes })
              )
            : undefined,
          item.decision
            ? h(
                'p',
                { class: 'meta' },
                `${t('decision.by')}: ${item.decision.approver}${item.decision.comment ? ` — "${item.decision.comment}"` : ''}`
              )
            : undefined,
          item.status === 'WAITING_APPROVAL' ? tryButton : undefined,
          tryResult
        );
      })
    );
  }

  void refresh();
  setInterval(() => void refresh(), POLL_MS);
  return h('div', { class: 'grid' }, form, section);
}

// ---------------------------------------------------------------------------------------
// Approver view: the WAITING_APPROVAL work list from GET /requests, plus past results.

function approverView(api: ApprovalApi, config: AppConfig): HTMLElement {
  const pending = h('div', { class: 'list' });
  const history = h('div', { class: 'list' });
  const filter = h(
    'select',
    {},
    ...['COMPLETED', 'REJECTED', 'EXPIRED', 'DECISION_RECEIVED'].map((s) =>
      h('option', { value: s }, t(`status.${s}`))
    )
  );
  const results = new Map<string, HTMLElement>();
  const comments = new Map<string, string>();

  function pendingItem(item: RequestView): HTMLElement {
    const deadline = new Date(
      new Date(item.createdAt).getTime() + config.approvalTimeoutMinutes * 60_000
    );
    const comment = h('input', {
      placeholder: t('decision.comment'),
      maxlength: '1000',
      value: comments.get(item.requestId) ?? '',
    });
    comment.addEventListener('input', () => comments.set(item.requestId, comment.value));
    const out = results.get(item.requestId) ?? h('div');
    results.set(item.requestId, out);
    const decide = (approved: boolean) => async (): Promise<void> => {
      const res = await api.send(
        'POST',
        `requests/${encodeURIComponent(item.requestId)}/decision`,
        {
          approved,
          ...(comment.value ? { comment: comment.value } : {}),
        }
      );
      out.replaceChildren(resultLine(res));
      void refresh();
    };
    const approve = h('button', {}, t('decision.approve'));
    const reject = h('button', { class: 'danger' }, t('decision.reject'));
    approve.addEventListener('click', decide(true));
    reject.addEventListener('click', decide(false));
    return h(
      'div',
      { class: 'item' },
      h(
        'div',
        { class: 'row' },
        h('strong', {}, item.title),
        h('span', {}, money(item.amount)),
        badge(item.status)
      ),
      h(
        'div',
        { class: 'meta' },
        h('code', {}, item.requestId),
        ` · ${t('decision.deadline')} ${deadline.toLocaleString()}`
      ),
      h('div', { class: 'meta' }, `${t('decision.requester')}: ${item.requester}`),
      h('div', { class: 'row' }, comment, approve, reject),
      out
    );
  }

  async function refresh(): Promise<void> {
    const [p, hist] = await Promise.all([
      api.send<{ items: RequestView[] }>('GET', 'requests?status=WAITING_APPROVAL'),
      api.send<{ items: RequestView[] }>('GET', `requests?status=${filter.value}`),
    ]);
    if (p.status !== 200) {
      pending.replaceChildren(resultLine(p));
    } else {
      pending.replaceChildren(
        ...(p.body.items.length === 0 ? [h('p', { class: 'hint' }, t('approver.empty'))] : []),
        ...p.body.items.map(pendingItem)
      );
    }
    if (hist.status === 200) {
      history.replaceChildren(
        ...hist.body.items.map((item) =>
          h(
            'div',
            { class: 'item' },
            h(
              'div',
              { class: 'row' },
              h('strong', {}, item.title),
              h('span', {}, money(item.amount)),
              badge(item.status)
            ),
            h(
              'div',
              { class: 'meta' },
              h('code', {}, item.requestId),
              ` · ${time(item.updatedAt)}`
            ),
            item.decision?.comment
              ? h('div', { class: 'meta' }, `"${item.decision.comment}"`)
              : undefined
          )
        )
      );
    }
  }

  filter.addEventListener('change', () => void refresh());
  void refresh();
  setInterval(() => void refresh(), POLL_MS);
  return h(
    'div',
    { class: 'grid' },
    h(
      'section',
      { class: 'card' },
      h('h2', {}, t('approver.heading')),
      h('p', { class: 'hint' }, t('approver.hint')),
      pending
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'row' }, h('h2', {}, t('history.heading')), filter),
      history
    )
  );
}

// ---------------------------------------------------------------------------------------

function header(
  config: AppConfig,
  session?: Session,
  role?: Role,
  identityId?: string
): HTMLElement {
  const lang = h('button', { class: 'secondary small' }, t('lang.toggle'));
  lang.addEventListener('click', () => {
    toggleLanguage();
    window.location.reload();
  });
  const right = h('div', { class: 'row' }, lang);
  if (session) {
    const out = h('button', { class: 'secondary small' }, t('auth.signOut'));
    out.addEventListener('click', () => signOut(config));
    right.append(
      h('span', { class: 'who' }, session.claims.email ?? session.claims.sub),
      role ? h('span', { class: `badge role-${role}` }, t(`role.${role}`)) : '',
      out
    );
  }
  return h(
    'header',
    {},
    h(
      'div',
      {},
      h('h1', {}, t('app.title')),
      h('p', { class: 'hint' }, t('app.subtitle')),
      identityId ? h('p', { class: 'meta' }, `Cognito identity: ${identityId}`) : undefined
    ),
    right
  );
}

function explainer(): HTMLElement {
  return h(
    'details',
    { class: 'card explain' },
    h('summary', {}, t('explain.summary')),
    h('ol', {}, ...['1', '2', '3', '4'].map((n) => h('li', {}, t(`explain.${n}`))))
  );
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const session = await currentSession(config);
  if (!session) {
    const button = h('button', {}, t('auth.signIn'));
    button.addEventListener('click', () => void signIn(config));
    app.replaceChildren(
      header(config),
      h('section', { class: 'card center' }, h('p', {}, t('auth.prompt')), button),
      explainer()
    );
    return;
  }
  const role = roleOf(session);
  if (!role) {
    app.replaceChildren(
      header(config, session),
      h('section', { class: 'card' }, h('p', {}, t('auth.noGroup')))
    );
    return;
  }
  const api = new ApprovalApi(config, session);
  const identityId = await api.identityId();
  app.replaceChildren(
    header(config, session, role, identityId),
    explainer(),
    role === 'requester' ? requesterView(api, session, config) : approverView(api, config)
  );
}

main().catch((error: unknown) => {
  app.replaceChildren(
    h('section', { class: 'card' }, h('p', { class: 'result ng' }, String(error)))
  );
});
