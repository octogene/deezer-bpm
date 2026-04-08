(function () {
    'use strict';

    window.DeezerBpm = window.DeezerBpm || {};

    const {
        TRACK_QUEUE_CONCURRENCY,
        ALBUM_QUEUE_CONCURRENCY,
        UNRESOLVABLE,
    } = window.DeezerBpm.constants;

    const {
        normalizeTrackKeyPart,
        logDebugInfo,
        logDebugError,
    } = window.DeezerBpm.utils;

    const {
        bpmCache,
        coverCache,
        albumCache,
        trackResolutionCache,
        inFlight,
        scheduleSaveCache,
    } = window.DeezerBpm.cache;

    function createQueue(max = 3) {
        return {
            running: 0,
            max,
            pending: [],

            add(fn) {
                return new Promise((resolve, reject) => {
                    this.pending.push({ fn, resolve, reject });
                    this._run();
                });
            },

            async _run() {
                if (this.running >= this.max || this.pending.length === 0) return;

                this.running += 1;
                const { fn, resolve, reject } = this.pending.shift();

                try {
                    resolve(await fn());
                } catch (error) {
                    reject(error);
                } finally {
                    this.running -= 1;
                    this._run();
                }
            },
        };
    }

    const trackQueue = createQueue(TRACK_QUEUE_CONCURRENCY);
    const albumQueue = createQueue(ALBUM_QUEUE_CONCURRENCY);

    async function fetchBpmCached(trackId) {
        const id = String(trackId);
        const inFlightId = `track:${id}`;

        if (bpmCache.has(id)) return bpmCache.get(id);
        if (inFlight.has(inFlightId)) return inFlight.get(inFlightId);

        const promise = trackQueue.add(async () => {
            try {
                const response = await fetch(`https://api.deezer.com/track/${id}`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const data = await response.json();
                logDebugInfo('Fetched track from API:', data);

                const bpm = (typeof data.bpm === 'number' && data.bpm > 0)
                    ? Math.round(data.bpm)
                    : null;

                bpmCache.set(id, bpm);
                scheduleSaveCache();

                return bpm;
            } finally {
                inFlight.delete(inFlightId);
            }
        });

        inFlight.set(inFlightId, promise);
        return promise;
    }

    async function fetchAlbumCached(albumId) {
        const id = String(albumId);
        const inFlightId = `album:${id}`;

        if (albumCache.has(id)) return albumCache.get(id);
        if (inFlight.has(inFlightId)) return inFlight.get(inFlightId);

        const promise = albumQueue.add(async () => {
            try {
                logDebugInfo('No inflight request for album id:', id);

                const response = await fetch(`https://api.deezer.com/album/${id}`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);

                const data = await response.json();
                logDebugInfo('Fetched raw data from API:', data);

                if (data.error) throw new Error(`API error: ${JSON.stringify(data.error)}`);

                let allTracks = [];
                let nextUrl = data.tracklist;

                while (nextUrl) {
                    const pageResponse = await fetch(nextUrl);
                    if (!pageResponse.ok) throw new Error(`HTTP ${pageResponse.status}`);

                    const pageData = await pageResponse.json();
                    if (pageData.error) throw new Error(`API error: ${JSON.stringify(pageData.error)}`);

                    allTracks = allTracks.concat(pageData.data || []);
                    nextUrl = pageData.next || null;
                }

                logDebugInfo(
                    'Fetched all tracks via tracklist, total:',
                    allTracks.length,
                    '(nb_tracks reported:',
                    data.nb_tracks,
                    ')'
                );

                const albumData = {
                    id: data.id,
                    title: data.title,
                    coverId: data.md5_image,
                    tracks: allTracks.map(track => ({
                        id: track.id,
                        title: track.title,
                    })),
                };

                logDebugInfo('Fetched album from API:', albumData);

                albumCache.set(id, albumData);
                coverCache.set(data.md5_image, id);
                scheduleSaveCache();

                return albumData;
            } finally {
                inFlight.delete(inFlightId);
            }
        });

        inFlight.set(inFlightId, promise);
        return promise;
    }

    function findTrackMatch(tracks, rawTitle) {
        const normalized = normalizeTrackKeyPart(rawTitle);

        return tracks.find(track => {
            const apiNorm = normalizeTrackKeyPart(track.title);
            if (apiNorm === normalized) return true;

            const stripped = apiNorm.replace(/^.+\s:\s/, '');
            return stripped === normalized;
        });
    }

    async function searchTrackFallback({ rawTitle, artistName, coverId, cacheKey = null }) {
        const query = `track:"${rawTitle}" artist:"${artistName}"`;

        if (inFlight.has(query)) return inFlight.get(query);

        const promise = albumQueue.add(async () => {
            try {
                logDebugInfo('[ROW RES] Search fallback for', query);

                const response = await fetch(
                    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`
                );

                if (!response.ok) return UNRESOLVABLE;

                const data = await response.json();
                logDebugInfo('[ROW RES] Search response:', data);

                const results = data.data || [];
                const match = results.find(result => result.md5_image === coverId) ?? results[0];
                const trackId = match?.id !== null && match?.id !== undefined
                    ? String(match.id)
                    : UNRESOLVABLE;

                if (trackId !== UNRESOLVABLE && cacheKey) {
                    trackResolutionCache.set(cacheKey, trackId);
                    scheduleSaveCache();
                }

                return trackId;
            } catch (error) {
                logDebugError('Search failed for', query, error);
                return UNRESOLVABLE;
            } finally {
                inFlight.delete(query);
            }
        });

        inFlight.set(query, promise);
        return promise;
    }

    window.DeezerBpm.api = {
        createQueue,
        trackQueue,
        albumQueue,
        fetchBpmCached,
        fetchAlbumCached,
        findTrackMatch,
        searchTrackFallback,
    };
})();