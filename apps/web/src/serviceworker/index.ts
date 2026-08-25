/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { idbLoad } from "../utils/StorageAccess";
import { ACCESS_TOKEN_IV, tryDecryptToken } from "../utils/tokens/tokens";
import { buildAndEncodePickleKey } from "../utils/tokens/pickling";

const serverSupportMap: {
    [serverUrl: string]: {
        supportsAuthedMedia: boolean;
        cacheExpiryTimeMs: number;
    };
} = {};

global.addEventListener("install", (event) => {
    // We skipWaiting() to update the service worker more frequently, particularly in development environments.
    // @ts-expect-error - service worker types are not available. See 'fetch' event handler.
    event.waitUntil(skipWaiting());
});

global.addEventListener("activate", (event) => {
    // We force all clients to be under our control, immediately. This could be old tabs.
    // @ts-expect-error - service worker types are not available. See 'fetch' event handler.
    event.waitUntil(clients.claim());
});

// @ts-expect-error - the service worker types conflict with the DOM types available through TypeScript. Many hours
// have been spent trying to convince the type system that there's no actual conflict, but it has yet to work. Instead
// of trying to make it do the thing, we force-cast to something close enough where we can (and ignore errors otherwise).
global.addEventListener("fetch", (event: FetchEvent) => {
    // This is the authenticated media (MSC3916) check, proxying what was unauthenticated to the authenticated variants.

    if (event.request.method !== "GET") {
        return; // not important to us
    }

    // Note: ideally we'd keep the request headers etc, but in practice we can't even see those details.
    // See https://stackoverflow.com/a/59152482
    const url = new URL(event.request.url);

    // We only intercept v3 download and thumbnail requests as presumably everything else is deliberate.
    // For example, `/_matrix/media/unstable` or `/_matrix/media/v3/preview_url` are something well within
    // the control of the application, and appear to be choices made at a higher level than us.
    if (
        !url.pathname.startsWith("/_matrix/media/v3/download") &&
        !url.pathname.startsWith("/_matrix/media/v3/thumbnail")
    ) {
        return; // not a URL we care about
    }

    // We need to call respondWith synchronously, otherwise we may never execute properly. This means
    // later on we need to proxy the request through if it turns out the server doesn't support authentication.
    event.respondWith(
        (async (): Promise<Response> => {
            // Step 1: Acquire auth credentials. This is separated from /versions so that a /versions
            // failure does NOT cause us to lose the access token we already successfully decrypted.
            let auth: { accessToken?: string; homeserver: string } | undefined;
            try {
                // Add jitter to reduce request spam, particularly to `/versions` on initial page load
                await new Promise<void>((resolve) => setTimeout(() => resolve(), Math.random() * 10));

                // Locate the access token and homeserver url
                // @ts-expect-error - service worker types are not available. See 'fetch' event handler.
                const client = await global.clients.get(event.clientId);
                auth = await getAuthData(client);
            } catch (err) {
                console.error("SW: Error acquiring auth credentials.", err);
                // Fall through — we'll try the request without auth
            }

            // Step 2: Check server support and optionally rewrite the URL
            const csApi = url.origin;
            let urlRewritten = false;
            if (auth?.accessToken) {
                try {
                    // Is this request actually going to the homeserver?
                    const isRequestToHomeServer = url.origin === new URL(auth.homeserver).origin;
                    if (!isRequestToHomeServer) {
                        console.warn("SW: Request appears to be for media endpoint but wrong homeserver!");
                    } else {
                        // Update or populate the server support map using a (usually) authenticated `/versions` call.
                        await tryUpdateServerSupportMap(csApi, auth.accessToken);

                        // If we have server support, rewrite the URL to use MSC3916 endpoints.
                        if (serverSupportMap[csApi]?.supportsAuthedMedia) {
                            url.href = url.href.replace(/\/media\/v3\/(.*)\//, "/client/v1/media/$1/");
                            urlRewritten = true;
                        }
                    }
                } catch (err) {
                    // /versions failed (network error, captive portal, etc.)
                    // We still have valid auth credentials — DON'T throw them away.
                    console.warn("SW: Error checking server support, proceeding with auth on original URL.", err);
                }
            }

            // Step 3: Send the request. Add authentication even if MSC3916 endpoints aren't
            // being used to ensure patches like this work:
            // https://github.com/matrix-org/synapse/commit/2390b66bf0ec3ff5ffb0c7333f3c9b239eeb92bb
            const response = await fetch(url, fetchConfigForToken(auth?.accessToken));

            // Step 4: If the old v3 endpoint returned 404 and we have auth but didn't rewrite the URL,
            // the server likely requires the new authenticated media endpoints. Retry with rewriting.
            if (response.status === 404 && auth?.accessToken && !urlRewritten) {
                console.log(
                    "[ServiceWorker] Got 404 on v3 media endpoint, retrying with authenticated v1 endpoint",
                );
                const authedUrl = new URL(event.request.url);
                authedUrl.href = authedUrl.href.replace(/\/media\/v3\/(.*)\//, "/client/v1/media/$1/");

                // Invalidate the server support map cache so the next request re-checks /versions
                delete serverSupportMap[csApi];

                return fetch(authedUrl, fetchConfigForToken(auth.accessToken));
            }

            return response;
        })(),
    );
});

async function tryUpdateServerSupportMap(clientApiUrl: string, accessToken?: string): Promise<void> {
    // only update if we don't know about it, or if the data is stale
    if (serverSupportMap[clientApiUrl]?.cacheExpiryTimeMs > new Date().getTime()) {
        return; // up to date
    }

    const config = fetchConfigForToken(accessToken);
    let versions: any;
    try {
        const resp = await fetch(`${clientApiUrl}/_matrix/client/versions`, config);
        if (!resp.ok) {
            throw new Error(`/versions returned HTTP ${resp.status}`);
        }
        versions = await resp.json();
    } catch (err) {
        // Network error, captive portal, or non-JSON response.
        // Cache a short negative entry (30s) to avoid hammering /versions on every media request,
        // but don't cache for 2 hours like a successful response.
        console.warn(`[ServiceWorker] /versions call failed for '${clientApiUrl}':`, err);
        serverSupportMap[clientApiUrl] = {
            supportsAuthedMedia: false,
            cacheExpiryTimeMs: new Date().getTime() + 30 * 1000, // retry in 30 seconds
        };
        throw err; // propagate so the caller knows /versions failed
    }

    // Validate that the response looks like a real /versions response
    if (!versions || !Array.isArray(versions.versions)) {
        console.warn(
            `[ServiceWorker] /versions response for '${clientApiUrl}' is malformed:`,
            JSON.stringify(versions),
        );
        serverSupportMap[clientApiUrl] = {
            supportsAuthedMedia: false,
            cacheExpiryTimeMs: new Date().getTime() + 30 * 1000, // retry in 30 seconds
        };
        throw new Error("Malformed /versions response");
    }

    console.log(`[ServiceWorker] /versions response for '${clientApiUrl}': ${JSON.stringify(versions)}`);

    serverSupportMap[clientApiUrl] = {
        supportsAuthedMedia: Boolean(versions.versions.includes("v1.11")),
        cacheExpiryTimeMs: new Date().getTime() + 2 * 60 * 60 * 1000, // 2 hours from now
    };
    console.log(
        `[ServiceWorker] serverSupportMap update for '${clientApiUrl}': ${JSON.stringify(serverSupportMap[clientApiUrl])}`,
    );
}

// Ideally we'd use the `Client` interface for `client`, but since it's not available (see 'fetch' listener), we use
// unknown for now and force-cast it to something close enough later.
async function getAuthData(client: unknown): Promise<{ accessToken: string; homeserver: string }> {
    // Access tokens are encrypted at rest, so while we can grab the "access token", we'll need to do work to get the
    // real thing.
    const encryptedAccessToken = await idbLoad("account", "mx_access_token");

    // We need to extract a user ID and device ID from localstorage, which means calling WebPlatform for the
    // read operation. Service workers can't access localstorage.
    const { userId, deviceId, homeserver } = await askClientForUserIdParams(client);

    // ... and this is why we need the user ID and device ID: they're index keys for the pickle key table.
    const pickleKeyData = await idbLoad("pickleKey", [userId, deviceId]);
    if (pickleKeyData && (!pickleKeyData.encrypted || !pickleKeyData.iv || !pickleKeyData.cryptoKey)) {
        throw new Error("SW: Invalid pickle key loaded - ignoring");
    }

    // Finally, try decrypting the thing and return that. This may fail, but that's okay.
    try {
        const pickleKey = await buildAndEncodePickleKey(pickleKeyData, userId, deviceId);
        const accessToken = await tryDecryptToken(pickleKey, encryptedAccessToken, ACCESS_TOKEN_IV);
        return { accessToken, homeserver };
    } catch (e) {
        throw new Error("SW: Error decrypting access token.", { cause: e });
    }
}

const pendingUserInfoRequests = new Map<string, (data: any) => void>();

global.addEventListener("message", (event: MessageEvent) => {
    const responseKey = event.data?.responseKey;
    if (responseKey && pendingUserInfoRequests.has(responseKey)) {
        const resolve = pendingUserInfoRequests.get(responseKey)!;
        pendingUserInfoRequests.delete(responseKey);
        resolve(event.data);
    }
});

// Ideally we'd use the `Client` interface for `client`, but since it's not available (see 'fetch' listener), we use
// unknown for now and force-cast it to something close enough inside the function.
async function askClientForUserIdParams(
    client: unknown,
): Promise<{ userId: string; deviceId: string; homeserver: string }> {
    return new Promise((resolve, reject) => {
        // Dev note: this uses postMessage, which is a highly insecure channel. postMessage is typically visible to other
        // tabs, windows, browser extensions, etc, making it far from ideal for sharing sensitive information. This is
        // why our service worker calculates/decrypts the access token manually: we don't want the user's access token
        // to be available to (potentially) malicious listeners. We do require some information for that decryption to
        // work though, and request that in the least sensitive way possible.
        //
        // We could also potentially use some version of TLS to encrypt postMessage, though that feels way more involved
        // than just reading IndexedDB ourselves.

        // We don't need particularly good randomness here - we just use this to generate a request ID, so we know
        // which postMessage reply is for our active request.
        const responseKey = Math.random().toString(36);

        // Avoid stalling the tab in case something goes wrong.
        const timeoutId = setTimeout(() => {
            pendingUserInfoRequests.delete(responseKey);
            reject(new Error("timeout in postMessage"));
        }, 3000);

        pendingUserInfoRequests.set(responseKey, (data) => {
            clearTimeout(timeoutId);
            resolve(data);
        });

        // Ask the tab for the information we need. This is handled by WebPlatform.
        (client as Window).postMessage({ responseKey, type: "userinfo" });
    });
}

function fetchConfigForToken(accessToken?: string): RequestInit | undefined {
    if (!accessToken) {
        return undefined; // no headers/config to specify
    }

    return {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    };
}
