# Spendify (repo: easyreceipts) — contesto di progetto

Documento di handoff. Ultimo aggiornamento: **2026-09-26**.

Il progetto è **live e con utenti reali e pagamenti veri**. Ogni modifica a
`prod` tocca dati di produzione. Leggi la sezione "Trappole note" prima di
toccare infrastruttura.

---

## 1. Che cos'è

PWA per fotografare scontrini, estrarne i dati con OCR ed esportarli in CSV o
verso YNAB. Backend serverless su AWS, frontend React generato con Lovable.

**Architettura** (SAM, un solo `template.yaml`, due stack):

```
Cognito Hosted UI  →  HttpApi (JWT)  →  Lambda `api` (Python 3.11)
                                             ↕
                                      DynamoDB (5 tabelle)

S3 original/  →  Lambda `preprocess`  →  S3 processed/  →  Lambda `ocr`
                 (solo copy_object)                        (Textract AnalyzeExpense)
                                                                  ↓
                                                           S3 ocr/<sub>/<id>.json
```

- **API**: una sola Lambda, routing manuale a stringhe in `handler()`
  (`src/api/app.py`). Non c'è framework.
- **Auth**: flusso `authorization_code` **senza PKCE**; lo scambio del codice
  lo fa **il browser direttamente contro Cognito** (`frontend/src/lib/auth.ts`).
  L'endpoint backend `POST /auth/exchange` esiste ma **non è usato da nessuno**.
- **Billing**: Stripe Checkout + Portal + webhook. Segreti in SSM sotto
  `/spendify/{env}/stripe/*`.
- **Landing** (`spendifyapp.com`): sito statico separato, **non gestito da
  CloudFormation**. Bucket e distribuzioni CloudFront creati a mano.

## 2. Ambienti

| | dev | prod |
|---|---|---|
| Stack | `easyreceipts-dev` | `easyreceipts-prod` |
| API | `uwpd0mb0ji.execute-api.eu-central-1.amazonaws.com` | `x1a3fdrifd.execute-api.eu-central-1.amazonaws.com` |
| App | `d33xe02gdlyt8z.cloudfront.net` | `app.spendifyapp.com` (dist. `EAYBWZ0Q546AD`) |
| User pool | `eu-central-1_p1kMjViwJ` | `eu-central-1_hhIC2qjWQ` |
| Scontrini | ~14 | **160** |
| Utenti | 1 | **7** (1 abbonato Stripe attivo) |

Landing: bucket `spendify-landing-prod-408959241421-eu-central-1`,
distribuzione `E32IUXP48RU6GA` (alias `spendifyapp.com` + `www`).
Account AWS `408959241421`, regione `eu-central-1`.

## 3. Comandi

```bash
./scripts/deploy_backend.sh {dev|prod}   # sam build --use-container + sam deploy
./scripts/deploy_ui.sh {dev|prod}        # build frontend + S3 + invalidazione
./scripts/deploy_landing.sh prod         # solo prod, dev è bloccato di proposito
./scripts/check_users.sh {dev|prod}      # utenti Cognito

python3 test/test_list.py                # unico test funzionante (offline, serve boto3)
```

**Genera sempre il changeset prima di toccare prod:**

```bash
sam deploy --config-env prod --no-execute-changeset
aws cloudformation describe-change-set --change-set-name <arn> --region eu-central-1
```

**Testare endpoint autenticati senza browser** — invocando la Lambda con le
claim JWT iniettate. È l'unico modo automatizzabile: `USER_PASSWORD_AUTH` è
disabilitato sui client Cognito e non esiste un client di test.

```bash
cat > ev.json <<EOF
{"version":"2.0","rawPath":"/receipts","headers":{"origin":"https://app.spendifyapp.com"},
 "requestContext":{"http":{"method":"GET"},
 "authorizer":{"jwt":{"claims":{"sub":"<USER_SUB>","email":"<EMAIL>"}}}}}
EOF
aws lambda invoke --function-name easyreceipts-prod-api --region eu-central-1 \
  --payload fileb://ev.json out.json && cat out.json
```

## 4. Trappole note

Cose che sembrano a posto e non lo sono. Verificate sul sistema reale.

**La landing è fuori da CloudFormation.** Bucket e due distribuzioni creati a
mano. Esiste anche una distribuzione orfana `EILXB8QWT1QZX` senza alias che
punta allo stesso bucket: costa e non serve. Portare la landing sotto IaC è
lavoro ancora da fare.

