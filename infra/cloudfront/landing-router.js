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
 * What it does, in order:
 *  1. 301 www -> apex, so the two hostnames stop serving duplicate content
 *  2. 301 legacy URLs onto their current equivalents
 *  3. rewrite "/path/" -> "/path/index.html" so directory URLs resolve
 *  4. 301 "/path" -> "/path/" to keep a single canonical form
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

    // 1. Collapse www onto the apex domain.
    var hostHeader = request.headers.host;
    if (hostHeader && hostHeader.value && hostHeader.value.indexOf('www.') === 0) {
        return permanentRedirect('https://' + APEX + uri + query);
    }

    // 2. Legacy URLs from the pre-February landing.
    var legacy = LEGACY_REDIRECTS[uri];
    if (legacy) {
        return permanentRedirect('https://' + APEX + legacy + query);
    }

    // 3. Directory URLs: serve the index document from S3.
    if (uri.charAt(uri.length - 1) === '/') {
        request.uri = uri + 'index.html';
        return request;
    }

    // 4. Extensionless paths get the canonical trailing slash.
    //    Files (.js, .css, .html, .xml, .txt, .png) fall through untouched.
    var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
    if (lastSegment.indexOf('.') === -1) {
        return permanentRedirect('https://' + APEX + uri + '/' + query);
    }

    return request;
}
