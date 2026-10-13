# Financial boundary proposal — design only

This draft does not enable financial operations or claim that balances authorize spending.
The runtime still has unresolved spending, timeout, retry, isolation and accounting risks.
Do not run it with real credentials, funds or remote services to validate this change.

## Scope of this change

Implemented: use one output token ceiling for estimation and dispatch; reject invalid
ceilings; require policy engine and turn context in executeTool; re-check canonical
self-edit targets. Dependency-free tests isolate source functions with fake transports.
These tests do not load the full runtime or prove integration, confinement or budget safety.
Fork CI runs only those tests. The inherited full-suite and registry-audit jobs are scoped
to the upstream repository because they install dependencies and include wallet generation.
Timeout and audit failures remain failures in those inherited jobs.

## Proposed ownership and boundaries (not implemented)

1. An authenticated human approval service owns permission: operation ID, principal,
   scope, beneficiary, currency, maximum total exposure, expiry and one-time consumption.
   Historical receipts, an observed balance, a model decision and a service token are
   not approval. The executor must not edit this service or approval records.
2. A persistent ledger owns reservations and actual/unknown exposure. Within one database
   transaction, validate approval and limits, consume approval and reserve the worst-case
   cost. All producers share that ledger. Reject missing approval, invalid currency/amount,
   unavailable ledger, exceeded limits or insufficient policy reserve before any effect.
3. A separate constrained dispatcher owns external effects. It requires a committed
   reservation, uses the persisted business-operation idempotency key and records attempt
   identity before sending. No arbitrary executor access to signing keys or provider credentials.
4. Reconciliation owns external receipts, actual cost and uncertainty resolution. Receipts
   establish evidence of an effect, not permission for another effect. Stable provider IDs
   and ledger operation IDs must be correlated without exposing secrets in logs.

States: reserved -> started -> settled; started -> unknown -> settled/released after
verified reconciliation. A reservation may be released before dispatch if no effect occurred.
Unknown exposure must survive process crashes, restart, backup/restore and day changes.
A timeout is not evidence of zero cost. Never automatically resend an uncertain operation
with a new idempotency key. Actual cost above reservation is retained and blocks further
spending for the affected scope until reviewed, rather than truncating the accounting.
SQLite BEGIN IMMEDIATE is a possible single-host transaction boundary; multi-host deployment
requires a shared transactional database. No database technology makes an external charge
atomic with the local transaction: recovery and reconciliation are mandatory.

## Coverage required before activation

- Inference: exact dispatched ceiling, conservative full-input/tool-schema accounting,
  provider/model price version, retries and uncertain responses.
- x402: inspect challenge and reserve its maximum amount before signing; never record a
  nominal zero as proof that no payment occurred. Reject unsupported pricing/challenge terms.
- fund_child and transfer_credits: same approval/reservation contract, stable recipient and
  currency. The existing per-call transfer idempotency key is not durable business identity.
- Bootstrap/inline top-up, sandbox, domain registration and any paid tool must use the same
  dispatcher; direct helper calls must not bypass the boundary.
- Recovery workers may reconcile existing operations but cannot create new spending approval.

Do not patch x402 or fund_child merely by adding post-effect accounting: that cannot enforce
pre-effect permission or reserve capacity. An in-memory mutex is not a multi-process ledger.
Integrate with an already-authoritative ledger where one exists; do not create parallel budgets.

## Required future synthetic acceptance tests

Multiple processes racing one remaining approval; crash before/after reservation, dispatch
and receipt; lost acknowledgement; timeout then retry; duplicate/out-of-order callbacks;
day rollover with unknown exposure; restore with outstanding exposure; overrun freeze;
x402 amount above approval; fund_child through an alternate entrypoint; revoked/expired
approval; database failure; malformed currency/amount; denial without any transport call.
Use provider fakes and synthetic identities. None of these future tests or ledger changes
is represented as implemented by this draft.

## Remaining security and compatibility limits

Canonical path checks still depend on the local filesystem; remote enforcement and TOCTOU
resistance need executor-side controls. Shell, package installation and self-modification
must be isolated from credentials and authorization code. The optional TypeScript parameters
remain for compatibility, but missing policy/context now returns POLICY_CONTEXT_REQUIRED;
callers relying on optional policy must explicitly supply their policy and turn state.
Existing tests that assumed policy-free execution may need deliberate migration. There is
no fallback allow policy and no dummy financial approval introduced here.

The budget fix does not solve concurrent check-then-record, uncertain cost after timeout,
full input token estimation, durable idempotency or spending coverage. Full typecheck/build
and the original suite were not run in this restricted validation. CI success for the offline
job is not evidence that the agent is safe to fund or deploy.