**`rsync --delete` nella pubblicazione della landing.**
`scripts/publish_landing_from_lovable.sh` sincronizza l'output del build di
Lovable dentro `landing/` cancellando tutto ciò che il build non produce.
Nel febbraio 2026 ha eliminato `privacy.html`, `terms.html`, `ynab.html`,
`/en/`, `/it/`, che sono rimasti **403 per sette mesi**. Il bucket non ha
versioning, quindi non erano recuperabili da S3. Ora esiste una lista
`KEEP_FILES` nello script: **ogni file non prodotto da Lovable va aggiunto lì**,
altrimenti sparirà alla prossima pubblicazione.

**La drift detection di CloudFormation mente.** Non confronta le proprietà
assenti dal template. L'alias `app.spendifyapp.com` e il certificato ACM erano
stati aggiunti a mano sulla distribuzione: la drift detection diceva `IN_SYNC`,
ma il successivo `sam deploy prod` li avrebbe rimossi mandando offline il
dominio. Ora sono nel template (`UiAliases`, `UiCertificateArn`).
**Regola: se lo configuri a mano su una risorsa gestita da CFN, mettilo anche
nel template.**

**`requirements.txt` non era pinnato.** La produzione girava `stripe 14.3.0`,
ma un rebuild risolveva a `15.6.1` — salto di major version dell'SDK di
pagamento come effetto collaterale di un deploy infrastrutturale. Ora tutto è
pinnato. **Non sbloccare le versioni senza testare checkout, portal e webhook.**

**La CORS a livello di API Gateway non funziona.** `aws apigatewayv2 get-api`
restituisce `CorsConfiguration: null`: SAM genera un `x-amazon-apigateway-cors`
malformato (`{Fn::Split: [...]}` invece di `{allowOrigins: [...]}`) e API
Gateway lo ignora. Funziona tutto solo perché la Lambda gestisce a mano le
OPTIONS e i propri header. **Il parametro `UiAllowedOrigins` a livello API non
ha alcun effetto**; conta solo `CORS_ORIGINS` letto dalla Lambda.

**La GSI1 è incoerente.** `_create_receipt` scrive `GSI1PK` =
`USER#{sub}#STATUS#{status}` e `GSI1SK` = `createdAt`, ma `_update_receipt`
(`app.py:952`) scrive `gsi1pk`/`gsi1sk` **minuscoli**, che non alimentano
nessun indice. Su tutti i 160 item di produzione `GSI1PK` è congelato a
`#STATUS#NEW`. Funziona come indice per-utente **solo per coincidenza**: non
costruirci sopra senza prima fare un backfill.

**Tipi incoerenti su importi.** `_update_receipt` salva `total` e `vat` come
**stringhe**, mentre l'OCR li inferisce come numeri. Il frontend compensa con
`parseFloat(String(...))` sparsi. I 160 record esistenti hanno stringhe.

**Tabelle create ma mai usate.** `USAGE_TABLE` e `TAGS_TABLE` hanno 0 item e
non sono referenziate da nessun sorgente: nessun metering, nessuna quota, costo
Textract illimitato per utente. `src/api/categories.py` usa `CATEGORIES_TABLE`
che non esiste in nessun ambiente (file interamente morto; la logica categorie
è inline in `app.py`). `src/api/handlers_me.py` importa 4 simboli inesistenti
da `entitlements`: `ImportError` garantito se mai usato.

**SSM duplicati.** Esistono sia `/spendify/prod/stripe/*` (usati) sia
`/easyreceipts/prod/stripe/*` (orfani). Attenzione durante le rotazioni.

**Nessun allarme, nessuna retention sui log.** I log group non hanno scadenza.
Dichiararli in CFN fallisce perché esistono già: serve un resource import.

---

## 5. Stato al 2026-09-25

### Fatto e verificato in produzione

**`GET /receipts` restituiva 50 scontrini su 156.** La query leggeva una sola
pagina DynamoDB con `Limit=50`, e siccome la sort key è `RECEIPT#<uuid4>` non
erano nemmeno i 50 più recenti: 50 a caso in ordine di UUID. **106 scontrini
erano invisibili nell'app e assenti da ogni export.** Ora `_list_receipts`
percorre l'intera partizione con `LastEvaluatedKey` e ordina per data nella
Lambda. Latenza a caldo scesa da picchi di 3880 ms a ~194 ms mediani, perché
sono sparite fino a 156 `head_object` su S3 per richiesta.
Cap di sicurezza a `LIST_MAX_ITEMS = 2000` (~1 MB contro i 6 MB di API
Gateway) **segnalato** in risposta con `truncated`, non silenzioso.
Test di regressione: `test/test_list.py`.

