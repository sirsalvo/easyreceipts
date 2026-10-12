/**
 * CloudFront Function (viewer-request) for the Spendify landing distribution.
 *
 * Why this exists
 * ---------------
 * The landing is served from an S3 REST origin behind an Origin Access
 * Identity. That origin has no notion of a directory index: CloudFront only
 * applies DefaultRootObject to "/", so "/ynab-receipts/" asks S3 for a key
 * that does not exist and S3 answers 403 (not 404, because the OAI policy
 * only grants s3:GetObject).
 *
 * Consequences measured on 2026-09-25:
 *  - /ynab-receipts/ and /receipt-to-csv/ returned 403 since 2026-02-24,
 *    despite being listed in sitemap.xml. They are the only pages with real
 *    indexable text (4119 and 2387 characters); the homepage ships an empty
 *    SPA shell with 1 character of text and no <h1>.
 *  - Search Console reported "Bloccata a causa di un accesso non autorizzato
 *    (403)" on 3 pages with validation status "Non riuscita".
 *  - The Feb 2026 republish also removed the previous landing pages
 *    (/ynab.html, /en/, /it/), which now 403 as well. A 403 is the worst
 *    answer for a moved page: Google keeps retrying and never consolidates
 *    the signals onto the new URL, whereas a 301 passes them along.
 *
 * Found on 2026-10-08, still live: LEGACY_REDIRECTS only mapped the bare
 * "/en"/"/en/" and "/it"/"/it/" paths, not anything nested under them.
 * Search Console's own Controllo URL test on www.spendifyapp.com/en/index.html
 * and /it/index.html - the exact URLs it still had on file from before Feb
 * 2026 - showed "Operazione non riuscita: Bloccata a causa di un accesso non
 * autorizzato (403)", which is why its fix validation kept failing even
 * though /ynab-receipts/ and /receipt-to-csv/ themselves were long fixed.
 *
 * Found on 2026-10-12: the Coverage report that came back after the fix above
 * replaced the 403 entry (2 pages, now 0 - confirmed fixed) with a NEW
 * "Errore di reindirizzamento" (redirect error) entry, also 2 pages. Verified
 * live with curl: www.spendifyapp.com/en/index.html and /it/index.html - the
 * same two legacy URLs Google still had on file - were chaining through TWO
 * redirects (www -> apex, same path, then apex -> collapsed target) because
 * the www check returned immediately, before the legacy/nested-path checks
 * ran. Now the target path is resolved first and host + path collapse into a
 * single 301, regardless of which rules apply.
 *
 * What it does:
 *  1. Resolve the canonical path (legacy exact match, then anything nested
 *     under /en/ or /it/, then add a trailing slash to extensionless paths).
 *  2. If the host was "www." and/or the path changed, issue ONE 301 straight
 *     to the final https://apex/path.
 *  3. Otherwise rewrite "/path/" -> "/path/index.html" so directory URLs
 *     resolve against the S3 origin.
 *
 * Anything with a file extension (/assets/*.js, /robots.txt, /privacy.html)
 * falls through untouched.
 */

var APEX = 'spendifyapp.com';

// Old URL -> current equivalent. Keep 301 (not 410) where a replacement
// exists, so the accumulated ranking signals move to the new page.
var LEGACY_REDIRECTS = {
    '/ynab.html': '/ynab-receipts/',
    '/en': '/',
    '/en/': '/',
    '/it': '/',
    '/it/': '/'
};

function buildQueryString(request) {
    var qs = request.querystring;
    var parts = [];

    for (var key in qs) {
        if (!Object.prototype.hasOwnProperty.call(qs, key)) {
            continue;
        }
        var entry = qs[key];
        if (entry.multiValue) {
            for (var i = 0; i < entry.multiValue.length; i++) {
                parts.push(key + '=' + entry.multiValue[i].value);
            }
        } else if (entry.value) {
            parts.push(key + '=' + entry.value);
        } else {
            parts.push(key);
        }
    }

    return parts.length ? '?' + parts.join('&') : '';
}

function permanentRedirect(location) {
    return {
        statusCode: 301,
        statusDescription: 'Moved Permanently',
        headers: {
            'location': { value: location },
            // Short cache: a redirect rule is more likely to be tuned than a
            // static asset, and we do not want it pinned in browsers for long.
            'cache-control': { value: 'max-age=3600' }
        }
    };
}

function handler(event) {
    var request = event.request;
    var uri = request.uri;
    var query = buildQueryString(request);

    var hostHeader = request.headers.host;
    var isWww = Boolean(hostHeader && hostHeader.value && hostHeader.value.indexOf('www.') === 0);

    // Resolve the canonical PATH first, before deciding on the host, so a
    // www + legacy-path visitor gets ONE redirect straight to the final URL
    // instead of chaining through an intermediate apex hop (2026-10-12).
    var targetUri = uri;
    var pathChanged = false;

    var legacy = LEGACY_REDIRECTS[uri];
    if (legacy) {
        targetUri = legacy;
        pathChanged = true;
    } else if (uri.indexOf('/en/') === 0 || uri.indexOf('/it/') === 0) {
        // Anything else still nested under the old /en/ or /it/ sections
        // (e.g. /en/index.html, /en/some-page.html) collapses to the same
        // target as the bare prefix, instead of falling through to a 403.
        targetUri = '/';
        pathChanged = true;
    } else if (uri.charAt(uri.length - 1) !== '/' && uri.substring(uri.lastIndexOf('/') + 1).indexOf('.') === -1) {
        // Extensionless paths get the canonical trailing slash.
        // Files (.js, .css, .html, .xml, .txt, .png) fall through untouched.
        targetUri = uri + '/';
        pathChanged = true;
    }

    if (isWww || pathChanged) {
        return permanentRedirect('https://' + APEX + targetUri + query);
    }

    // Directory URLs: serve the index document from S3.
    if (uri.charAt(uri.length - 1) === '/') {
        request.uri = uri + 'index.html';
        return request;
    }

    return request;
}
