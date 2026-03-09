// ==UserScript==
// @name         OpenFront Toolkit
// @namespace    openfront-toolkit
// @version      1.4.0
// @description  Alliance Auto-Renew + Turbo Place + Nuke Tracker + Performance in one toolkit
// @match        https://openfront.io/*
// @match        https://www.openfront.io/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ════════════════════════════════════════════════════════════════════════════
    // SHARED STATE
    // ════════════════════════════════════════════════════════════════════════════

    let nukeEnabled = true;
    let autoRenewEnabled = true;
    let turboEnabled = false;
    const autoRenewPlayers = new Map(); // smallID → playerName
    let intervalMs = 150;

    // Nuke/boat tracker canvas state — declared at IIFE level so UI toggle can access them
    const nukeMap = new Map();
    const boatMap = new Map();
    let boatEnabled = false;
    let _AllianceExtensionCtor = null; // SendAllianceExtensionIntentEvent ctor (discovered lazily)
    let _AllianceRequestCtor = null; // SendAllianceRequestIntentEvent ctor (discovered lazily)
    const _sentExtensions = new Map(); // allianceId → tick when extension was sent this cycle
    const _sentRequests = new Map(); // smallID    → Date.now() when request was last sent
    const EXTEND_THRESHOLD = 200; // ticks before expiry to proactively send extension (~20 s)
    const REQUEST_COOLDOWN_MS = 20000; // ms between new alliance requests to the same player
    let overlayCanvas = null;
    let overlayCtx = null;

    // UI element references (populated by setupUI)
    let _arListContainer = null;
    let _turboIntervalLbl = null;
    let _minusBtn = null;
    let _plusBtn = null;
    let _pillAR = null;
    let _pillTP = null;
    let _pillNK = null;
    let _pillBT = null;
    // Performance tab state
    let perfFpsLimit = 0; // 0 = unlimited, 15 or 30
    let perfHideNukes = false;
    let perfHideWarships = false;
    let perfHideTrains = false;
    let perfHideTradeBoats = false;
    let perfAntiAfk = false;

    // Performance stats (runtime, not persisted)
    let _statFps = 0;
    let _statFrameTime = '---';
    let _statTps = '0.0';
    let _statUnitCount = 0;

    // Stats tracking internals
    let _rafCounter = 0;
    let _fpsLimitMinInterval = 0; // ms per frame; 0 = unlimited

    // Anti-AFK
    let _gameSocket = null;
    let _antiAfkTimer = null;

    // Perf tab UI refs
    let _statsContainer = null;
    let _pillFpsLimit = [];
    let _pillAntiAfk = null;

    // ════════════════════════════════════════════════════════════════════════════
    // NUKE TRACKER
    // Prototype hooks run immediately at document-start.
    // With @grant none we run in the page world directly — no script-tag injection.
    // ════════════════════════════════════════════════════════════════════════════

    if (!window.__nukeTrackerLoaded) {
        window.__nukeTrackerLoaded = true;

        var nukeDebug = false;
        var _gameCanvas = null;

        var NUKE_TYPES = new Set(['Atom Bomb', 'Hydrogen Bomb', 'MIRV Warhead']);
        var NUKE_RADII = {
            'Atom Bomb': {
                inner: 12,
                outer: 30
            },
            'Hydrogen Bomb': {
                inner: 80,
                outer: 100
            },
            'MIRV Warhead': {
                inner: 12,
                outer: 18
            },
        };
        var DEFAULT_NUKE_SPEED = 6;
        var DEFAULT_BOAT_SPEED = 2;
        var PARABOLA_MIN_HEIGHT = 50;
        var GAME_UPDATE_TYPE_UNIT = 1;

        var mapManifest = null;
        var gameMapSize = 'Normal';
        var mapWidth = null;
        var mapHeight = null;
        var lastTransform = null;

        var tickTimestamps = [];
        var tickIntervalMs = 100;
        var _hiddenUnitIds = new Set(); // IDs already killed in GameView for render hiding

        // Capture RAF/CAF before any other script wraps it
        var _origRAF = window.requestAnimationFrame;
        var _origCAF = window.cancelAnimationFrame;
        var _drawScheduled = false;

        // Install unified rAF wrapper: frame counting + optional FPS throttle
        window.requestAnimationFrame = function(callback) {
            _rafCounter++;
            if (_fpsLimitMinInterval > 0) {
                return setTimeout(function() {
                    callback(performance.now());
                }, _fpsLimitMinInterval);
            }
            return _origRAF.call(window, callback);
        };
        window.cancelAnimationFrame = function(id) {
            if (_fpsLimitMinInterval > 0) {
                clearTimeout(id);
            } else {
                _origCAF.call(window, id);
            }
        };

        function _scheduleDraw() {
            if (_drawScheduled || !overlayCtx || !lastTransform) return;
            _drawScheduled = true;
            _origRAF(function() {
                _drawScheduled = false;
                _drawOverlay();
            });
        }

        function maybeSetMapDimensions() {
            if (!mapManifest) return;
            var key = (gameMapSize === 'Compact') ? 'map4x' : 'map';
            var dims = mapManifest[key];
            if (dims && dims.width && dims.height) {
                mapWidth = dims.width;
                mapHeight = dims.height;
                if (nukeDebug) console.log('[NukeTraj] map:', mapWidth, 'x', mapHeight, '(' + key + ')');
            }
        }

        function clampY(worldY) {
            return Math.max(-mapHeight / 2, Math.min(worldY, mapHeight / 2 - 1));
        }

        // Compute Bezier arc length — mirrors PathFinder.Parabola.ts / Line.ts exactly.
        // Coordinates are raw tile coords (NOT the world-space offsets used for drawing).
        function _nukeArcLength(spawnPos, targetTile, directionUp, isMIRV) {
            if (!mapWidth || !mapHeight) return null;
            var p0x = spawnPos % mapWidth,
                p0y = Math.floor(spawnPos / mapWidth);
            var p3x = targetTile % mapWidth,
                p3y = Math.floor(targetTile / mapWidth);
            var dx = p3x - p0x,
                dy = p3y - p0y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            var maxH = isMIRV ? 0 : Math.max(dist / 3, PARABOLA_MIN_HEIGHT);
            var hm = directionUp ? -1 : 1;
            var p1x = p0x + dx / 4,
                p1y = Math.max(0, Math.min(p0y + dy / 4 + hm * maxH, mapHeight - 1));
            var p2x = p0x + dx * 3 / 4,
                p2y = Math.max(0, Math.min(p0y + dy * 3 / 4 + hm * maxH, mapHeight - 1));
            var steps = 300,
                len = 0,
                px = p0x,
                py = p0y;
            for (var i = 1; i <= steps; i++) {
                var t = i / steps,
                    T = 1 - t,
                    T2 = T * T,
                    T3 = T2 * T,
                    t2 = t * t,
                    t3 = t2 * t;
                var nx = T3 * p0x + 3 * T2 * t * p1x + 3 * T * t2 * p2x + t3 * p3x;
                var ny = T3 * p0y + 3 * T2 * t * p1y + 3 * T * t2 * p2y + t3 * p3y;
                var ddx = nx - px,
                    ddy = ny - py;
                len += Math.sqrt(ddx * ddx + ddy * ddy);
                px = nx;
                py = ny;
            }
            return len;
        }

        // ── Hook 1: fetch — capture map manifest ───────────────────────────────
        var _origFetch = window.fetch;
        window.fetch = function() {
            var url = (typeof arguments[0] === 'string') ?
                arguments[0] :
                (arguments[0] && arguments[0].url ? arguments[0].url : '');
            if (url.indexOf('/maps/') !== -1 && url.indexOf('/manifest.json') !== -1) {
                return _origFetch.apply(this, arguments).then(function(resp) {
                    resp.clone().json().then(function(data) {
                        mapManifest = data;
                        maybeSetMapDimensions();
                        if (nukeDebug) console.log('[NukeTraj] manifest:', data);
                    }).catch(function() {});
                    return resp;
                });
            }
            return _origFetch.apply(this, arguments);
        };

        // ── Hook 1b: WebSocket — capture game socket for anti-AFK ─────────────
        var _OrigWebSocket = window.WebSocket;
        window.WebSocket = function(url, protocols) {
            var ws = (protocols !== undefined) ?
                new _OrigWebSocket(url, protocols) :
                new _OrigWebSocket(url);
            if (typeof url === 'string') {
                _gameSocket = ws;
                ws.addEventListener('close', function() {
                    if (_gameSocket === ws) _gameSocket = null;
                });
            }
            return ws;
        };
        window.WebSocket.prototype = _OrigWebSocket.prototype;
        window.WebSocket.CONNECTING = _OrigWebSocket.CONNECTING;
        window.WebSocket.OPEN = _OrigWebSocket.OPEN;
        window.WebSocket.CLOSING = _OrigWebSocket.CLOSING;
        window.WebSocket.CLOSED = _OrigWebSocket.CLOSED;

        // ── Hook 2a: Worker.prototype.postMessage — capture gameMapSize ────────
        var _origProtoPostMessage = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function(data, transfer) {
            try {
                if (data && data.type === 'init' && data.gameStartInfo) {
                    var sz = data.gameStartInfo.config && data.gameStartInfo.config.gameMapSize;
                    if (sz) {
                        gameMapSize = sz;
                        maybeSetMapDimensions();
                    }
                    if (nukeDebug) console.log('[NukeTraj] gameMapSize:', gameMapSize);
                }
            } catch (e) {}
            return _origProtoPostMessage.apply(this, arguments);
        };

        // ── Hook 2b: Worker.prototype.addEventListener — intercept game_update ─
        var _instrumentedWorkers = new WeakSet();
        var _origEAEL = EventTarget.prototype.addEventListener;
        Worker.prototype.addEventListener = function(type, fn, opts) {
            if (type === 'message' && !_instrumentedWorkers.has(this)) {
                _instrumentedWorkers.add(this);
                _origEAEL.call(this, 'message', _onWorkerMessage, false);
                if (nukeDebug) console.log('[NukeTraj] attached to worker');
            }
            return _origEAEL.call(this, type, fn, opts);
        };

        function _onWorkerMessage(event) {
            try {
                var msg = event.data;
                if (!msg || msg.type !== 'game_update') return;
                var gu = msg.gameUpdate;
                if (!gu) return;

                // ── Always: tick timing (needed for TPS stats) ──────────────────────
                var tick = gu.tick;
                var now = Date.now();
                tickTimestamps.push(now);
                if (tickTimestamps.length > 11) tickTimestamps.shift();
                if (tickTimestamps.length >= 2) {
                    tickIntervalMs = (tickTimestamps[tickTimestamps.length - 1] - tickTimestamps[0]) /
                        (tickTimestamps.length - 1);
                }

                var unitUpdates = gu.updates && gu.updates[GAME_UPDATE_TYPE_UNIT];
                if (Array.isArray(unitUpdates)) _statUnitCount = unitUpdates.length;

                // ── Always: render hiding (independent of nuke tracker) ─────────────
                // Uses a two-phase approach: first tick sends a copy with isActive=false
                // (so GameView properly deletes the unit), subsequent ticks omit entirely.
                // Original unitUpdates objects are never mutated, so the nuke tracker
                // below always reads the real server data.
                if (Array.isArray(unitUpdates) &&
                    (perfHideNukes || perfHideWarships || perfHideTrains || perfHideTradeBoats)) {
                    var _filtered = [];
                    for (var _hi = 0; _hi < unitUpdates.length; _hi++) {
                        var _u = unitUpdates[_hi];
                        var _hide = (perfHideNukes && NUKE_TYPES.has(_u.unitType)) ||
                            (perfHideWarships && _u.unitType === 'Warship') ||
                            (perfHideTrains && _u.unitType === 'Train') ||
                            (perfHideTradeBoats && _u.unitType === 'Trade Ship');
                        if (_hide) {
                            if (!_u.isActive || _u.reachedTarget) {
                                _hiddenUnitIds.delete(_u.id); // natural death, clean up
                            } else if (!_hiddenUnitIds.has(_u.id)) {
                                _filtered.push(Object.assign({}, _u, {
                                    isActive: false
                                })); // kill signal (copy, not mutation)
                                _hiddenUnitIds.add(_u.id);
                            }
                            // else: already killed last tick — omit entirely
                        } else {
                            _hiddenUnitIds.delete(_u.id);
                            _filtered.push(_u);
                        }
                    }
                    gu.updates[GAME_UPDATE_TYPE_UNIT] = _filtered;
                } else {
                    _hiddenUnitIds.clear();
                }

                // ── Tracker gate: bail if both disabled ──────────────────────────────
                if (!nukeEnabled && !boatEnabled) {
                    if (nukeMap.size > 0) nukeMap.clear();
                    if (boatMap.size > 0) boatMap.clear();
                    if (overlayCtx && overlayCanvas) {
                        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                    }
                    return;
                }

                if (!Array.isArray(unitUpdates)) return;

                var changed = false;

                // ── Nuke tracking ─────────────────────────────────────────────────────
                if (nukeEnabled) {
                    for (var i = 0; i < unitUpdates.length; i++) {
                        var u = unitUpdates[i];
                        if (!NUKE_TYPES.has(u.unitType)) continue;

                        if (!u.isActive || u.reachedTarget) {
                            if (nukeMap.has(u.id)) {
                                nukeMap.delete(u.id);
                                changed = true;
                            }
                            continue;
                        }
                        if (u.targetTile == null) continue;

                        var existing = nukeMap.get(u.id);
                        if (!existing) {
                            nukeMap.set(u.id, {
                                id: u.id,
                                unitType: u.unitType,
                                spawnPos: u.pos,
                                targetTile: u.targetTile,
                                currentPos: u.pos,
                                firstTick: tick,
                                lastTick: tick,
                                firstSeenTime: now,
                                speed: DEFAULT_NUKE_SPEED,
                                directionUp: true,
                                directionKnown: false,
                                totalTicks: null,
                            });
                            changed = true;
                        } else {
                            if (mapWidth) {
                                var ticksElapsed = tick - existing.firstTick;
                                if (ticksElapsed > 1) {
                                    var sx = existing.spawnPos % mapWidth;
                                    var sy = Math.floor(existing.spawnPos / mapWidth);
                                    var cx = u.pos % mapWidth;
                                    var cy = Math.floor(u.pos / mapWidth);
                                    var traveled = Math.sqrt((cx - sx) * (cx - sx) + (cy - sy) * (cy - sy));
                                    if (traveled > 0) existing.speed = existing.speed * 0.85 + (traveled / ticksElapsed) * 0.15;
                                    if (!existing.directionKnown) {
                                        var tx2 = existing.targetTile % mapWidth;
                                        var ty2 = Math.floor(existing.targetTile / mapWidth);
                                        var totalDist = Math.sqrt((tx2 - sx) * (tx2 - sx) + (ty2 - sy) * (ty2 - sy));
                                        if (totalDist > 20 && traveled / totalDist >= 0.10) {
                                            var frac = traveled / totalDist;
                                            var lineY = sy + (ty2 - sy) * frac;
                                            existing.directionUp = (cy <= lineY);
                                            existing.directionKnown = true;
                                            var arcLen = _nukeArcLength(
                                                existing.spawnPos, existing.targetTile,
                                                existing.directionUp, existing.unitType === 'MIRV Warhead'
                                            );
                                            if (arcLen !== null) existing.totalTicks = arcLen / DEFAULT_NUKE_SPEED;
                                        }
                                    }
                                }
                            }
                            existing.currentPos = u.pos;
                            existing.lastTick = tick;
                            changed = true;
                        }
                    }
                } else {
                    if (nukeMap.size > 0) {
                        nukeMap.clear();
                        changed = true;
                    }
                }

                // ── Boat tracking ─────────────────────────────────────────────────────
                if (boatEnabled) {
                    for (var bi = 0; bi < unitUpdates.length; bi++) {
                        var bu = unitUpdates[bi];
                        if (bu.unitType !== 'Transport') continue;

                        if (!bu.isActive || bu.reachedTarget) {
                            if (boatMap.has(bu.id)) {
                                boatMap.delete(bu.id);
                                changed = true;
                            }
                            continue;
                        }
                        if (bu.targetTile == null) continue;

                        var bexist = boatMap.get(bu.id);
                        if (!bexist) {
                            boatMap.set(bu.id, {
                                id: bu.id,
                                spawnPos: bu.pos,
                                targetTile: bu.targetTile,
                                currentPos: bu.pos,
                                firstTick: tick,
                                speed: DEFAULT_BOAT_SPEED,
                            });
                            changed = true;
                        } else {
                            if (mapWidth) {
                                var bTicks = tick - bexist.firstTick;
                                if (bTicks > 1) {
                                    var bsx = bexist.spawnPos % mapWidth;
                                    var bsy = Math.floor(bexist.spawnPos / mapWidth);
                                    var bcx = bu.pos % mapWidth;
                                    var bcy = Math.floor(bu.pos / mapWidth);
                                    var btrav = Math.sqrt((bcx - bsx) * (bcx - bsx) + (bcy - bsy) * (bcy - bsy));
                                    if (btrav > 0) bexist.speed = btrav / bTicks;
                                }
                            }
                            bexist.currentPos = bu.pos;
                            changed = true;
                        }
                    }
                } else {
                    if (boatMap.size > 0) {
                        boatMap.clear();
                        changed = true;
                    }
                }

                if (changed) {
                    if (nukeMap.size === 0 && boatMap.size === 0 && overlayCtx && overlayCanvas) {
                        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                    } else {
                        _scheduleDraw();
                    }
                }
            } catch (e) {
                if (nukeDebug) console.error('[NukeTraj] worker message error:', e);
            }
        }

        // ── Hook 3: setTransform — capture camera state ────────────────────────
        var _origSetTransform = CanvasRenderingContext2D.prototype.setTransform;
        CanvasRenderingContext2D.prototype.setTransform = function(a, b, c, d, e, f) {
            if (
                this.canvas !== overlayCanvas &&
                (_gameCanvas === null || this.canvas === _gameCanvas) &&
                typeof a === 'number' &&
                b === 0 && c === 0 &&
                a === d && a > 0.1 &&
                (e !== 0 || f !== 0)
            ) {
                lastTransform = {
                    scale: a,
                    tx: e,
                    ty: f
                };
                if ((nukeEnabled && nukeMap.size > 0) || (boatEnabled && boatMap.size > 0)) _scheduleDraw();
            }
            return _origSetTransform.apply(this, arguments);
        };

        // ── Overlay canvas ─────────────────────────────────────────────────────
        function _setupOverlay(gc) {
            if (overlayCanvas) return;
            _gameCanvas = gc;
            overlayCanvas = document.createElement('canvas');
            overlayCanvas.style.cssText =
                'position:fixed;pointer-events:none;z-index:9999;image-rendering:pixelated;';
            document.body.appendChild(overlayCanvas);
            overlayCtx = overlayCanvas.getContext('2d');

            function _sync() {
                var rect = gc.getBoundingClientRect();
                if (!rect.width || !rect.height) return;
                overlayCanvas.width = gc.width;
                overlayCanvas.height = gc.height;
                overlayCanvas.style.left = rect.left + 'px';
                overlayCanvas.style.top = rect.top + 'px';
                overlayCanvas.style.width = rect.width + 'px';
                overlayCanvas.style.height = rect.height + 'px';
                if (((nukeEnabled && nukeMap.size > 0) || (boatEnabled && boatMap.size > 0)) && lastTransform) _scheduleDraw();
            }

            _sync();
            new ResizeObserver(_sync).observe(gc);
            window.addEventListener('resize', _sync, {
                passive: true
            });
            if (nukeDebug) console.log('[NukeTraj] overlay created');
        }

        function _findCanvas() {
            var c = document.querySelector('canvas');
            if (c) {
                _setupOverlay(c);
                return;
            }
            var mo = new MutationObserver(function(_, obs) {
                var c2 = document.querySelector('canvas');
                if (c2) {
                    obs.disconnect();
                    _setupOverlay(c2);
                }
            });
            mo.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _findCanvas);
        } else {
            _findCanvas();
        }

        // ── Rendering ──────────────────────────────────────────────────────────
        function _drawOverlay() {
            if (!overlayCtx || !lastTransform || !mapWidth) return;
            if (!nukeMap.size && !boatMap.size) return;
            var ctx = overlayCtx;
            var scale = lastTransform.scale;
            var tx = lastTransform.tx;
            var ty = lastTransform.ty;
            ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            if (nukeEnabled) nukeMap.forEach(function(nuke) {
                _drawNuke(ctx, nuke, scale, tx, ty);
            });
            if (boatEnabled) boatMap.forEach(function(boat) {
                _drawBoat(ctx, boat, scale, tx, ty);
            });
        }

        function _drawBoat(ctx, boat, scale, tx, ty) {
            var curX = boat.currentPos % mapWidth;
            var curY = Math.floor(boat.currentPos / mapWidth);
            var targetX = boat.targetTile % mapWidth;
            var targetY = Math.floor(boat.targetTile / mapWidth);

            var p0x = curX - mapWidth / 2;
            var p0y = curY - mapHeight / 2;
            var p1x = targetX - mapWidth / 2;
            var p1y = targetY - mapHeight / 2;

            ctx.save();
            ctx.setTransform(scale, 0, 0, scale, tx, ty);

            // Path line: current position → target (tile centers)
            ctx.beginPath();
            ctx.moveTo(p0x + 0.5, p0y + 0.5);
            ctx.lineTo(p1x + 0.5, p1y + 0.5);
            ctx.strokeStyle = 'rgba(255,165,0,0.8)';
            ctx.lineWidth = 2 / scale;
            ctx.setLineDash([8 / scale, 4 / scale]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Landing zone: exact 1-tile highlight
            ctx.fillStyle = 'rgba(255,165,0,0.9)';
            ctx.fillRect(p1x, p1y, 1, 1);
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 3 / scale;
            ctx.strokeRect(p1x, p1y, 1, 1);
            ctx.strokeStyle = 'rgba(255,165,0,1)';
            ctx.lineWidth = 1 / scale;
            ctx.strokeRect(p1x, p1y, 1, 1);

            // Current position dot
            ctx.beginPath();
            ctx.arc(p0x + 0.5, p0y + 0.5, 4 / scale, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,165,0,1)';
            ctx.fill();

            ctx.restore();
        }

        function _drawNuke(ctx, nuke, scale, tx, ty) {
            var spawnX = nuke.spawnPos % mapWidth;
            var spawnY = Math.floor(nuke.spawnPos / mapWidth);
            var targetX = nuke.targetTile % mapWidth;
            var targetY = Math.floor(nuke.targetTile / mapWidth);
            var curX = nuke.currentPos % mapWidth;
            var curY = Math.floor(nuke.currentPos / mapWidth);

            var p0x = spawnX - mapWidth / 2;
            var p0y = spawnY - mapHeight / 2;
            var p3x = targetX - mapWidth / 2;
            var p3y = targetY - mapHeight / 2;

            var dx = p3x - p0x;
            var dy = p3y - p0y;
            var dist = Math.sqrt(dx * dx + dy * dy);

            var maxH = (nuke.unitType === 'MIRV Warhead') ?
                0 :
                Math.max(dist / 3, PARABOLA_MIN_HEIGHT);

            var hm = nuke.directionUp ? -1 : 1;

            var p1x = p0x + dx / 4;
            var p1y = p0y + dy / 4 + hm * maxH;
            var p2x = p0x + (dx * 3) / 4;
            var p2y = p0y + (dy * 3) / 4 + hm * maxH;

            p1y = clampY(p1y);
            p2y = clampY(p2y);

            ctx.save();
            ctx.setTransform(scale, 0, 0, scale, tx, ty);

            // Trajectory arc
            ctx.beginPath();
            ctx.moveTo(p0x, p0y);
            ctx.bezierCurveTo(p1x, p1y, p2x, p2y, p3x, p3y);
            ctx.strokeStyle = 'rgba(255,40,40,0.85)';
            ctx.lineWidth = 2 / scale;
            ctx.setLineDash([6 / scale, 3 / scale]);
            ctx.stroke();
            ctx.setLineDash([]);

            // Impact zone circles
            var radii = NUKE_RADII[nuke.unitType] || {
                inner: 12,
                outer: 30
            };
            ctx.beginPath();
            ctx.arc(p3x, p3y, radii.outer, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,0,0,0.15)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,0,0,0.9)';
            ctx.lineWidth = 1.5 / scale;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(p3x, p3y, radii.inner, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,50,0,0.25)';
            ctx.fill();

            ctx.restore();

            // Screen-space countdown timer
            var scx = p3x * scale + tx;
            var scy = p3y * scale + ty - 30;

            var remainSecs;
            if (nuke.totalTicks !== null) {
                var elapsedTicks = nuke.lastTick - nuke.firstTick;
                remainSecs = (nuke.totalTicks - elapsedTicks) * tickIntervalMs / 1000;
            } else {
                // fallback: straight-line estimate before direction is known
                var ddx = targetX - curX,
                    ddy = targetY - curY;
                var remainDist = Math.sqrt(ddx * ddx + ddy * ddy);
                remainSecs = (remainDist / DEFAULT_NUKE_SPEED) * tickIntervalMs / 1000;
            }
            var label = (isFinite(remainSecs) && remainSecs >= 0) ?
                '\uD83D\uDCA5 ' + remainSecs.toFixed(1) + 's' :
                '\uD83D\uDCA5 ?s';

            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.font = 'bold 14px monospace';
            ctx.textAlign = 'center';
            ctx.lineWidth = 3;
            ctx.strokeStyle = '#000';
            ctx.strokeText(label, scx, scy);
            ctx.fillStyle = '#ff2222';
            ctx.fillText(label, scx, scy);
            ctx.restore();
        }

    } // end nuke tracker block

    // ════════════════════════════════════════════════════════════════════════════
    // PERFORMANCE HELPERS
    // ════════════════════════════════════════════════════════════════════════════

    function startAntiAfk() {
        if (_antiAfkTimer) return;
        _antiAfkTimer = setInterval(function() {
            if (_gameSocket && _gameSocket.readyState === 1 /* OPEN */ ) {
                try {
                    _gameSocket.send(JSON.stringify({
                        type: 'ping'
                    }));
                } catch (_) {}
            }
        }, 2000);
    }

    function stopAntiAfk() {
        if (_antiAfkTimer) {
            clearInterval(_antiAfkTimer);
            _antiAfkTimer = null;
        }
    }

    // ── Auto-send helpers: ctor discovery + proactive extension / request sending ───

    function _ensureCtors(eventBus) {
        for (const [ctor, callbacks] of eventBus.listeners) {
            if (!ctor) continue;
            // SendAllianceExtensionIntentEvent(recipient) — single 'recipient' property
            if (!_AllianceExtensionCtor) {
                try {
                    const inst = new ctor(null);
                    if (Object.keys(inst).length === 1 && 'recipient' in inst &&
                        callbacks.some(function(fn) {
                            try {
                                return fn.toString().includes('"allianceExtension"');
                            } catch (_) {
                                return false;
                            }
                        })) {
                        _AllianceExtensionCtor = ctor;
                    }
                } catch (_) {}
            }
            // SendAllianceRequestIntentEvent(requestor, recipient) — two properties
            if (!_AllianceRequestCtor) {
                try {
                    const inst = new ctor(null, null);
                    if (Object.keys(inst).length === 2 && 'requestor' in inst && 'recipient' in inst &&
                        callbacks.some(function(fn) {
                            try {
                                return fn.toString().includes('"allianceRequest"');
                            } catch (_) {
                                return false;
                            }
                        })) {
                        _AllianceRequestCtor = ctor;
                    }
                } catch (_) {}
            }
            if (_AllianceExtensionCtor && _AllianceRequestCtor) break;
        }
    }

    function _doAutoSend(el) {
        if (!autoRenewEnabled || autoRenewPlayers.size === 0) return;
        try {
            const game = el.game;
            if (!game) return;
            const myPlayer = game.myPlayer();
            if (!myPlayer || !myPlayer.isAlive()) return;

            _ensureCtors(el.eventBus);
            const ticks = game.ticks();

            // ── Proactively extend alliances about to expire with queued players ──────
            if (_AllianceExtensionCtor) {
                for (const alliance of myPlayer.alliances()) {
                    try {
                        const ticksLeft = alliance.expiresAt - ticks;
                        // If the alliance was extended since we sent, clear the sent-mark so
                        // we can send again in the next renewal cycle.
                        if (_sentExtensions.has(alliance.id) && ticksLeft > EXTEND_THRESHOLD * 3) {
                            _sentExtensions.delete(alliance.id);
                        }
                        if (_sentExtensions.has(alliance.id)) continue;
                        if (ticksLeft <= 0 || ticksLeft > EXTEND_THRESHOLD) continue;

                        const other = game.player(alliance.other);
                        if (!other) continue;
                        if (!autoRenewPlayers.has(other.smallID())) continue;

                        _sentExtensions.set(alliance.id, ticks);
                        el.eventBus.emit(new _AllianceExtensionCtor(other));
                    } catch (_) {}
                }
                // Clean up entries for alliances that no longer exist
                const currentIds = new Set(myPlayer.alliances().map(function(a) {
                    return a.id;
                }));
                for (const id of _sentExtensions.keys()) {
                    if (!currentIds.has(id)) _sentExtensions.delete(id);
                }
            }

            // ── Send new alliance requests to queued players not currently allied ─────
            if (_AllianceRequestCtor) {
                const now = Date.now();
                for (const [smallID] of autoRenewPlayers) {
                    try {
                        const lastSent = _sentRequests.get(smallID);
                        if (lastSent && now - lastSent < REQUEST_COOLDOWN_MS) continue;
                        const other = game.playerBySmallID(smallID);
                        if (!other || !other.isAlive()) continue;
                        if (myPlayer.isAlliedWith(other)) continue;
                        if (myPlayer.isRequestingAllianceWith(other)) continue;
                        _sentRequests.set(smallID, now);
                        el.eventBus.emit(new _AllianceRequestCtor(myPlayer, other));
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }

    var _perfStatsPrevTime = performance.now();

    function updatePerfStats() {
        var now = performance.now();
        var dt = (now - _perfStatsPrevTime) / 1000;
        if (dt > 0.1) {
            _statFps = Math.round(_rafCounter / dt);
            _statFrameTime = _statFps > 0 ? (1000 / _statFps).toFixed(1) : '---';
            _rafCounter = 0;
            _perfStatsPrevTime = now;
        }
        if (typeof tickTimestamps !== 'undefined' && tickTimestamps.length >= 2) {
            var span = tickTimestamps[tickTimestamps.length - 1] - tickTimestamps[0];
            _statTps = span > 0 ? ((tickTimestamps.length - 1) / span * 1000).toFixed(1) : '0.0';
        }
        if (_statsContainer) {
            _statsContainer.innerHTML =
                '<div>FPS: <b>' + _statFps + '</b> &nbsp;&nbsp; Frame: <b>' + _statFrameTime + ' ms</b></div>' +
                '<div>TPS: <b>' + _statTps + '</b> &nbsp;&nbsp; Nukes: <b>' + nukeMap.size + '</b> &nbsp;&nbsp; Units: <b>' + _statUnitCount + '</b></div>';
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // AUTO RENEW
    // ════════════════════════════════════════════════════════════════════════════

    const MSG_ALLIANCE_BROKEN = 16;

    function refreshAutoRenewList() {
        if (!_arListContainer) return;
        while (_arListContainer.firstChild) _arListContainer.removeChild(_arListContainer.firstChild);

        if (autoRenewPlayers.size === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = 'color:rgba(255,255,255,0.4);font-size:12px;text-align:center;padding:8px 0;';
            empty.textContent = 'No players queued';
            _arListContainer.appendChild(empty);
            return;
        }

        for (const [smallID, name] of autoRenewPlayers) {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 2px;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = name;
            nameSpan.title = 'ID: ' + smallID;
            nameSpan.style.cssText = 'font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '\u2715';
            removeBtn.title = 'Stop auto-renewing with ' + name;
            removeBtn.style.cssText = 'background:#7f1d1d;color:#fff;border:none;border-radius:4px;cursor:pointer;padding:1px 6px;font-size:12px;flex-shrink:0;margin-left:8px;';
            removeBtn.addEventListener('mouseover', function() {
                this.style.background = '#991b1b';
            });
            removeBtn.addEventListener('mouseout', function() {
                this.style.background = '#7f1d1d';
            });
            removeBtn.addEventListener('click', () => {
                autoRenewPlayers.delete(smallID);
                refreshAutoRenewList();
            });

            row.appendChild(nameSpan);
            row.appendChild(removeBtn);
            _arListContainer.appendChild(row);
        }
    }

    // Detect ⭐ AUTO Renew buttons rendered by Lit and apply gold CSS via data attribute
    const styleObserver = new MutationObserver(() => {
        document.querySelectorAll('events-display button').forEach(btn => {
            if (btn.textContent.includes('\u2B50 AUTO Renew') && !btn.dataset.arStyled) {
                btn.dataset.arStyled = '1';
            }
        });
    });

    function patchElement(el) {
        const orig = el.addEvent.bind(el);

        el.addEvent = function(event) {
            // Auto-remove player from renew list when their alliance is broken
            if (event.type === MSG_ALLIANCE_BROKEN && event.focusID !== undefined) {
                if (autoRenewPlayers.has(event.focusID)) {
                    autoRenewPlayers.delete(event.focusID);
                    refreshAutoRenewList();
                }
            }

            // Alliance renewal prompt (has both allianceID and focusID)
            if (event.allianceID !== undefined && event.focusID !== undefined) {
                if (!autoRenewEnabled) return orig(event);

                const smallID = event.focusID;
                let playerName;
                try {
                    playerName = el.game.playerBySmallID(smallID)?.name?.() ?? ('Player ' + smallID);
                } catch (_) {
                    playerName = 'Player ' + smallID;
                }

                const renewBtn = event.buttons?.find(b => b.className === 'btn');

                if (autoRenewPlayers.has(smallID)) {
                    if (renewBtn) {
                        try {
                            renewBtn.action();
                        } catch (_) {}
                    }
                    return orig({
                        ...event,
                        description: '\u2B50 Auto-renewed alliance with ' + playerName,
                        buttons: [{
                            text: '\u2715 Stop AUTO',
                            className: 'btn-info',
                            action: () => {
                                autoRenewPlayers.delete(smallID);
                                refreshAutoRenewList();
                            },
                        }],
                        duration: 80,
                    });
                } else {
                    const autoBtn = {
                        text: '\u2B50 AUTO Renew',
                        className: 'btn', // Tailwind green; overridden to gold via CSS + data attribute
                        action: () => {
                            autoRenewPlayers.set(smallID, playerName);
                            refreshAutoRenewList();
                            if (renewBtn) {
                                try {
                                    renewBtn.action();
                                } catch (_) {}
                            }
                        },
                    };
                    return orig({
                        ...event,
                        buttons: [...(event.buttons ?? []), autoBtn]
                    });
                }
            }

            // Feature 2: Incoming alliance requests — auto-accept queued players, offer ⭐ AUTO for others
            // These events have focusID but no allianceID, and contain an accept button (className 'btn').
            if (autoRenewEnabled &&
                event.allianceID === undefined &&
                event.focusID !== undefined &&
                event.buttons?.some(b => b.className === 'btn')) {
                const smallID = event.focusID;
                let playerName;
                try {
                    playerName = el.game.playerBySmallID(smallID)?.name?.() ?? ('Player ' + smallID);
                } catch (_) {
                    playerName = 'Player ' + smallID;
                }
                const acceptBtn = event.buttons.find(b => b.className === 'btn');

                if (autoRenewPlayers.has(smallID)) {
                    if (acceptBtn) {
                        try {
                            acceptBtn.action();
                        } catch (_) {}
                    }
                    return orig({
                        ...event,
                        description: '\u2B50 Auto-accepted alliance from ' + playerName,
                        buttons: [{
                            text: '\u2715 Stop AUTO',
                            className: 'btn-info',
                            action: () => {
                                autoRenewPlayers.delete(smallID);
                                refreshAutoRenewList();
                            },
                        }],
                        duration: 80,
                    });
                } else {
                    const autoBtn2 = {
                        text: '\u2B50 AUTO',
                        className: 'btn',
                        action: () => {
                            autoRenewPlayers.set(smallID, playerName);
                            refreshAutoRenewList();
                            if (acceptBtn) {
                                try {
                                    acceptBtn.action();
                                } catch (_) {}
                            }
                        },
                    };
                    return orig({
                        ...event,
                        buttons: [...(event.buttons ?? []), autoBtn2]
                    });
                }
            }

            return orig(event);
        };

        // Feature 1: Proactively send extensions / new requests for queued players every 5 s
        setInterval(function() {
            _doAutoSend(el);
        }, 5000);
    }

    function tryInitElement(el) {
        const interval = setInterval(() => {
            if (typeof el.addEvent === 'function' && el.game && el.eventBus) {
                clearInterval(interval);
                patchElement(el);
                styleObserver.observe(el, {
                    childList: true,
                    subtree: true
                });
                console.log('[AutoRenew] Patched events-display element.');
            }
        }, 100);
    }

    function watchForElement() {
        const existing = document.querySelector('events-display');
        if (existing) {
            tryInitElement(existing);
            return;
        }

        const bodyObserver = new MutationObserver((mutations, obs) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    let target = null;
                    if (node.tagName === 'EVENTS-DISPLAY') {
                        target = node;
                    } else {
                        target = node.querySelector?.('events-display') ?? null;
                    }
                    if (target) {
                        obs.disconnect();
                        tryInitElement(target);
                        return;
                    }
                }
            }
        });
        bodyObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // TURBO PLACE
    // ════════════════════════════════════════════════════════════════════════════

    const STEP = 25;
    const MIN_INTERVAL = 50;
    const MAX_INTERVAL = 2000;

    let eventBus = null;
    let uiState = null;
    let MouseUpEventCtor = null;

    let turboUnit = null;
    let turboKeyCode = null;
    let turboTimer = null;
    let mouseX = 0;
    let mouseY = 0;
    let indicator = null;
    let buildKeyMap = null;
    let proxyActive = false;
    let proxyVal = null;

    const KEYBIND_TO_UNIT_TYPE = {
        buildCity: 'City',
        buildFactory: 'Factory',
        buildPort: 'Port',
        buildDefensePost: 'Defense Post',
        buildMissileSilo: 'Missile Silo',
        buildSamLauncher: 'SAM Launcher',
        buildWarship: 'Warship',
        buildAtomBomb: 'Atom Bomb',
        buildHydrogenBomb: 'Hydrogen Bomb',
        buildMIRV: 'MIRV',
    };

    const DEFAULT_KEYBINDS = {
        buildCity: 'Digit1',
        buildFactory: 'Digit2',
        buildPort: 'Digit3',
        buildDefensePost: 'Digit4',
        buildMissileSilo: 'Digit5',
        buildSamLauncher: 'Digit6',
        buildWarship: 'Digit7',
        buildAtomBomb: 'Digit8',
        buildHydrogenBomb: 'Digit9',
        buildMIRV: 'Digit0',
    };

    function initGame() {
        const el = document.querySelector('events-display');
        if (!el || !el.eventBus || !el.uiState) return false;
        eventBus = el.eventBus;
        uiState = el.uiState;

        for (const [ctor, callbacks] of eventBus.listeners) {
            if (callbacks.some(fn => {
                    try {
                        return fn.toString().includes('createStructure');
                    } catch (_) {
                        return false;
                    }
                })) {
                MouseUpEventCtor = ctor;
                break;
            }
        }

        if (!MouseUpEventCtor) {
            console.warn('[TurboPlace] MouseUpEvent ctor not found.');
            eventBus = null;
            uiState = null;
            return false;
        }

        console.log('[TurboPlace] Initialized');
        return true;
    }

    function getBuildKeyMap() {
        const keybinds = {
            ...DEFAULT_KEYBINDS
        };
        try {
            const saved = localStorage.getItem('settings.keybinds');
            if (saved) {
                const parsed = JSON.parse(saved);
                for (const [name, value] of Object.entries(parsed)) {
                    if (!(name in keybinds)) continue;
                    if (typeof value === 'string') keybinds[name] = value;
                    else if (value && typeof value === 'object' && value.value) keybinds[name] = value.value;
                }
            }
        } catch (_) {}
        const map = {};
        for (const [keybindName, keyCode] of Object.entries(keybinds)) {
            const unitType = KEYBIND_TO_UNIT_TYPE[keybindName];
            if (unitType) map[keyCode] = unitType;
        }
        return map;
    }

    function installProxy() {
        if (proxyActive) return;
        proxyVal = uiState.ghostStructure;
        Object.defineProperty(uiState, 'ghostStructure', {
            configurable: true,
            enumerable: true,
            get() {
                return proxyVal;
            },
            set(v) {
                proxyVal = v;
                if (v === null && turboUnit !== null) proxyVal = turboUnit;
            },
        });
        proxyActive = true;
    }

    function removeProxy() {
        if (!proxyActive) return;
        Object.defineProperty(uiState, 'ghostStructure', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: null,
        });
        proxyActive = false;
        proxyVal = null;
    }

    function doPlace() {
        if (!turboUnit || !uiState || !MouseUpEventCtor) return;
        requestAnimationFrame(() => {
            if (!turboUnit) return;
            try {
                eventBus.emit(new MouseUpEventCtor(mouseX, mouseY));
            } catch (err) {
                console.warn('[TurboPlace] emit error:', err);
            }
        });
    }

    function stopTurbo() {
        if (turboTimer !== null) {
            clearInterval(turboTimer);
            turboTimer = null;
        }
        turboUnit = null;
        turboKeyCode = null;
        if (uiState) removeProxy();
        hideIndicator();
    }

    function createIndicator() {
        const div = document.createElement('div');
        Object.assign(div.style, {
            position: 'fixed',
            top: '44px', // sits below the star button
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.75)',
            color: '#f5a623',
            fontFamily: 'monospace',
            fontSize: '14px',
            fontWeight: 'bold',
            padding: '4px 14px',
            borderRadius: '6px',
            border: '1.5px solid #f5a623',
            pointerEvents: 'none',
            zIndex: '999999',
            display: 'none',
            letterSpacing: '0.05em',
        });
        document.body.appendChild(div);
        return div;
    }

    function showIndicator(unitType) {
        if (!indicator) indicator = createIndicator();
        indicator.textContent = 'TURBO: ' + unitType;
        indicator.style.display = 'block';
    }

    function hideIndicator() {
        if (indicator) indicator.style.display = 'none';
    }

    function applyInterval(newVal) {
        intervalMs = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, newVal));
        if (_turboIntervalLbl) _turboIntervalLbl.textContent = intervalMs + ' ms';
        if (_minusBtn) _minusBtn.disabled = (intervalMs <= MIN_INTERVAL);
        if (_plusBtn) _plusBtn.disabled = (intervalMs >= MAX_INTERVAL);
        if (turboTimer !== null) {
            clearInterval(turboTimer);
            turboTimer = setInterval(doPlace, intervalMs);
        }
        savePrefs();
    }

    window.addEventListener('mousemove', e => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    }, {
        capture: true,
        passive: true
    });

    window.addEventListener('keydown', e => {
        if (!turboEnabled || e.repeat) return;
        if (!buildKeyMap) buildKeyMap = getBuildKeyMap();
        const unitType = buildKeyMap[e.code];
        if (!unitType) return;
        if (!eventBus && !initGame()) return;
        if (turboTimer !== null) stopTurbo();
        turboUnit = unitType;
        turboKeyCode = e.code;
        uiState.ghostStructure = turboUnit;
        installProxy();
        showIndicator(unitType);
        turboTimer = setInterval(doPlace, intervalMs);
    }, {
        capture: true
    });

    window.addEventListener('keyup', e => {
        if (!turboEnabled || e.code !== turboKeyCode) return;
        stopTurbo();
        e.stopPropagation();
        e.preventDefault();
    }, {
        capture: true
    });

    // ════════════════════════════════════════════════════════════════════════════
    // UI  — star button + centered menu panel with three tabs
    // ════════════════════════════════════════════════════════════════════════════

    function setupUI() {

        // ── Styles ────────────────────────────────────────────────────────────────
        const style = document.createElement('style');
        style.textContent = `
      /* Auto-Renew gold button override */
      events-display button[data-ar-styled="1"] { background-color: #c8950a !important; }
      events-display button[data-ar-styled="1"]:hover { background-color: #a07808 !important; }

      /* Menu panel */
      #of-suite-panel {
        position: fixed;
        top: 50%; left: 50%; transform: translate(-50%, -50%);
        z-index: 100000;
        width: 380px;
        background: rgba(17,24,39,0.92);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        border: 1px solid rgba(100,116,139,0.4);
        border-radius: 10px;
        padding: 0;
        font-family: sans-serif; color: #fff;
        box-shadow: 0 20px 60px rgba(0,0,0,0.7);
        display: none;
      }
      #of-suite-panel.of-visible {
        display: block;
        animation: ofFadeIn 0.15s ease-out;
      }
      @keyframes ofFadeIn {
        from { opacity: 0; transform: translate(-50%, -53%); }
        to   { opacity: 1; transform: translate(-50%, -50%); }
      }

      /* Header */
      #of-suite-header {
        background: rgba(31,41,55,0.6);
        border-bottom: 1px solid rgba(100,116,139,0.3);
        border-radius: 10px 10px 0 0;
        padding: 10px 14px;
        display: flex; justify-content: space-between; align-items: center;
      }
      #of-suite-header-title { font-weight: bold; font-size: 14px; letter-spacing: 0.04em; }
      #of-suite-close {
        background: none; border: none; color: rgba(255,255,255,0.6);
        cursor: pointer; font-size: 16px; padding: 0 2px; line-height: 1;
        transition: color 0.15s;
      }
      #of-suite-close:hover { color: #fff; }

      /* Tab bar */
      #of-suite-tabs { display: flex; border-bottom: 1px solid rgba(100,116,139,0.3); }
      .of-tab {
        flex: 1; padding: 8px 4px;
        background: none; border: none; border-bottom: 2px solid transparent;
        color: rgba(255,255,255,0.55); cursor: pointer;
        font-size: 12px; font-family: sans-serif;
        transition: color 0.15s, background 0.15s;
      }
      .of-tab:hover { color: rgba(255,255,255,0.85); }
      .of-tab.of-tab-active {
        background: rgba(37,99,235,0.25);
        color: #60a5fa;
        border-bottom: 2px solid #2563eb;
      }

      /* Content */
      #of-suite-content { padding: 14px; }
      .of-tab-pane { display: none; }
      .of-tab-pane.of-pane-active { display: block; }

      /* Shared row / pill */
      .of-toggle-row {
        display: flex; justify-content: space-between; align-items: center;
        margin-bottom: 10px;
      }
      .of-toggle-label { font-size: 13px; font-weight: bold; }
      .of-pill {
        border: none; border-radius: 12px; padding: 3px 10px;
        font-size: 12px; font-weight: bold; cursor: pointer; color: #fff;
        transition: background 0.2s;
      }
      .of-pill-on  { background: #16a34a; }
      .of-pill-off { background: #dc2626; }
      .of-divider {
        border: none; border-top: 1px solid rgba(100,116,139,0.25);
        margin: 10px 0;
      }

      /* Auto-Renew list */
      #of-ar-list {
        max-height: 180px; overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.2) transparent;
      }
      #of-ar-list::-webkit-scrollbar { width: 4px; }
      #of-ar-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }

      /* Turbo interval row */
      .of-interval-row {
        display: flex; align-items: center; justify-content: center;
        gap: 6px; margin-top: 6px;
      }
      .of-interval-btn {
        width: 26px; height: 26px; border-radius: 4px;
        border: none; background: #374151; color: #fff;
        cursor: pointer; font-size: 16px; font-weight: bold;
        display: flex; align-items: center; justify-content: center;
        transition: background 0.15s;
      }
      .of-interval-btn:hover { background: #4b5563; }
      .of-interval-btn:disabled { background: #1f2937; color: rgba(255,255,255,0.2); cursor: not-allowed; }
      .of-interval-btn:disabled:hover { background: #1f2937; }
      .of-interval-lbl {
        font-family: monospace; font-size: 13px; color: #f5a623;
        min-width: 60px; text-align: center; cursor: pointer;
      }

      /* Nuke description text */
      .of-nuke-desc {
        font-size: 12px; color: rgba(255,255,255,0.45);
        line-height: 1.5; margin-top: 6px;
      }

      /* Section sub-label */
      .of-section-label {
        font-size: 11px; color: rgba(255,255,255,0.45);
        margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.05em;
      }

      /* FPS Limiter segmented control */
      .of-seg-group { display: flex; gap: 2px; }
      .of-seg-btn {
        border: 1px solid rgba(100,116,139,0.4);
        background: rgba(31,41,55,0.6);
        color: rgba(255,255,255,0.6);
        padding: 3px 12px; font-size: 12px; font-weight: bold;
        cursor: pointer; transition: all 0.15s; font-family: monospace;
      }
      .of-seg-btn:first-child { border-radius: 6px 0 0 6px; }
      .of-seg-btn:last-child  { border-radius: 0 6px 6px 0; }
      .of-seg-btn.of-seg-active { background: #2563eb; color: #fff; border-color: #2563eb; }
      .of-seg-btn:hover:not(.of-seg-active) { background: rgba(55,65,81,0.8); color: #fff; }

      /* Performance stats display */
      #of-perf-stats {
        font-family: monospace; font-size: 12px;
        color: rgba(255,255,255,0.7); line-height: 1.8;
        padding: 6px 8px; background: rgba(0,0,0,0.3);
        border-radius: 6px; margin-bottom: 2px;
      }
      #of-perf-stats b { color: #60a5fa; }
    `;
        document.head.appendChild(style);

        // ── Panel ─────────────────────────────────────────────────────────────────
        const panel = document.createElement('div');
        panel.id = 'of-suite-panel';

        // Header
        const header = document.createElement('div');
        header.id = 'of-suite-header';
        const headerTitle = document.createElement('span');
        headerTitle.id = 'of-suite-header-title';
        headerTitle.textContent = '\uD83D\uDEE0\uFE0F OpenFront Toolkit';
        const closeBtn = document.createElement('button');
        closeBtn.id = 'of-suite-close';
        closeBtn.textContent = '\u2715';
        closeBtn.title = 'Close';
        header.appendChild(headerTitle);
        header.appendChild(closeBtn);

        // Tab bar
        const tabBar = document.createElement('div');
        tabBar.id = 'of-suite-tabs';
        const tabLabels = ['Auto-Renew', 'Turbo Place', 'Trackers', 'Performance'];
        const tabEls = tabLabels.map((name, i) => {
            const t = document.createElement('button');
            t.className = 'of-tab' + (i === 0 ? ' of-tab-active' : '');
            t.textContent = name;
            tabBar.appendChild(t);
            return t;
        });

        // Content area
        const content = document.createElement('div');
        content.id = 'of-suite-content';

        // ── Tab 0: Auto-Renew ────────────────────────────────────────────────────
        const pane0 = document.createElement('div');
        pane0.className = 'of-tab-pane of-pane-active';

        const arToggleRow = document.createElement('div');
        arToggleRow.className = 'of-toggle-row';
        const arLabel = document.createElement('span');
        arLabel.className = 'of-toggle-label';
        arLabel.textContent = 'Auto-Renew';
        _pillAR = document.createElement('button');
        _pillAR.className = 'of-pill ' + (autoRenewEnabled ? 'of-pill-on' : 'of-pill-off');
        _pillAR.textContent = autoRenewEnabled ? 'ON' : 'OFF';
        _pillAR.addEventListener('click', () => {
            autoRenewEnabled = !autoRenewEnabled;
            _pillAR.textContent = autoRenewEnabled ? 'ON' : 'OFF';
            _pillAR.className = 'of-pill ' + (autoRenewEnabled ? 'of-pill-on' : 'of-pill-off');
            savePrefs();
        });
        arToggleRow.appendChild(arLabel);
        arToggleRow.appendChild(_pillAR);

        const arDivider = document.createElement('hr');
        arDivider.className = 'of-divider';

        const arListLabel = document.createElement('div');
        arListLabel.className = 'of-section-label';
        arListLabel.textContent = 'Auto-Renew List';

        _arListContainer = document.createElement('div');
        _arListContainer.id = 'of-ar-list';
        refreshAutoRenewList();

        const arDesc = document.createElement('div');
        arDesc.className = 'of-nuke-desc';
        arDesc.textContent = 'Automatically re-accepts alliance requests from queued players. Add players via the \u2B50 AUTO Renew button that appears on renewal prompts.';

        const arDescDivider = document.createElement('hr');
        arDescDivider.className = 'of-divider';

        pane0.appendChild(arToggleRow);
        pane0.appendChild(arDivider);
        pane0.appendChild(arDesc);
        pane0.appendChild(arDescDivider);
        pane0.appendChild(arListLabel);
        pane0.appendChild(_arListContainer);

        // ── Tab 1: Turbo Place ───────────────────────────────────────────────────
        const pane1 = document.createElement('div');
        pane1.className = 'of-tab-pane';

        const tpToggleRow = document.createElement('div');
        tpToggleRow.className = 'of-toggle-row';
        const tpLabel = document.createElement('span');
        tpLabel.className = 'of-toggle-label';
        tpLabel.textContent = 'Turbo Place';
        _pillTP = document.createElement('button');
        _pillTP.className = 'of-pill ' + (turboEnabled ? 'of-pill-on' : 'of-pill-off');
        _pillTP.textContent = turboEnabled ? 'ON' : 'OFF';
        _pillTP.addEventListener('click', () => {
            turboEnabled = !turboEnabled;
            if (!turboEnabled) stopTurbo();
            _pillTP.textContent = turboEnabled ? 'ON' : 'OFF';
            _pillTP.className = 'of-pill ' + (turboEnabled ? 'of-pill-on' : 'of-pill-off');
            savePrefs();
        });
        tpToggleRow.appendChild(tpLabel);
        tpToggleRow.appendChild(_pillTP);

        const tpDivider = document.createElement('hr');
        tpDivider.className = 'of-divider';

        const tpSectionLabel = document.createElement('div');
        tpSectionLabel.className = 'of-section-label';
        tpSectionLabel.textContent = 'Placement Interval';

        const intervalRow = document.createElement('div');
        intervalRow.className = 'of-interval-row';

        _minusBtn = document.createElement('button');
        _minusBtn.className = 'of-interval-btn';
        _minusBtn.textContent = '\u2212';
        _minusBtn.disabled = (intervalMs <= MIN_INTERVAL);

        _turboIntervalLbl = document.createElement('span');
        _turboIntervalLbl.className = 'of-interval-lbl';
        _turboIntervalLbl.textContent = intervalMs + ' ms';
        _turboIntervalLbl.title = 'Click to enter custom ms';

        _plusBtn = document.createElement('button');
        _plusBtn.className = 'of-interval-btn';
        _plusBtn.textContent = '+';
        _plusBtn.disabled = (intervalMs >= MAX_INTERVAL);

        const minusBtn = _minusBtn;
        const plusBtn = _plusBtn;

        minusBtn.addEventListener('click', () => applyInterval(intervalMs - STEP));
        plusBtn.addEventListener('click', () => applyInterval(intervalMs + STEP));

        _turboIntervalLbl.addEventListener('click', () => {
            const input = document.createElement('input');
            Object.assign(input.style, {
                fontFamily: 'monospace',
                fontSize: '13px',
                width: '60px',
                textAlign: 'center',
                background: '#1f2937',
                color: '#f5a623',
                border: '1px solid #f5a623',
                borderRadius: '3px',
                padding: '1px 4px',
            });
            input.type = 'number';
            input.min = MIN_INTERVAL;
            input.max = MAX_INTERVAL;
            input.value = intervalMs;
            intervalRow.replaceChild(input, _turboIntervalLbl);
            input.focus();
            input.select();
            const commit = () => {
                const v = parseInt(input.value, 10);
                if (!isNaN(v)) applyInterval(v);
                intervalRow.replaceChild(_turboIntervalLbl, input);
                _turboIntervalLbl.textContent = intervalMs + ' ms';
            };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') {
                    commit();
                    ev.preventDefault();
                }
                if (ev.key === 'Escape') {
                    intervalRow.replaceChild(_turboIntervalLbl, input);
                }
                ev.stopPropagation();
            }, {
                capture: true
            });
        });

        intervalRow.appendChild(minusBtn);
        intervalRow.appendChild(_turboIntervalLbl);
        intervalRow.appendChild(plusBtn);

        const tpDesc = document.createElement('div');
        tpDesc.className = 'of-nuke-desc';
        tpDesc.textContent = 'Continuously places structures while a build key is held. Use the interval control below to tune placement speed.';

        const tpDescDivider = document.createElement('hr');
        tpDescDivider.className = 'of-divider';

        pane1.appendChild(tpToggleRow);
        pane1.appendChild(tpDivider);
        pane1.appendChild(tpDesc);
        pane1.appendChild(tpDescDivider);
        pane1.appendChild(tpSectionLabel);
        pane1.appendChild(intervalRow);

        // ── Tab 2: Nuke Tracker ──────────────────────────────────────────────────
        const pane2 = document.createElement('div');
        pane2.className = 'of-tab-pane';

        const nkToggleRow = document.createElement('div');
        nkToggleRow.className = 'of-toggle-row';
        const nkLabel = document.createElement('span');
        nkLabel.className = 'of-toggle-label';
        nkLabel.textContent = 'Nuke Tracker';
        _pillNK = document.createElement('button');
        _pillNK.className = 'of-pill ' + (nukeEnabled ? 'of-pill-on' : 'of-pill-off');
        _pillNK.textContent = nukeEnabled ? 'ON' : 'OFF';
        _pillNK.addEventListener('click', () => {
            nukeEnabled = !nukeEnabled;
            _pillNK.textContent = nukeEnabled ? 'ON' : 'OFF';
            _pillNK.className = 'of-pill ' + (nukeEnabled ? 'of-pill-on' : 'of-pill-off');
            if (!nukeEnabled) {
                nukeMap.clear();
                if (overlayCtx && overlayCanvas) {
                    if (boatEnabled && boatMap.size > 0) {
                        _scheduleDraw();
                    } else {
                        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                    }
                }
            }
            savePrefs();
        });
        nkToggleRow.appendChild(nkLabel);
        nkToggleRow.appendChild(_pillNK);

        const nkDivider = document.createElement('hr');
        nkDivider.className = 'of-divider';

        const nkDesc = document.createElement('div');
        nkDesc.className = 'of-nuke-desc';
        nkDesc.textContent = 'Displays flight paths and countdown timers for all airborne nukes.';

        const btToggleRow = document.createElement('div');
        btToggleRow.className = 'of-toggle-row';
        const btLabel = document.createElement('span');
        btLabel.className = 'of-toggle-label';
        btLabel.textContent = 'Boat Tracker';
        _pillBT = document.createElement('button');
        _pillBT.className = 'of-pill ' + (boatEnabled ? 'of-pill-on' : 'of-pill-off');
        _pillBT.textContent = boatEnabled ? 'ON' : 'OFF';
        _pillBT.addEventListener('click', () => {
            boatEnabled = !boatEnabled;
            _pillBT.textContent = boatEnabled ? 'ON' : 'OFF';
            _pillBT.className = 'of-pill ' + (boatEnabled ? 'of-pill-on' : 'of-pill-off');
            if (!boatEnabled) {
                boatMap.clear();
                if (overlayCtx && overlayCanvas) {
                    if (nukeEnabled && nukeMap.size > 0) {
                        _scheduleDraw();
                    } else {
                        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
                    }
                }
            }
            savePrefs();
        });
        btToggleRow.appendChild(btLabel);
        btToggleRow.appendChild(_pillBT);

        const btDesc = document.createElement('div');
        btDesc.className = 'of-nuke-desc';
        btDesc.textContent = 'Shows the path every transport ship on the map as an orange dashed line to its landing zone.';

        pane2.appendChild(nkToggleRow);
        pane2.appendChild(nkDivider);
        pane2.appendChild(nkDesc);

        const nkBtDivider = document.createElement('hr');
        nkBtDivider.className = 'of-divider';
        pane2.appendChild(nkBtDivider);

        pane2.appendChild(btToggleRow);
        pane2.appendChild(btDesc);



        // ── Tab 3: Performance ───────────────────────────────────────────────────
        const pane3 = document.createElement('div');
        pane3.className = 'of-tab-pane';

        // Live stats
        const perfStatsLabel = document.createElement('div');
        perfStatsLabel.className = 'of-section-label';
        perfStatsLabel.textContent = 'Live Stats';
        _statsContainer = document.createElement('div');
        _statsContainer.id = 'of-perf-stats';
        _statsContainer.innerHTML =
            '<div>FPS: <b>-</b> &nbsp;&nbsp; Frame: <b>- ms</b></div>' +
            '<div>TPS: <b>-</b> &nbsp;&nbsp; Nukes: <b>-</b> &nbsp;&nbsp; Units: <b>-</b></div>';

        const perfDiv1 = document.createElement('hr');
        perfDiv1.className = 'of-divider';

        // FPS Limiter
        const fpsRow = document.createElement('div');
        fpsRow.className = 'of-toggle-row';
        const fpsLabel = document.createElement('span');
        fpsLabel.className = 'of-toggle-label';
        fpsLabel.textContent = 'FPS Limit';
        const fpsGroup = document.createElement('div');
        fpsGroup.className = 'of-seg-group';
        const _fpsOptions = [15, 30, 0];
        const _fpsLbls = ['15', '30', 'Off'];
        _pillFpsLimit = _fpsOptions.map(function(val, idx) {
            const b = document.createElement('button');
            b.className = 'of-seg-btn' + (perfFpsLimit === val ? ' of-seg-active' : '');
            b.textContent = _fpsLbls[idx];
            b.addEventListener('click', function() {
                perfFpsLimit = val;
                _fpsLimitMinInterval = (val > 0) ? (1000 / val) : 0;
                _pillFpsLimit.forEach(function(btn, i) {
                    btn.className = 'of-seg-btn' + (_fpsOptions[i] === val ? ' of-seg-active' : '');
                });
                savePrefs();
            });
            fpsGroup.appendChild(b);
            return b;
        });
        fpsRow.appendChild(fpsLabel);
        fpsRow.appendChild(fpsGroup);

        const perfDiv2 = document.createElement('hr');
        perfDiv2.className = 'of-divider';

        // Render toggles
        const renderLabel = document.createElement('div');
        renderLabel.className = 'of-section-label';
        renderLabel.textContent = 'Render Toggles';

        function makePerfToggle(labelText, getState, onToggle) {
            const row = document.createElement('div');
            row.className = 'of-toggle-row';
            const lbl = document.createElement('span');
            lbl.className = 'of-toggle-label';
            lbl.textContent = labelText;
            const pill = document.createElement('button');
            pill.className = 'of-pill ' + (getState() ? 'of-pill-on' : 'of-pill-off');
            pill.textContent = getState() ? 'ON' : 'OFF';
            pill.addEventListener('click', function() {
                const s = onToggle();
                pill.textContent = s ? 'ON' : 'OFF';
                pill.className = 'of-pill ' + (s ? 'of-pill-on' : 'of-pill-off');
                savePrefs();
            });
            row.appendChild(lbl);
            row.appendChild(pill);
            return {
                row,
                pill
            };
        }

        const nukesT = makePerfToggle('Disable Nuke Rendering', () => perfHideNukes, () => {
            perfHideNukes = !perfHideNukes;
            return perfHideNukes;
        });
        const warshipsT = makePerfToggle('Disable Warship Rendering', () => perfHideWarships, () => {
            perfHideWarships = !perfHideWarships;
            return perfHideWarships;
        });
        const trainsT = makePerfToggle('Disable Train Rendering', () => perfHideTrains, () => {
            perfHideTrains = !perfHideTrains;
            return perfHideTrains;
        });
        const tradeT = makePerfToggle('Disable Trade Boat Rendering', () => perfHideTradeBoats, () => {
            perfHideTradeBoats = !perfHideTradeBoats;
            return perfHideTradeBoats;
        });

        const perfDiv3 = document.createElement('hr');
        perfDiv3.className = 'of-divider';

        // Anti-AFK / Connection
        const connLabel = document.createElement('div');
        connLabel.className = 'of-section-label';
        connLabel.textContent = 'Connection';

        const afkT = makePerfToggle('Anti-AFK Ping', () => perfAntiAfk, () => {
            perfAntiAfk = !perfAntiAfk;
            if (perfAntiAfk) {
                startAntiAfk();
            } else {
                stopAntiAfk();
            }
            return perfAntiAfk;
        });
        _pillAntiAfk = afkT.pill;

        const afkDesc = document.createElement('div');
        afkDesc.className = 'of-nuke-desc';
        afkDesc.textContent = 'Sends keep-alive pings every 2s. Prevents being marked disconnected during lag, which would let allies attack you.';

        pane3.appendChild(perfStatsLabel);
        pane3.appendChild(_statsContainer);
        pane3.appendChild(perfDiv1);
        pane3.appendChild(fpsRow);
        pane3.appendChild(perfDiv2);
        pane3.appendChild(renderLabel);
        pane3.appendChild(nukesT.row);
        pane3.appendChild(warshipsT.row);
        pane3.appendChild(trainsT.row);
        pane3.appendChild(tradeT.row);
        pane3.appendChild(perfDiv3);
        pane3.appendChild(connLabel);
        pane3.appendChild(afkT.row);
        pane3.appendChild(afkDesc);

        // Start stats updater
        setInterval(updatePerfStats, 500);

        // ── Assemble ──────────────────────────────────────────────────────────────
        content.appendChild(pane0);
        content.appendChild(pane1);
        content.appendChild(pane2);
        content.appendChild(pane3);
        panel.appendChild(header);
        panel.appendChild(tabBar);
        panel.appendChild(content);
        document.body.appendChild(panel);

        // ── Tab switching ─────────────────────────────────────────────────────────
        const panes = [pane0, pane1, pane2, pane3];
        tabEls.forEach((tabEl, i) => {
            tabEl.addEventListener('click', () => {
                tabEls.forEach(t => {
                    t.className = 'of-tab';
                });
                tabEl.className = 'of-tab of-tab-active';
                panes.forEach(p => {
                    p.className = 'of-tab-pane';
                });
                panes[i].className = 'of-tab-pane of-pane-active';
            });
        });

        // ── Open / close ──────────────────────────────────────────────────────────
        closeBtn.addEventListener('click', () => {
            panel.classList.remove('of-visible');
        });

        // ── Drag by header ────────────────────────────────────────────────────────
        header.style.cursor = 'grab';
        let _dragActive = false,
            _dragOx = 0,
            _dragOy = 0;

        header.addEventListener('mousedown', e => {
            if (e.target === closeBtn) return;
            _dragActive = true;
            const rect = panel.getBoundingClientRect();
            // Switch from transform-based centering to explicit pixel position
            panel.style.transform = 'none';
            panel.style.left = rect.left + 'px';
            panel.style.top = rect.top + 'px';
            _dragOx = e.clientX - rect.left;
            _dragOy = e.clientY - rect.top;
            header.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!_dragActive) return;
            panel.style.left = (e.clientX - _dragOx) + 'px';
            panel.style.top = (e.clientY - _dragOy) + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!_dragActive) return;
            _dragActive = false;
            header.style.cursor = 'grab';
        });

        setupSidebarButton(panel);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // SIDEBAR BUTTON — inject ⭐ into game-right-sidebar between settings & exit
    // ════════════════════════════════════════════════════════════════════════════

    function setupSidebarButton(panel) {
        let asideObserver = null;

        function injectStarBtn(aside) {
            if (aside.querySelector('#of-suite-btn')) return;
            const exitImg = aside.querySelector('img[alt="exit"]');
            if (!exitImg) return;
            const exitDiv = exitImg.parentElement;
            if (!exitDiv) return;

            const btn = document.createElement('div');
            btn.id = 'of-suite-btn';
            btn.className = 'cursor-pointer';
            btn.style.cssText = 'font-size:18px;line-height:1;user-select:none;';
            btn.textContent = '\uD83D\uDEE0\uFE0F';
            btn.title = 'OpenFront Toolkit';
            btn.addEventListener('click', e => {
                e.stopPropagation();
                if (panel.classList.contains('of-visible')) {
                    panel.classList.remove('of-visible');
                } else {
                    refreshAutoRenewList();
                    panel.classList.add('of-visible');
                }
            });
            exitDiv.parentElement.insertBefore(btn, exitDiv);
        }

        function attachToSidebar(sidebar) {
            const tryInject = () => {
                const aside = sidebar.querySelector('aside');
                if (!aside || !aside.querySelector('img[alt="exit"]')) return false;
                injectStarBtn(aside);
                if (asideObserver) asideObserver.disconnect();
                asideObserver = new MutationObserver(() => injectStarBtn(aside));
                asideObserver.observe(aside, {
                    childList: true
                });
                return true;
            };

            if (!tryInject()) {
                const waitObserver = new MutationObserver((_, obs) => {
                    if (tryInject()) obs.disconnect();
                });
                waitObserver.observe(sidebar, {
                    childList: true,
                    subtree: true
                });
            }
        }

        const bodyObserver = new MutationObserver(() => {
            const sidebar = document.querySelector('game-right-sidebar');
            if (sidebar && !sidebar.dataset.ofWatched) {
                sidebar.dataset.ofWatched = '1';
                attachToSidebar(sidebar);
            }
            if (!sidebar && asideObserver) {
                asideObserver.disconnect();
                asideObserver = null;
            }
        });
        bodyObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        // Immediate check if already in a game
        const existing = document.querySelector('game-right-sidebar');
        if (existing) {
            existing.dataset.ofWatched = '1';
            attachToSidebar(existing);
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // PREFERENCES
    // ════════════════════════════════════════════════════════════════════════════

    const PREFS_KEY = 'ofToolkit.prefs';

    function savePrefs() {
        try {
            localStorage.setItem(PREFS_KEY, JSON.stringify({
                nukeEnabled,
                boatEnabled,
                autoRenewEnabled,
                turboEnabled,
                intervalMs,
                perfFpsLimit,
                perfHideNukes,
                perfHideWarships,
                perfHideTrains,
                perfHideTradeBoats,
                perfAntiAfk,
            }));
        } catch (_) {}
    }

    function loadPrefs() {
        try {
            const raw = localStorage.getItem(PREFS_KEY);
            if (!raw) return;
            const p = JSON.parse(raw);
            if (typeof p.nukeEnabled === 'boolean') nukeEnabled = p.nukeEnabled;
            if (typeof p.boatEnabled === 'boolean') boatEnabled = p.boatEnabled;
            if (typeof p.autoRenewEnabled === 'boolean') autoRenewEnabled = p.autoRenewEnabled;
            if (typeof p.turboEnabled === 'boolean') turboEnabled = p.turboEnabled;
            if (typeof p.intervalMs === 'number')
                intervalMs = Math.max(MIN_INTERVAL, Math.min(MAX_INTERVAL, p.intervalMs));
            if (typeof p.perfFpsLimit === 'number' && [0, 15, 30].includes(p.perfFpsLimit))
                perfFpsLimit = p.perfFpsLimit;
            if (typeof p.perfHideNukes === 'boolean') perfHideNukes = p.perfHideNukes;
            if (typeof p.perfHideWarships === 'boolean') perfHideWarships = p.perfHideWarships;
            if (typeof p.perfHideTrains === 'boolean') perfHideTrains = p.perfHideTrains;
            if (typeof p.perfHideTradeBoats === 'boolean') perfHideTradeBoats = p.perfHideTradeBoats;
            if (typeof p.perfAntiAfk === 'boolean') perfAntiAfk = p.perfAntiAfk;
        } catch (_) {}
    }

    // ════════════════════════════════════════════════════════════════════════════
    // BOOT
    // ════════════════════════════════════════════════════════════════════════════

    loadPrefs();

    // Apply performance settings from saved prefs immediately
    if (perfFpsLimit > 0) _fpsLimitMinInterval = 1000 / perfFpsLimit;
    if (perfAntiAfk) startAntiAfk();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setupUI();
            watchForElement();
        });
    } else {
        setupUI();
        watchForElement();
    }

})();