**Nessun backup.** PITR era `DISABLED` su tutte le tabelle prod e non c'era
protezione da cancellazione. Ora entrambi attivi (deletion protection solo su
prod).

**Il prossimo deploy prod avrebbe fatto cadere il dominio.** Vedi "drift
detection" sopra. Risolto.

**Pagine legali offline.** `privacy.html` e `terms.html` rispondevano 403 —
problema di compliance con Stripe attivo e utenti UE. Ripristinate, con
guardie negli script che impediscono di ripubblicare senza di esse.

**SEO — le uniche pagine con contenuto erano irraggiungibili.**
`/ynab-receipts/` e `/receipt-to-csv/` davano **403 dal 2026-02-24** pur
essendo nel sitemap. Causa: origin S3 REST dietro OAI, e CloudFront applica
`DefaultRootObject` solo a `/`, quindi `/path/` chiedeva a S3 una chiave
inesistente e l'OAI trasformava il 404 in 403. Risolto con una CloudFront
Function viewer-request (`infra/cloudfront/landing-router.js`) che riscrive
`/path/` in `/path/index.html`, manda in 301 i vecchi URL e collassa `www`
sull'apex. Validata con `aws cloudfront test-function` su 14 casi prima della
pubblicazione.

**Favicon.** Google mostrava il logo Lovable. Non era cache: `/favicon.ico`
era davvero il cuore di Lovable. La pagina dichiarava l'icona giusta, ma era
**694×677, non quadrata**, e Google in quel caso ripiega sulla root. Generate
icone quadrate corrette e aggiunte a `KEEP_FILES`.

### Commit (tutti su `origin/main`)

```
827093e fix(seo): cross-link the content pages and fix their social previews
63cd618 docs: record the SEO baseline and what to re-measure from 2026-10-09
26ac441 fix(seo): serve the Spendify favicon instead of Lovable's
5a40457 test: add offline regression test for GET /receipts pagination
cf1abce fix(seo): make the landing's content pages reachable
8c8b38b chore: gitignore python bytecode caches
1214c98 fix(api): return every receipt from GET /receipts instead of an arbitrary 50
ddd0dfc chore(scripts): make check_users.sh runnable
402501c feat(infra): enable PITR/deletion protection and CloudFront alias in template
16e9e88 fix(api): pin python dependencies, drop dead files from the lambda bundle
8183109 fix(landing): restore privacy/terms and prevent them being wiped again
0cf88e4 chore(landing): sync from lovable
```

### Repo e produzione allineati (2026-09-25, sera)

Landing e UI dell'app sono stati pubblicati con tutto ciò che era in repo:
link reciproci, home prerenderizzata, titolo e FAQ di `/receipt-to-csv/`,
`noindex` sull'app. Le risorse JS/CSS della UI erano identiche byte per byte
a quelle live (verificato prima del deploy), quindi il deploy della UI ha
cambiato solo `index.html` e `robots.txt`. **Il backend non è stato toccato**
e resta quello del 2026-09.

### YNAB: OAuth in corso (branch `feat/ynab-oauth`, NON in produzione)

YNAB ha rifiutato l'app per la lista "Works with YNAB" (thread del 2026-02-23/25
con help@ynab.com): chiedeva il **Personal Access Token** dell'utente, vietato
dai loro Termini. Chiedono anche una Privacy Policy conforme. Dela ha detto di
rispondere al thread per "scongelare" la richiesta *API OAuth Community App*.

**Fatto (in locale, testato offline; dev deployato senza credenziali):**
- `src/api/ynab.py` + rotte `/ynab/*` in `app.py`: OAuth authorization code +
  PKCE + `state` monouso, token cifrati con KMS (`YnabTokenKey`, legata a
  `userId`), refresh con protezione dalle race, export lato server con
  `import_id = receiptId` (un retry non duplica). `test/test_ynab.py` (20 test).
- Frontend (nel **clone Lovable** `~/lovable-sources/lovable-frontend`,
  commit locali, non pushati): `YnabSettings.tsx`, `YnabCallback.tsx`
  (`/ynab/callback`), `lib/ynab.ts` riscritto, Export/Confirmation/Settings
  aggiornati, pulizia del token vecchio da `localStorage`.
- Privacy Policy riscritta (sez. 6), disclaimer "not affiliated" nei footer,
  testi del flusso aggiornati. Home: commit locale nel repo landing
  (`~/spendify-landing-source/...`), non pushato.
