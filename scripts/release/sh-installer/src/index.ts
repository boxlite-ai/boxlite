// Cloudflare Worker that serves the boxlite-cli installer at sh.boxlite.ai.
//
// It proxies the latest install.sh published by the release pipeline:
//   https://github.com/boxlite-ai/boxlite/releases/latest/download/install.sh
//
// The Worker is a passthrough — the install.sh content (including its embedded
// sigstore attestation and SHA256 checksums) is untouched. Trust still flows
// from the GitHub Release, not from this Worker.

const UPSTREAM =
  "https://github.com/boxlite-ai/boxlite/releases/latest/download/install.sh";

// Edge cache TTL. Longer = fewer GitHub fetches but slower propagation of a
// newly-published release. 300s (5 min) is the same order as rustup's CDN.
const CACHE_TTL_SECONDS = 300;

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const upstream = await fetch(UPSTREAM, {
      // Tell Cloudflare's edge cache to store the response for CACHE_TTL_SECONDS
      // regardless of upstream cache-control. cacheEverything overrides GitHub's
      // defaults so we don't refetch on every request.
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
      headers: { "User-Agent": "sh.boxlite.ai (Cloudflare Worker)" },
    });

    if (!upstream.ok) {
      return new Response(
        `sh.boxlite.ai upstream returned ${upstream.status}. ` +
          `Try the verifiable URL directly: ${UPSTREAM}\n`,
        { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    // Override GitHub's Content-Type (application/octet-stream) so curl/browsers
    // recognise it as a shell script. Body is forwarded byte-for-byte.
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}, s-maxage=${CACHE_TTL_SECONDS}`,
      },
    });
  },
};
