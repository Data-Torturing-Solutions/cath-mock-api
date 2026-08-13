# cath-mock-api

An implementation of the [Court and Tribunal Hearings Service API
requirements](https://www.gov.uk/government/publications/hmcts-third-party-courts-and-tribunals-data-licence/court-and-tribunal-hearings-service-application-programming-interface-api-requirements),
on Cloudflare Workers + D1 + R2.

Two Workers, deployed separately:

| | What it is |
|---|---|
| **`cath-receiver`** | The four endpoints HMCTS require you to expose, plus the token endpoint they fetch credentials from. Not a mock — this *is* the onboarding deliverable. |
| **`cath-simulator`** | A fake CaTH that pushes realistic publications at the receiver, including the awkward parts. Lets you prove the receiver works before asking to be onboarded. |

> **CaTH pushes to you. You do not pull from CaTH.** There is no HMCTS endpoint
> to call. You give them a base URL and auth details; they POST, PUT and DELETE
> at you and expect a 2xx.

---

## Quick start

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npm run db:local
```

```bash
npm run dev
```

Then, in a second terminal, point the simulator at it:

```bash
npm run dev:simulator
```

```bash
curl -X POST "http://localhost:8788/run?scenario=daily&count=40"
```

```bash
curl -H "x-admin-token: local-dev-admin-token" http://localhost:8787/admin/stats
```

---

## The contract

| Method | Path | Purpose | Body |
|---|---|---|---|
| `GET` | `{BASE_PATH}` | Health check — HMCTS test the connection | none |
| `POST` | `{BASE_PATH}` | New publication | `multipart/form-data` |
| `PUT` | `{BASE_PATH}/{publicationId}` | Superseded publication | `multipart/form-data` |
| `DELETE` | `{BASE_PATH}/{publicationId}` | Manually deleted in CaTH | none |
| `POST` | `/oauth/token` | `client_credentials` → bearer token | form-encoded |
| `GET` | `/admin/*` | Inspection (sensitivity-gated, not part of the contract) | none |

Parts: `metadata` (mandatory, JSON), `payload` (optional JSON, literal `null` for
flat files), `file` (optional, `{uuid}.{ext}`).

Success is **200 with an empty body**. CaTH ignores the body; only the status
matters.

---

## Decisions worth knowing about

### Idempotency, and why every path is content-hashed

Any non-2xx makes CaTH retry **three more times**, so the same `publicationId`
legitimately arrives four times. Each write hashes the metadata plus the
artefact bytes:

- same id, same hash → `unchanged`, no version bump, `last_seen_at` touched
- same id, different hash → `superseded`, version+1, **both** artefacts kept in R2
- new id → `created` at version 1

Proven by the conformance suite and by the simulator's `retry_proof` scenario.

### What we cannot replicate, and do not pretend to

CaTH decides supersession on five fields: *provenance, type, location ID,
language, content date*. **Provenance and location ID are not in the metadata
block**, so the rule cannot be reconstructed from what arrives. We key on
`publicationId` and keep the visible four-field tuple as a secondary index
(`idx_supersede`) for investigation only.

### `PUT` for an id we never received a `POST` for

The spec doesn't say. **We accept it**, create at version 1, and record
`created_via = 'PUT'`. Rejecting would mean three retries and then permanent
loss of a publication — see below.

### Nothing is ever dropped, even when rejected

A publication we 4xx four times is gone forever; CaTH does not re-send later.
Every 4xx is therefore *potentially lost open-justice data*. So:

- the delivery is logged **before** validation runs
- the raw body is written to R2 under `_quarantine/` and a `quarantine` row is
  created, regardless of the status we return
- `VALIDATION_MODE=lenient` flips rejections into `200 accepted_quarantined` if
  you would rather never fail a push at all

`strict` is the default because the conformance suite asserts the spec's
behaviour; `lenient` is there for the day a validation bug is dropping real data.

### Expiry is swept, not notified

You get a `DELETE` only for **manual** deletions in CaTH. Passing `displayTo` is
never notified, so an hourly cron ages content out to `state='expired'`.

### The health check stays open in `required` mode

`GET {BASE_PATH}` returns 200 without a token even when `AUTH_MODE=required`.
HMCTS test the connection before auth is agreed, and the response discloses
nothing. Every other verb is gated.

---

## Auth

The direction is inverted from the usual: **HMCTS is the client, you are the
identity provider.**

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=…&client_secret=…&scope=cath.publish
```

HS256 JWTs signed with Web Crypto — no libraries. `exp`, `iss`, `aud` and
`scope` are checked on every write; `alg` substitution and `alg: none` are
rejected explicitly; client secrets are compared in constant time. HTTP Basic
client authentication works too.

### `AUTH_MODE`

| Mode | Behaviour |
|---|---|
| `off` | No auth. Everything accepted. |
| `optional` | Bearer validated **if present**; accepted either way, `auth_used` recorded. |
| `required` | Missing or invalid bearer → `401`. |

**It fails closed.** Unset, misspelled, or any unrecognised value — `Required`,
`none`, `""` — is treated as `required`. A typo in an env var must not silently
open the API. There is a test for each of those spellings.

`optional` is what makes migration workable: the simulator can push
unauthenticated while a real CaTH connection uses tokens, and `auth_used` on
both `publications` and `deliveries` tells you which is which.

### Reads are gated by sensitivity, independently of `AUTH_MODE`

`PRIVATE` and `CLASSIFIED` publications are **never** served to an
unauthenticated reader, even with `AUTH_MODE=off`. Listing shows `PUBLIC` only;
fetching one directly returns `404` rather than `403`, so the endpoint does not
confirm that a non-public publication exists; `/admin/quarantine` requires auth
outright.

With simulator data this is harmless. The moment a real CaTH feed points at this
Worker, an open read path is an open-justice breach — so the safe behaviour is
wired in from day one rather than added later.

---

## Reference data

Nothing here is hand-written. All of it is regenerated from HMCTS source:

| File | Source | Count |
|---|---|---|
| `vendor/list-types.json` | `pip-data-models` → `ListType.java` | **102** list types |
| `vendor/schemas/*.json` | `pip-data-management` → `resources/schemas/` | **42** schemas |
| `vendor/venues.json` | Find a Court or Tribunal (OGL v3) | **404** real venues with real addresses |
| `src/shared/generator/schemas.ts` | generated barrel + list-type → schema map | 99 direct, 3 fallback |

```bash
npm run refresh
```

Re-run monthly. Schema drift is the top risk on this integration — HMCTS add
list types and change schemas without notice, and the spec says so explicitly.
**If a test goes red after a refresh, HMCTS changed something. Read it, don't
silence it.**

> The plan estimated 104 list types; the current `master` of `pip-data-models`
> has 102. The extractor parses the real enum, so the count follows upstream.

### Two defects in HMCTS's published schemas

Both are pinned by tests in `test/unit/generator.test.ts` so a refresh tells you
the day they're fixed:

1. **Three schemas are not valid ECMA-262.** `master_schema.json`,
   `magistrates_public_list.json` and `magistrates_standard_list.json` carry
   Java regex syntax — an inline `(?s)` dotall flag, and a `\-` identity escape
   that unicode-mode JavaScript rejects. Not the instances: **the schemas**. Any
   JavaScript validator throws while *compiling* them. `src/shared/generator/schema-compat.ts`
   rewrites both exactly (`(?s)` → `[\s\S]`, `\-` → `\x2d`).

2. **One schema fails its own meta-schema.** `cop_daily_cause_list.json`
   declares `"examples": "<a string>"` where JSON Schema 2020-12 requires an
   array.

Worth raising with HMCTS: as shipped, these are unusable to any consumer that
isn't on the JVM.

---

## The generator

Payloads are generated **from the 42 real schemas**, so they validate by
construction, with a domain vocabulary layered on top — a schema-valid payload
full of `"string"` tells you nothing about whether the receiver handles a real
court list.

The walker covers all four shapes HMCTS actually publish: the deep
`document → venue → courtLists → courtHouse → courtRoom → session → sittings →
hearing → case` tree, flat arrays of hearing rows, the PDDA
`DailyList`/`FirmList`/`WarnedList` wrappers, and the magistrates
`document`-rooted lists. It resolves `$ref`, and flattens `allOf`/`oneOf`/
`anyOf`/`if-then-else` before generating — HMCTS lean on conditional subschemas
(the SJP press lists say *"if partyRole is ACCUSED then individualDetails or
organisationDetails, else organisationDetails"*).

Where realism matters:

| Field | Approach |
|---|---|
| `venueName`, `courtHouseName` | **Real** — 404 venues with real addresses from FaCT |
| `courtRoomName` | `Courtroom 1`–`12`, plus `Court 3 (Annexe)`, `Remote Hearing Room` |
| `sittingStart` / `sittingEnd` | Clustered at 10:00 and 14:00, not uniform random (asserted by a test) |
| `caseNumber` | Jurisdiction-shaped: civil `24YX01234`, ET `1234/2025`, crime URN-like |
| `hearingType` | Real vocabulary per jurisdiction |
| `judiciary` | Real titles (`District Judge`, `HHJ`, `Employment Judge`), invented surnames |
| `caseName` | **Fully synthetic**, always sentinel-prefixed |

Every payload is deterministic from its seed, so a failure is reproducible.

### On generated people

Court lists carry the names of real defendants, parties and judges. A generator
producing plausible British names next to plausible criminal charges is
manufacturing defamatory-looking records about people who may exist — and once
that leaks into a bucket, an index or a screenshot it is a real problem, not a
theoretical one.

- Surnames come from a deliberately absurd pool (`Testerton`, `Fakeworth`,
  `Placeholder-Smith`) — never a census list
- Every case name is prefixed `[TEST]`
- Every payload carries `"provenance": "SIMULATOR"`
- Criminal case names use **coined companies**, not synthetic people:
  `[TEST] R v Cygnet Holdings Ltd`
- The Crown PDDA lists are the only schemas carrying defendant personal details
  (forename, surname, DOB, age, sex, nationality, prisoner ID) beside charges
  and offence codes. Every offence there is `[TEST] Placeholder offence —
  simulator data, not a real charge`, and dates of birth are a fixed constant
  rather than a plausible varying value. There are tests for both.
- **The R2 bucket must never be public.**

---

## The simulator

```bash
curl -X POST "http://localhost:8788/run?scenario=<name>&count=<n>&seed=<string>"
```

| Scenario | What it does |
|---|---|
| `daily` | A day's publications at the configured chaos rate |
| `supersede` | Reads back what the receiver holds and PUTs replacements |
| `delete` | Deletes real rows, plus one id the receiver has never seen |
| `flat_files` | PDF, CSV and HTML, each with a null payload part |
| `future_dated` | The 1AM UTC release burst |
| `welsh` | English + Welsh + bilingual on identical key fields — none may supersede another |
| `retry_proof` | The same publication four times |
| `chaos` | 13 deliberately malformed pushes |
| `health` | The connection test |

Cron: `0 1 * * *` runs `future_dated` → `daily` → `welsh` (the 1AM release);
`0 9,13,16 * * *` runs `supersede` → `delete` → `flat_files`.

**Retry semantics are real.** On any non-2xx the simulator retries exactly three
more times, as CaTH does, so idempotency is proven rather than assumed.

The 13 chaos cases each declare what a correct receiver should do — most are
`reject`, but `wrong_file_mime`, `oversized_file`, `extra_unexpected_part`,
`no_payload_no_file` and `display_to_before_display_from` are all `accept`,
because rejecting them would cost a publication for no good reason.

---

## Tests

```bash
npm test
```

**70 tests.** Two suites, because they need different runtimes:

- `npm run test:unit` (17) — the generator, in Node. Ajv compiles validators
  with `new Function`, which workerd blocks, so schema conformance is asserted
  here. Every one of the 102 list types × 3 sizes validates against its real
  HMCTS schema.
- `npm run test:worker` (53) — the receiver, in **workerd with real D1 and R2
  bindings**, not mocks. Conformance clause by clause, plus the full
  `{off, optional, required, unset, typo, plausible-but-wrong}` ×
  `{no token, bad token, good token}` auth matrix.

Conformance coverage, against the spec:

| Test | Expects |
|---|---|
| `GET` BaseURL | 200, in every auth mode |
| `POST` valid | 200, empty body, row created |
| `POST` ×4 identical | 1 row, version 1, 4 audit entries |
| `PUT` existing | version 2, **both** R2 objects retained |
| `PUT` unknown id | accepted, `created_via='PUT'` |
| `DELETE` existing | `state='deleted'`, artefact retained |
| `DELETE` unknown id | 200 |
| Metadata missing | 4xx, logged, **body quarantined** |
| Bad enum value | 422, names the field |
| Unknown list type | 422, tells you to run `npm run refresh` |
| `file` part with PDF | stored at `v1.pdf`, MIME recorded |
| Welsh + English + bilingual | three live rows, none superseded |
| `displayTo` passed | `state='expired'` via cron, no DELETE received |
| Authorization header | never written to `deliveries` |

> On Windows, `isolatedStorage` is disabled in `vitest.worker.config.ts` —
> per-test SQLite snapshots can't be unlinked while workerd holds them (EBUSY).
> Every test keys on a unique `publicationId`, so shared storage is safe.

---

## Storage

**D1 (`cath-db`)** — `publications` (current state, keyed on `publicationId`),
`deliveries` (every request, including retries, rejects and unauthenticated
attempts), `quarantine` (bodies we could not accept).

`deliveries` is the point of the whole exercise. When something goes wrong after
onboarding, it is your evidence. Headers are captured through an allowlist;
`Authorization` is recorded as *present* but never by value.

**R2 (`cath-artefacts`)** — versioned, so a supersede never destroys what it
replaced:

```
{listType}/{YYYY-MM-DD}/{publicationId}/v{n}.json
{listType}/{YYYY-MM-DD}/{publicationId}/v{n}.pdf
{listType}/{YYYY-MM-DD}/{publicationId}/v{n}.metadata.json
_quarantine/{YYYY-MM-DD}/{publicationId}/{timestamp}/…
```

The metadata sidecar is written on every version: it's the evidence that we
received exactly what CaTH says it sent.

---

## Deploying

```bash
npx wrangler d1 create cath-db
```

Put the returned `database_id` in `wrangler.receiver.toml`, then:

```bash
npx wrangler r2 bucket create cath-artefacts
```

```bash
npm run db:remote
```

```bash
npx wrangler secret put JWT_SIGNING_KEY -c wrangler.receiver.toml
```

```bash
npx wrangler secret put CATH_CLIENT_SECRET -c wrangler.receiver.toml
```

```bash
npm run deploy
```

The simulator is deployed **separately and deliberately** — the receiver must be
pointable at the real CaTH without the simulator anywhere near it:

```bash
npm run deploy:simulator
```

### Continuous deployment

`.github/workflows/deploy.yml` runs the test suite on every push and pull
request, and on a push to `main` deploys the receiver and the simulator as two
separate jobs. It needs two repository secrets:

| Secret | What |
|---|---|
| `CLOUDFLARE_API_TOKEN` | A scoped token with Workers, D1 and R2 edit rights |
| `CLOUDFLARE_ACCOUNT_ID` | The target account |

Worker **secrets** (`CATH_CLIENT_SECRET`, `JWT_SIGNING_KEY`, `ADMIN_TOKEN`,
`CLIENT_SECRET`, `SIM_ADMIN_TOKEN`) are **not** set by CI — put them in with
`wrangler secret put` once, so live credentials never pass through the pipeline.
The migration step needs the real `database_id` in `wrangler.receiver.toml`.

---

## Onboarding readiness

Section 5 of the spec asks for two things:

1. **Base URL** — e.g. `https://cath.opencourtdata.uk/publications`
2. **Auth details** — client ID, client secret, scope, token URL

Before you send them:

- [ ] `npm test` green
- [ ] A week of simulator traffic sitting in `deliveries`
- [ ] `AUTH_MODE=required` **set and deployed**
- [ ] A *dedicated* client ID and secret generated for HMCTS — reuse nothing
- [ ] The R2 bucket confirmed non-public
- [ ] The simulator not pointed at the production receiver

The auth details must be GPG-encrypted to the public key HMCTS give you, from
the address you signed up with. **Verify the key fingerprint out of band first.**
That step is a manual two-minute job and stays manual — handling live
credentials is not something to hand to an assistant.

---

## Open questions for HMCTS

The published spec doesn't answer these, and the answers change what you build:

- Expected peak throughput and burst shape — matters for Worker limits
- Whether a `PUT` can arrive for a `publicationId` you never received a `POST`
  for (we accept it; see above)
- Maximum flat-file size — the simulator's `oversized_file` case pushes 6 MB
- Whether they honour `Retry-After`, or retry on a fixed schedule
- Whether the three retries are immediate or spread over time
- Source IP ranges, if you want IP allow-listing on top of OAuth

And two of our own, from building this:

- Are the Java-only regexes in `master_schema.json` and the magistrates schemas
  intentional? They make those schemas uncompilable off the JVM.
- Is `provenance` ever exposed to third parties? Without it, supersede logic
  cannot be replicated by anyone receiving the feed.