- `scripts/delete_user_data.py`: cancellazione utente (dry run di default).
  La policy promette la cancellazione **entro 30 giorni**: va rispettata.
- Upload: `POST /receipts` firma per il `contentType` dichiarato e accetta solo
  JPEG/PNG (prima ogni PNG dava 403). **PDF non supportato**: misurato con
  Textract, il PDF a pagina singola passa, quello multipagina no (serve l'API
  asincrona, uno stato FAILED e un'anteprima). Da fare a parte.

**Stato prod (2026-09-26): il backend è già deployato** dal branch (chiave KMS
`YnabTokenKey` creata, rotte `/ynab/*` attive; `main` non lo contiene ancora, quindi
repo e prod divergono finché non si fa il merge). Interfaccia e landing di prod
sono ancora quelle vecchie. Mancano in SSM prod `client_id` e `client_secret`.

**Manca per andare live:** creare le app OAuth in YNAB (dev e prod) e mettere
`/spendify/{env}/ynab/client_id` (String) e `client_secret` (SecureString) in
SSM; test end-to-end su dev con un account YNAB vero; poi il rilascio.

**Ordine di rilascio (prod):** 1) `deploy_backend.sh prod` con changeset (crea
la chiave KMS, `Retain`); 2) push del repo Lovable dell'app e
`sync_frontend_from_lovable.sh`, poi `deploy_ui.sh prod`; 3)
`publish_landing_from_lovable.sh prod` (rebase del commit locale della landing);
4) merge di `feat/ynab-oauth` in `main`; 5) rispondere a YNAB. **Non deployare
la landing da questo branch prima del passo 1-2**: descrive un flusso che in
produzione ancora non c'è.

**Trappole scoperte:**
- `apiRequest` (frontend) tratta **ogni 401/403 come sessione scaduta** e
  slogga l'utente. Gli errori YNAB devono quindi usare altri codici: la
  riconnessione richiesta risponde **409**, mai 401.
- Regole di YNAB per il brand: "YNAB" nel nome dell'app o nel DNS solo se
  preceduto da "for" (`Receipt Scanner for YNAB`), e il disclaimer "We are not
  affiliated…" va sul sito.
- **Decisione aperta:** la home usa il badge ufficiale "Works with YNAB" prima
  dell'approvazione. Conviene toglierlo finché non arriva.
- Il clone Lovable dell'app non aveva il `noindex` pubblicato il 2026-09-25 (era
  solo nel monorepo): ora è nel commit del clone, altrimenti il sync lo avrebbe
  cancellato.

---

## 6. Lavoro aperto, per priorità

### P0 — ricavi e dati

**`NameError` in `billing.py:129`.** `except Exception:` seguito da
`print(..., repr(e))` con `e` non definito. Ogni errore Stripe diventa un
`NameError` non gestito → 500 generico, nessun log utile. **Una riga**, e
sblocca la diagnosi di qualsiasi checkout fallito.

**Le disdette Stripe non declassano l'utente.** `create_checkout_session` mette
`metadata.userId` sulla *sessione*, non su `subscription_data.metadata`. Il
webhook `customer.subscription.deleted` cerca `metadata.userId` sulla
*subscription* → sempre assente → **chi disdice resta `active` per sempre**.
Manca anche un fallback via `stripeCustomerId` (servirebbe una GSI) e la
gestione di `customer.subscription.updated` e `invoice.payment_failed`.

**Il trial non blocca nulla lato server.** `entitlements.is_premium_endpoint`
protegge solo `/exports/`, **route che non esiste**. Un utente con trial
scaduto continua a caricare, OCR-are ed esportare. L'unico deterrente è un
banner nel frontend.

**Upload rotto per PNG/HEIC.** L'URL presigned è firmato con `ContentType`
fisso `image/jpeg` (il frontend non passa `contentType`), ma
`uploadToPresignedUrl` invia `file.type` → `SignatureDoesNotMatch` **403**.
In più Textract non supporta HEIC (default delle foto iPhone) e `preprocess`
si limita a copiare rinominando `.jpg`.

### P1 — affidabilità

**Nessuna gestione degli errori OCR.** Se `analyze_expense` fallisce,
l'eccezione risale: lo scontrino resta `NEW`, non esiste stato `FAILED`, non
c'è DLQ né retry. `Processing.tsx` dopo 60 s **finge il successo** e porta a
un form vuoto.

