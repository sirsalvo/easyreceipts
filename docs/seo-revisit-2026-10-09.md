# SEO — rimisurare dal 2026-10-09

Promemoria operativo. Il 2026-09-25 sono stati corretti errori che rendevano
inaffidabili i dati di Search Console. Le posizioni registrate prima di quella
data **non sono una base valida per ottimizzare**: la pagina con più potenziale
rispondeva 403.

Rimisurare **non prima del 2026-10-09** (due settimane), per dare a Google il
tempo di riscansionare.

---

## Perché aspettare

Il 2026-09-25 sono cambiate più cose insieme:

- `/ynab-receipts/` e `/receipt-to-csv/` sono passate da **403 a 200**
  (erano irraggiungibili dal 2026-02-24, pur essendo nel sitemap)
- `/ynab.html`, `/en/`, `/it/` da 403 a **301** verso gli equivalenti attuali
- `www` → 301 verso il dominio apex
- favicon corretto (prima Google mostrava il logo Lovable)
- `Cache-Control` impostato su tutti gli oggetti
- **Homepage prerenderizzata** (aggiunta sempre il 2026-09-25, in serata):
  da 1 carattere di testo e nessun `<h1>` a 2356 caratteri e un `<h1>`;
  rimosso anche l'`aggregateRating` inventato dal JSON-LD. Verificato con
  "Testa URL live" in Search Console. Indicizzazione richiesta.
- **Titolo di `/receipt-to-csv/`** (deciso il 2026-09-25, dopo la home):
  da `Receipt to CSV – Convert Receipt Photos to Excel or Google Sheets` a
  `Convert Receipt Photos to Spreadsheet or CSV`, per allinearlo alla query
  con più domanda. Description e `<h1>` invariati. Sulla rimisurazione, gli
  effetti di home e titolo non sono separabili.
- **FAQ su `/receipt-to-csv/`** (stesso giorno): 5 domande con `FAQPage`
  JSON-LD (colonne del CSV, estrazione da rivedere, export selettivo per
  date, nessuna connessione bancaria, trial 14 giorni senza carta). Ogni
  affermazione è stata verificata nel codice (`Export.tsx`, `TRIAL_DAYS`).

Modificare ora anche titoli e testi significherebbe muovere due variabili
insieme e non poter attribuire l'effetto. Prima si lascia assestare, poi si
interviene sui contenuti.

---

## Baseline al 2026-09-25 (ultimi 3 mesi)

Export: `Performance-on-Search` e `Coverage`, Search Console.

**Totali:** 134 impression, 2 clic, CTR 1,5%.

**Indicizzazione:** 5 pagine indicizzate, 8 escluse. Tra le escluse,
3 per "Bloccata a causa di un accesso non autorizzato (403)" con
convalida **Non riuscita** — è il problema risolto il 2026-09-25.

### Pagine

| URL | Clic | Impression | Posizione |
|---|---|---|---|
| `app.spendifyapp.com/` | 0 | **92** | 29,9 |
| `spendifyapp.com/` | 1 | 16 | 12,9 |
| `spendifyapp.com/ynab-receipts/index.html` | 0 | 16 | 21,7 |
| `app.spendifyapp.com/login` | 1 | 6 | 24,5 |
| `www.spendifyapp.com/receipt-to-csv/index.html` | 0 | 12 | 41,1 |

Due cose da notare: l'app vuota genera il **69% delle impression** con CTR 0%,
e le pagine SEO erano indicizzate solo tramite `/index.html`, l'unico percorso
che non dava 403.

### Query con domanda reale

Tutte sullo stesso concetto — foto di scontrini verso foglio di calcolo:

| Query | Impression | Posizione |
|---|---|---|
| `convert receipt photos to spreadsheet` | 4 | 48,7 |
| `receipt photo to spreadsheet` | 2 | 57,0 |
| `receipt to spreadsheet` | 2 | 62,5 |
| `receipt to csv` | 1 | 48,0 |

Il resto (~17 impression) sono ricerche del brand, spesso storpiato:
`spendify`, `spificy`, `spentify`, `spendif`, `spicufy`, `splify`…

### Paesi

Stati Uniti 39, Vietnam 12, Bangladesh 7, India 7, Thailandia 6, Canada 6,
Nigeria 4, Spagna 4, Germania 3, Danimarca 1.

**L'Italia non compare: zero impression**, comprese le ricerche del brand.
È il motivo per cui la versione italiana è stata rimandata.

### Dispositivi

Mobile 31 impression, posizione 11,5 · Desktop 101 impression, posizione 35,2.

---

## Cosa fare alla rimisurazione

1. Verificare che la convalida dei 403 in Search Console risulti **riuscita**
2. Controllare se `/ynab-receipts/` e `/receipt-to-csv/` (URL puliti, senza
   `/index.html`) hanno sostituito le vecchie varianti nel report Pagine
3. Confrontare le posizioni sulle 4 query sopra
4. Verificare che il favicon nei risultati sia quello di Spendify

Solo dopo, intervenire sui contenuti.

### Ipotesi da verificare con i nuovi dati

Tre query su quattro dicono **"spreadsheet"**, non "CSV". Il titolo attuale è
*"Receipt to CSV – Convert Receipt Photos to Excel or Google Sheets"*: il
termine con più domanda è in fondo. Da valutare se anteporlo — ma solo con
dati puliti, altrimenti non si capisce cosa ha prodotto l'effetto.

---

## Decisione ancora aperta: noindex sull'app

`frontend/index.html` contiene `<meta name="robots" content="noindex">` e
`frontend/public/robots.txt` è stato aggiornato di conseguenza (commit
`cf1abce`), ma **non sono mai stati pubblicati**: l'interfaccia in produzione
è ferma al 2026-02-08.

Repo e produzione divergono. Il rischio concreto è che al prossimo
`deploy_ui.sh prod`, fatto per tutt'altro motivo, il `noindex` parta in
silenzio dentro un deploy che parlava d'altro.

Va deciso, non lasciato in sospeso:

- **Pubblicarlo** — chi cerca il brand trova la landing invece di una shell
  vuota. Si perdono però le impression su `/login`, che ha il CTR più alto
  del sito (16,67%). Essendo una SPA con un solo `index.html`, non è
  possibile escludere la home dell'app e tenere `/login`.
- **Annullarlo** — si lascia l'app indicizzabile, eventualmente migliorando
  titolo e descrizione.

In ogni caso: **quando sarà pubblicato, le impression caleranno di circa il
69%**. È corretto — erano impression a CTR zero — ma va messo in conto prima,
altrimenti sembrerà una regressione.

---

## Azioni in Search Console (manuali)

Da fare subito dopo il 2026-09-25, se non già fatte:

- Sitemap → reinviare `sitemap.xml`
- Indicizzazione → Pagine → "Bloccata a causa di un accesso non autorizzato
  (403)" → **Convalida correzione**
- Controllo URL su `/ynab-receipts/` e `/receipt-to-csv/` → Richiedi
  indicizzazione
