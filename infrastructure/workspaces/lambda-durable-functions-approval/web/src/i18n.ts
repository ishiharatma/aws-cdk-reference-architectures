export type Lang = 'en' | 'ja';

const LANG_KEY = 'ldf-demo-lang';

const messages: Record<Lang, Record<string, string>> = {
  en: {
    'app.title': 'Approval workflow demo',
    'app.subtitle': 'Lambda durable functions · waitForCallback · IAM-authorized API',
    'lang.toggle': '日本語',
    'auth.signIn': 'Sign in',
    'auth.signOut': 'Sign out',
    'auth.prompt': 'Sign in as a requester or an approver demo user.',
    'auth.noGroup': 'This user is in neither the "requesters" nor the "approvers" group.',
    'role.requester': 'Requester',
    'role.approver': 'Approver',
    'status.SUBMITTED': 'Submitted',
    'status.WAITING_APPROVAL': 'Waiting for approval',
    'status.DECISION_RECEIVED': 'Decision received',
    'status.COMPLETED': 'Completed',
    'status.REJECTED': 'Rejected',
    'status.EXPIRED': 'Expired',
    'timeline.end': 'Completed / Rejected / Expired',
    'form.heading': 'New request',
    'form.title': 'Title',
    'form.amount': 'Amount',
    'form.key': 'Idempotency-Key (optional)',
    'form.keyPlaceholder': 'e.g. req-0001 — resend to see idempotency',
    'form.submit': 'Submit',
    'mine.heading': 'My requests',
    'mine.hint': 'Polled every 3 seconds from GET /requests/{id} (DynamoDB status projection).',
    'mine.empty': 'No requests yet.',
    'mine.pending': 'starting…',
    'mine.waitingNote':
      'The durable function is suspended now: no compute is billed while it waits (up to {minutes} minutes).',
    'mine.trySelfApprove': 'Try to approve it myself',
    'mine.trySelfApproveHint':
      'The requester IAM role has no permission on the decision API, so API Gateway rejects the call before any code runs.',
    'decision.by': 'Decided by',
    'decision.comment': 'Comment (optional)',
    'decision.approve': 'Approve',
    'decision.reject': 'Reject',
    'decision.deadline': 'expires around',
    'decision.requester': 'Requester',
    'approver.heading': 'Waiting for approval',
    'approver.hint':
      'GET /requests?status=WAITING_APPROVAL. Approving calls SendDurableExecutionCallbackSuccess and the execution resumes from its checkpoint.',
    'approver.empty':
      'Nothing is waiting. Sign in as a requester in another browser and submit one.',
    'history.heading': 'Results',
    'explain.summary': 'What happens behind this screen',
    'explain.1':
      'Sign-in: Cognito managed login (authorization code + PKCE). The identity pool exchanges the ID token for temporary IAM credentials of the role mapped to your group.',
    'explain.2':
      'Submit: the browser signs POST /requests with SigV4. StartRequest invokes the durable function asynchronously with the request ID as DurableExecutionName.',
    'explain.3':
      'Wait: waitForCallback stores a callback ID and suspends the function. Nothing runs (or is billed) until an approver decides or the timeout fires.',
    'explain.4':
      'Decide: SubmitDecision claims the decision in DynamoDB, then sends the callback. The workflow replays from its checkpoints and runs fulfill-request.',
  },
  ja: {
    'app.title': '承認ワークフロー デモ',
    'app.subtitle': 'Lambda durable functions · waitForCallback · IAM 認証 API',
    'lang.toggle': 'English',
    'auth.signIn': 'サインイン',
    'auth.signOut': 'サインアウト',
    'auth.prompt': '申請者または承認者のデモユーザーでサインインしてください。',
    'auth.noGroup': 'このユーザーは requesters / approvers のどちらのグループにも属していません。',
    'role.requester': '申請者',
    'role.approver': '承認者',
    'status.SUBMITTED': '受付',
    'status.WAITING_APPROVAL': '承認待ち',
    'status.DECISION_RECEIVED': '決定受信',
    'status.COMPLETED': '完了',
    'status.REJECTED': '却下',
    'status.EXPIRED': '期限切れ',
    'timeline.end': '完了 / 却下 / 期限切れ',
    'form.heading': '新規申請',
    'form.title': '件名',
    'form.amount': '金額',
    'form.key': 'Idempotency-Key(任意)',
    'form.keyPlaceholder': '例: req-0001(同じ値で再送すると冪等性を確認できる)',
    'form.submit': '申請する',
    'mine.heading': '自分の申請',
    'mine.hint': 'GET /requests/{id}(DynamoDB の状態投影)を 3 秒ごとに取得しています。',
    'mine.empty': 'まだ申請はありません。',
    'mine.pending': '開始中…',
    'mine.waitingNote':
      'durable function は停止中です。待機中(最長 {minutes} 分)は compute 課金が発生しません。',
    'mine.trySelfApprove': '自分で承認してみる',
    'mine.trySelfApproveHint':
      '申請者の IAM ロールには決定 API の権限がないため、コードが動く前に API Gateway が拒否します。',
    'decision.by': '決定者',
    'decision.comment': 'コメント(任意)',
    'decision.approve': '承認',
    'decision.reject': '却下',
    'decision.deadline': '期限の目安',
    'decision.requester': '申請者',
    'approver.heading': '承認待ち',
    'approver.hint':
      'GET /requests?status=WAITING_APPROVAL。承認すると SendDurableExecutionCallbackSuccess が呼ばれ、実行が checkpoint から再開します。',
    'approver.empty':
      '承認待ちはありません。別のブラウザで申請者としてサインインし、申請してください。',
    'history.heading': '結果',
    'explain.summary': 'この画面の裏で起きていること',
    'explain.1':
      'サインイン: Cognito マネージドログイン(認可コード + PKCE)。Identity Pool が ID トークンを、所属グループに対応する IAM ロールの一時認証情報に交換します。',
    'explain.2':
      '申請: ブラウザが POST /requests に SigV4 で署名。StartRequest が request ID を DurableExecutionName にして durable function を非同期起動します。',
    'explain.3':
      '待機: waitForCallback が callback ID を保存して関数を停止。承認者が決めるかタイムアウトするまで何も動かず、課金もされません。',
    'explain.4':
      '決定: SubmitDecision が DynamoDB で決定を確定させてから callback を送信。ワークフローは checkpoint から replay し、fulfill-request を実行します。',
  },
};

function currentLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'en' || saved === 'ja') return saved;
  } catch {
    // Storage can be unavailable (private mode); fall back to the browser language.
  }
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** UI language; also passed to the Cognito managed login page. */
export const lang = currentLang();
document.documentElement.lang = lang;

/** Translate a message key, substituting `{name}` placeholders. */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const template = messages[lang][key] ?? messages.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

export function toggleLanguage(): void {
  try {
    localStorage.setItem(LANG_KEY, lang === 'ja' ? 'en' : 'ja');
  } catch {
    // Ignore: the toggle simply does not persist.
  }
}