**Sessione: logout ogni ora.** Si salva solo `id_token`, il `refresh_token`
viene scartato (`auth.ts:341`). Validity Cognito 60 min. In più `api.ts:60`
tratta *qualsiasi* errore di rete come sessione scaduta e forza il redirect al
login, perdendo il form in compilazione.

**Nessun metering né quota** (vedi tabelle inutilizzate).
**Nessun allarme CloudWatch, nessuna retention sui log, nessun DLQ.**
**Nessuna lifecycle sul bucket uploads**: 3 copie per scontrino, per sempre.
**Nessuna CI/CD**: deploy manuali; gli e2e Playwright sono committati in stato
fallito.

### P2

Tipi incoerenti su importi (migrazione dei 160 record), codice morto
(`categories.py`, `handlers_me.py`), risorse orfane, landing sotto IaC,
`/auth/exchange` mai usato e flusso OAuth senza PKCE, CloudFront senza header
di sicurezza, `str(e)` esposto al client in `app.py:1226`.

---

## 7. SEO — stato e decisioni

Dettaglio completo e baseline in **`docs/seo-revisit-2026-10-09.md`**.
Leggerlo prima di toccare contenuti.

**Non rimisurare né ottimizzare prima del 2026-10-09.** Il 2026-09-25 sono
cambiate cinque cose insieme; le posizioni precedenti non sono una base
valida. Le **query** però sono affidabili: erano le **posizioni** a essere
inquinate dal 403.

Baseline 3 mesi: **134 impression, 2 clic**. L'app vuota
(`app.spendifyapp.com/`) genera il **69% delle impression con CTR 0%**.
Domanda reale concentrata su un solo tema, in inglese:
`convert receipt photos to spreadsheet` e varianti (9 impression).

**L'Italia ha zero impression**, incluse le ricerche del brand: per questo la
versione italiana è stata rimandata, nonostante fosse la richiesta iniziale.
Se esistono ragioni di mercato che i dati non catturano, è una scommessa
legittima — ma oggi non è ciò che i numeri suggeriscono.

**Homepage prerenderizzata (2026-09-25).** Era una shell SPA vuota (1 carattere,
nessun `<h1>`). `scripts/prerender_landing.mjs` (Playwright, da
`e2e/node_modules`) inserisce l'HTML renderizzato in `dist/index.html` durante
`publish_landing_from_lovable.sh`, e a ogni build rimette le icone quadrate e
toglie l'`aggregateRating` inventato. `KEEP_FILES` ora protegge anche
`receipt-to-csv/index.html`, `ynab-receipts/index.html`, le og image e
`sitemap.xml`: vengono da `public/` di Lovable e il sync le avrebbe riportate
alla versione senza le correzioni SEO.

### Decisioni prese il 2026-09-25

- **`noindex, nofollow` sull'app**: pubblicato su `app.spendifyapp.com`
  (verificato su `/`, `/login`, `/receipts`). Non si poteva escludere la home
  tenendo `/login` (SPA con un solo `index.html`, `/login` aveva il CTR
  migliore: 6 impression, 1 clic). Le impression caleranno di circa il 69%
  (erano a CTR 0%): **non è una regressione**. `robots.txt` consente ancora il
  crawl di proposito, altrimenti Google non vedrebbe il `noindex`.
- **Titolo di `/receipt-to-csv/`**: ora `Convert Receipt Photos to Spreadsheet
  or CSV`.
- **FAQ di `/receipt-to-csv/`**: 5 domande con `FAQPage`, verificate nel codice.

Il 10/10 gli effetti di home, titolo, FAQ e `noindex` non sono separabili.

### Azioni manuali in Search Console (richiedono login)

- Sitemap → reinviare `sitemap.xml`
- Indicizzazione → Pagine → "Bloccata a causa di un accesso non autorizzato
  (403)" → **Convalida correzione**
- Controllo URL su `/ynab-receipts/` e `/receipt-to-csv/` → Richiedi
  indicizzazione

---

## 8. Convenzioni

- Commit in **inglese**, conventional commits (`fix:`, `feat:`, `chore:`,
  `docs:`, `test:`). Il corpo spiega **perché**, con i dati misurati.
- Prima di prod: changeset, ispezione, poi deploy. Mai `--auto-approve` alla
  cieca.
- Verificare sempre con dati reali prima di dichiarare qualcosa risolto.
- Segnalare esplicitamente quando repo e produzione divergono.
- Il frontend è **sincronizzato da Lovable**: le modifiche a `frontend/`
  possono essere sovrascritte dal prossimo sync
  (`scripts/sync_frontend_from_lovable.sh`).
