# Risposta a YNAB per la nuova revisione

Da inviare **solo dopo il rilascio in produzione** dell'OAuth (vedi `CLAUDE.md`,
sezione "YNAB: OAuth in corso"). Compilare `[CLIENT ID]`.

Prima di inviare, verificare che:
- il flusso OAuth sia live su `app.spendifyapp.com` (il revisore altrimenti
  trova ancora il vecchio flusso);
- la registrazione con verifica email funzioni per un nuovo iscritto;
- il Client ID sia quello dell'app **prod**;
- il badge "Works with YNAB" sulla home sia stato tolto (o la decisione presa).

---

**To:** help@ynab.com
**Subject:** Re: Submission from Contact Us: Question about a third-party YNAB integration (Spendify)

Hi Dela,

Thank you again for your guidance and for your patience. I have made the changes you asked for, and I would be grateful if you could review Spendify again and "de-ice" the API OAuth Community App request I submitted.

**Application:** Spendify, a tool that turns receipt photos into YNAB transactions, only when the user explicitly selects them.
Website: https://spendifyapp.com · App: https://app.spendifyapp.com
OAuth client ID: [CLIENT ID]
Privacy Policy: https://spendifyapp.com/privacy.html (last updated 2026-09-26)

**1. OAuth instead of the Personal Access Token**

Spendify no longer asks for a Personal Access Token. It uses the Authorization Code grant with PKCE and a single-use `state` parameter. The user signs in on YNAB and approves access; Spendify never sees the password. Tokens are stored server-side, encrypted with a dedicated AWS KMS key bound to the user, and are never sent to the browser. Any token a user's browser stored under the old flow is deleted on first load of the new version.

We do not use the read-only scope because we create transactions. We use the access only to list the user's plans and accounts, so they can choose where receipts go, and to create the transactions they select. We do not read existing transactions, categories, balances or budget amounts, and we do not send categories. Each transaction carries an `import_id`, so a retry cannot create a duplicate.

**2. Privacy Policy**

The policy now describes how data obtained through the YNAB API is handled, stored and secured and how long it is kept; states that it is not passed to any third party; explains how users can delete it (disconnect in Settings, or by emailing privacy@spendifyapp.com, with deletion within 30 days); and includes a last-updated date and a commitment to ask for consent again if usage ever changes. It is linked from the YNAB section of the app's Settings and from the website footer. The footer also carries YNAB's non-affiliation notice, and I renamed our page to "Receipt Scanner for YNAB" to follow the naming rule.

**3. The other two points you raised**

The sign-up and email verification issue is fixed. As for PDF receipts, Spendify currently accepts JPG and PNG photos only, and the upload screen now says so clearly. PDF support is planned but is not part of this submission.

If it helps the review, I can create a test account with its trial already active. New accounts get a 14-day free trial with no card required.

Thank you again, and thank you for making the API available to the community.

Best regards,
Salvo
