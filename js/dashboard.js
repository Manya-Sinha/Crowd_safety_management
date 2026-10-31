            let wasRed = false;
            let wasCritical = false;
            const ZONE_LABELS = { green: 'SAFE', orange: 'MEDIUM', red: 'CRITICAL' };
            const ZONE_ICONS  = { green: '&#10003;', orange: '&#9888;', red: '&#128721;' };

            // Dynamic capacity state
            let customCapacity = null;
            try {
                const saved = localStorage.getItem('crowd_custom_capacity');
                if (saved) {
                    const parsed = parseInt(saved, 10);
                    if (!isNaN(parsed) && parsed > 0) customCapacity = parsed;
                }
            } catch (e) {}

            let lastStatusData = null;

            // High-Alert Alarm via Web Audio API (Pulsed Dual Tones: 880Hz & 1000Hz Square Waves)
            let audioCtx = null;
            let alarmInterval = null;
            let isAlarmPlaying = false;
            let isAudioMuted = false;
            let activeAlarmOscillators = [];
            let masterAlarmGain = null;

            function initAudio() {
                if (!audioCtx) {
                    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                    if (AudioContextClass) audioCtx = new AudioContextClass();
                }
                if (audioCtx && audioCtx.state === 'suspended') {
                    audioCtx.resume().catch(() => {});
                }
                return audioCtx;
            }

            // Unlock audio on first user gesture
            ['click', 'keydown', 'touchstart'].forEach(evt => {
                window.addEventListener(evt, () => initAudio(), { passive: true });
            });

            function playUrgentDualBeep() {
                if (!isAlarmPlaying || isAudioMuted) return;
                const ctx = initAudio();
                if (!ctx) return;
                try {
                    const now = ctx.currentTime;
                    masterAlarmGain = ctx.createGain();
                    masterAlarmGain.gain.setValueAtTime(0.28, now);
                    masterAlarmGain.connect(ctx.destination);

                    // Tone 1: 880Hz square wave (0.00s to 0.09s)
                    const osc1 = ctx.createOscillator();
                    osc1.type = 'square';
                    osc1.frequency.setValueAtTime(880, now);
                    osc1.connect(masterAlarmGain);
                    osc1.start(now);
                    osc1.stop(now + 0.09);

                    // Tone 2: 1000Hz square wave (0.11s to 0.20s)
                    const osc2 = ctx.createOscillator();
                    osc2.type = 'square';
                    osc2.frequency.setValueAtTime(1000, now + 0.11);
                    osc2.connect(masterAlarmGain);
                    osc2.start(now + 0.11);
                    osc2.stop(now + 0.20);

                    activeAlarmOscillators = [osc1, osc2];
                    osc2.onended = () => {
                        activeAlarmOscillators = [];
                    };
                } catch (e) {
                    console.warn("High-alert alarm sound error:", e);
                }
            }

            function startAudioAlarm() {
                if (isAlarmPlaying) return;
                isAlarmPlaying = true;
                initAudio();
                playUrgentDualBeep();
                if (alarmInterval) clearInterval(alarmInterval);
                alarmInterval = setInterval(playUrgentDualBeep, 320); // rapid, urgent alarm repetition
                updateAudioButtonUI();
            }

            function stopAudioAlarm() {
                if (!isAlarmPlaying && !alarmInterval) return;
                isAlarmPlaying = false;
                if (alarmInterval) {
                    clearInterval(alarmInterval);
                    alarmInterval = null;
                }
                // Instant cutoff of any sounding tone
                if (masterAlarmGain && audioCtx) {
                    try {
                        masterAlarmGain.gain.setValueAtTime(0, audioCtx.currentTime);
                        masterAlarmGain.disconnect();
                    } catch (e) {}
                }
                activeAlarmOscillators.forEach(osc => {
                    try { osc.stop(); } catch (e) {}
                });
                activeAlarmOscillators = [];
                updateAudioButtonUI();
            }

            function toggleAudioMute() {
                initAudio();
                isAudioMuted = !isAudioMuted;
                if (!isAudioMuted && wasCritical) {
                    playUrgentDualBeep();
                }
                updateAudioButtonUI();
            }

            function updateAudioButtonUI() {
                const btn = document.getElementById('audio-toggle-btn');
                if (!btn) return;
                if (isAudioMuted) {
                    btn.className = 'btn audio-btn muted';
                    btn.innerHTML = '🔇 Sound: Muted';
                } else if (isAlarmPlaying) {
                    btn.className = 'btn audio-btn sounding';
                    btn.innerHTML = '🔊 Alarm: CRITICAL';
                } else {
                    btn.className = 'btn audio-btn active';
                    btn.innerHTML = '🔊 Audio Alarm: ON';
                }
            }

            function getEffectiveCapacity(serverCap) {
                if (customCapacity !== null && customCapacity > 0) {
                    return customCapacity;
                }
                return (serverCap && serverCap > 0) ? serverCap : 10;
            }

            function promptChangeCapacity() {
                initAudio();
                const serverCap = lastStatusData ? lastStatusData.max_capacity : 10;
                const currentCap = getEffectiveCapacity(serverCap);
                const input = prompt(
                    "Enter new maximum capacity number (positive integer):\n(Enter 'reset' to revert to server default of " + serverCap + ")",
                    currentCap
                );
                if (input === null) return;

                const trimmed = input.trim();
                if (trimmed.toLowerCase() === 'reset') {
                    customCapacity = null;
                    try { localStorage.removeItem('crowd_custom_capacity'); } catch (e) {}
                    if (lastStatusData) renderDashboard(lastStatusData);
                    return;
                }

                const parsed = parseInt(trimmed, 10);
                if (isNaN(parsed) || parsed <= 0) {
                    alert("Please enter a valid positive number for capacity.");
                    return;
                }

                customCapacity = parsed;
                try {
                    localStorage.setItem('crowd_custom_capacity', parsed);
                } catch (e) {}

                if (lastStatusData) {
                    renderDashboard(lastStatusData);
                }
            }

            function updateThresholdsUI(capacity) {
                const safeMax = Math.ceil(capacity * 0.6) - 1;
                const medMin = Math.ceil(capacity * 0.6);
                const medMax = Math.ceil(capacity * 0.9) - 1;
                const critMin = Math.ceil(capacity * 0.9);

                const safeEl = document.getElementById('thresh-safe-text');
                const medEl = document.getElementById('thresh-med-text');
                const critEl = document.getElementById('thresh-crit-text');

                if (safeEl) safeEl.textContent = `< ${medMin} (0-${Math.max(0, safeMax)})`;
                if (medEl) medEl.textContent = `${medMin} - ${Math.max(medMin, medMax)}`;
                if (critEl) critEl.textContent = `≥ ${critMin}`;
            }

            function evaluateZone(peopleInside, capacity) {
                const ratio = capacity > 0 ? peopleInside / capacity : 0;
                if (ratio >= 0.9) {
                    return { color: 'red', label: 'CRITICAL', isCritical: true };
                } else if (ratio >= 0.6) {
                    return { color: 'orange', label: 'MEDIUM', isCritical: false };
                } else {
                    return { color: 'green', label: 'SAFE', isCritical: false };
                }
            }

            function showTab(name) {
                document.getElementById('tab-live').classList.toggle('active', name === 'live');
                document.getElementById('tab-history').classList.toggle('active', name === 'history');
                // # --- DATABASE INTEGRATION ---
                document.getElementById('tab-past').classList.toggle('active', name === 'past');
                document.getElementById('tab-live-btn').classList.toggle('active', name === 'live');
                document.getElementById('tab-history-btn').classList.toggle('active', name === 'history');
                document.getElementById('tab-past-btn').classList.toggle('active', name === 'past');
                if (name === 'past') fetchPastData();
            }

            function resetCounts() {
                fetch('/reset').then(refresh);
            }

            function renderAlerts(alerts) {
                const list = document.getElementById('alert-list');
                list.innerHTML = alerts.map(a =>
                    `<div class="alert-row ${a.type}"><span class="time">${a.time}</span>${a.message}</div>`
                ).join('') || '<p style="color:#8b8fa3;">No alerts yet.</p>';
            }

            function drawGraph(history, maxCapacity, zoneColor) {
                const canvas = document.getElementById('crowd-canvas');
                const ctx = canvas.getContext('2d');
                const W = canvas.width, H = canvas.height;
                const padL = 40, padR = 20, padT = 20, padB = 30;
                const plotW = W - padL - padR;
                const plotH = H - padT - padB;

                ctx.clearRect(0, 0, W, H);

                if (!history || history.length === 0) {
                    ctx.fillStyle = '#8b8fa3';
                    ctx.font = '16px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('Waiting for data...', W / 2, H / 2);
                    return;
                }

                const yMax = Math.max(maxCapacity, ...history.map(p => p.value)) + 1;
                const colors = { green: '#2ecc71', orange: '#f5a623', red: '#e74c3c' };
                const lineColor = colors[zoneColor] || '#5b8cff';

                // gridlines + y-axis labels
                ctx.strokeStyle = '#262a3a';
                ctx.fillStyle = '#8b8fa3';
                ctx.font = '11px sans-serif';
                ctx.textAlign = 'right';
                const ySteps = 5;
                for (let i = 0; i <= ySteps; i++) {
                    const val = Math.round((yMax / ySteps) * i);
                    const y = padT + plotH - (val / yMax) * plotH;
                    ctx.beginPath();
                    ctx.moveTo(padL, y);
                    ctx.lineTo(W - padR, y);
                    ctx.stroke();
                    ctx.fillText(val, padL - 8, y + 4);
                }

                // capacity line (dashed)
                const capY = padT + plotH - (maxCapacity / yMax) * plotH;
                ctx.save();
                ctx.setLineDash([5, 4]);
                ctx.strokeStyle = '#e74c3c';
                ctx.beginPath();
                ctx.moveTo(padL, capY);
                ctx.lineTo(W - padR, capY);
                ctx.stroke();
                ctx.restore();

                // the crowd-count line itself
                const stepX = plotW / Math.max(history.length - 1, 1);
                ctx.beginPath();
                history.forEach((point, i) => {
                    const x = padL + i * stepX;
                    const y = padT + plotH - (point.value / yMax) * plotH;
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.strokeStyle = lineColor;
                ctx.lineWidth = 2.5;
                ctx.stroke();

                // filled area under the line
                ctx.lineTo(padL + (history.length - 1) * stepX, padT + plotH);
                ctx.lineTo(padL, padT + plotH);
                ctx.closePath();
                ctx.fillStyle = lineColor + '22';
                ctx.fill();

                // highlight the latest point
                const lastPoint = history[history.length - 1];
                const lastX = padL + (history.length - 1) * stepX;
                const lastY = padT + plotH - (lastPoint.value / yMax) * plotH;
                ctx.beginPath();
                ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
                ctx.fillStyle = lineColor;
                ctx.fill();

                // x-axis time labels (first, middle, last)
                ctx.fillStyle = '#8b8fa3';
                ctx.textAlign = 'left';
                ctx.fillText(history[0].time, padL, H - 8);
                ctx.textAlign = 'center';
                ctx.fillText(history[Math.floor(history.length / 2)].time, padL + plotW / 2, H - 8);
                ctx.textAlign = 'right';
                ctx.fillText(lastPoint.time, W - padR, H - 8);
            }

            // # --- DATABASE INTEGRATION ---
            let pastEvents = [];

            function drawHourlyChart(hourly) {
                const canvas = document.getElementById('hourly-canvas');
                const ctx = canvas.getContext('2d');
                const W = canvas.width, H = canvas.height;
                const padL = 42, padR = 18, padT = 18, padB = 42;
                const plotW = W - padL - padR;
                const plotH = H - padT - padB;
                ctx.clearRect(0, 0, W, H);

                if (!hourly || hourly.length === 0) {
                    ctx.fillStyle = '#8b8fa3';
                    ctx.font = '16px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('No data yet', W / 2, H / 2);
                    return;
                }

                let yMax = 1;
                hourly.forEach(item => {
                    yMax = Math.max(yMax, Number(item.entries) || 0, Number(item.exits) || 0);
                });
                yMax = Math.ceil(yMax * 1.15);
                ctx.strokeStyle = '#262a3a';
                ctx.fillStyle = '#8b8fa3';
                ctx.font = '11px sans-serif';
                ctx.textAlign = 'right';
                for (let i = 0; i <= 4; i++) {
                    const value = Math.round(yMax * i / 4);
                    const y = padT + plotH - (value / yMax) * plotH;
                    ctx.beginPath();
                    ctx.moveTo(padL, y);
                    ctx.lineTo(W - padR, y);
                    ctx.stroke();
                    ctx.fillText(value, padL - 7, y + 4);
                }

                const groupW = plotW / hourly.length;
                const barW = Math.min(18, groupW * 0.32);
                hourly.forEach((item, index) => {
                    const centerX = padL + groupW * (index + 0.5);
                    const entryHeight = ((Number(item.entries) || 0) / yMax) * plotH;
                    const exitHeight = ((Number(item.exits) || 0) / yMax) * plotH;
                    ctx.fillStyle = '#3498db';
                    ctx.fillRect(centerX - barW - 1, padT + plotH - entryHeight, barW, entryHeight);
                    ctx.fillStyle = '#9b59b6';
                    ctx.fillRect(centerX + 1, padT + plotH - exitHeight, barW, exitHeight);
                    if (index % Math.max(1, Math.ceil(hourly.length / 8)) === 0 || index === hourly.length - 1) {
                        const hourText = String(item.hour || '').slice(11, 16);
                        ctx.fillStyle = '#8b8fa3';
                        ctx.textAlign = 'center';
                        ctx.fillText(hourText, centerX, H - 12);
                    }
                });
            }

            function renderPastEvents() {
                const tbody = document.getElementById('past-events');
                const filter = document.getElementById('past-filter').value;
                const events = pastEvents.filter(event => {
                    if (filter === 'ALL') return true;
                    if (filter === 'OBJECT') {
                        return event.direction === 'OBJECT' || 
                            (event.trigger_type && event.trigger_type.toLowerCase().includes('object'));
                    }
                    if (filter === 'TRIGGER') {
                        return event.direction === 'TRIGGER' || event.direction === 'VERIFY';
                    }
                    return event.direction === filter;
                });
                tbody.replaceChildren();

                if (events.length === 0) {
                    const row = document.createElement('tr');
                    const cell = document.createElement('td');
                    cell.colSpan = 6;
                    cell.textContent = 'No events found.';
                    row.appendChild(cell);
                    tbody.appendChild(row);
                    return;
                }

                events.forEach(event => {
                    const row = document.createElement('tr');
                    const timeCell = document.createElement('td');
                    timeCell.textContent = event.timestamp == null ? '' : String(event.timestamp);
                    row.appendChild(timeCell);

                    const eventCell = document.createElement('td');
                    const badge = document.createElement('span');
                    const direction = String(event.direction || '').toUpperCase();
                    badge.className = 'event-badge';
                    badge.style.backgroundColor = direction === 'ENTRY' ? '#3498db' :
                        direction === 'EXIT' ? '#9b59b6' :
                        direction === 'OBJECT' ? '#e67e22' :
                        direction === 'TRIGGER' || direction === 'VERIFY' ? '#2ecc71' : '#7f8c8d';
                    badge.textContent = direction || '-';
                    eventCell.appendChild(badge);
                    row.appendChild(eventCell);

                    const peopleCell = document.createElement('td');
                    peopleCell.textContent = event.people_count == null ? '-' : String(event.people_count);
                    row.appendChild(peopleCell);

                    const occupancyCell = document.createElement('td');
                    occupancyCell.textContent = event.current_occupancy == null ? '-' : String(event.current_occupancy);
                    row.appendChild(occupancyCell);

                    // Image link column: fully accessible for both human crossings and object false-triggers
                    const imageCell = document.createElement('td');
                    if (event.image_filename) {
                        const link = document.createElement('a');
                        link.href = '/static/captures/' + encodeURIComponent(String(event.image_filename));
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.textContent = '📷 ' + String(event.image_filename);
                        imageCell.appendChild(link);
                    } else {
                        imageCell.textContent = '-';
                    }
                    row.appendChild(imageCell);

                    // Trigger Type column (positioned immediately to the right of Image column)
                    const triggerCell = document.createElement('td');
                    const triggerBadge = document.createElement('span');
                    const rawType = String(event.trigger_type || (event.direction === 'OBJECT' ? 'Object/False Trigger' : 'Human'));
                    const isHuman = rawType.toLowerCase().includes('human') && event.direction !== 'OBJECT';
                    triggerBadge.className = 'trigger-badge ' + (isHuman ? 'human' : 'object');
                    triggerBadge.textContent = isHuman ? '👤 Human' : '📦 Object';
                    triggerCell.appendChild(triggerBadge);
                    row.appendChild(triggerCell);

                    tbody.appendChild(row);
                });
            }

            function fetchPastData() {
                const limit = document.getElementById('past-limit').value;
                const errorBox = document.getElementById('past-error');
                errorBox.textContent = '';
                Promise.all([
                    fetch('/history?limit=' + encodeURIComponent(limit)).then(response => {
                        if (!response.ok) throw new Error('History request failed (' + response.status + ')');
                        return response.json();
                    }),
                    fetch('/hourly?hours=24').then(response => {
                        if (!response.ok) throw new Error('Hourly request failed (' + response.status + ')');
                        return response.json();
                    })
                ]).then(results => {
                    const historyData = results[0];
                    const stats = historyData.stats || {};
                    document.getElementById('past-total-entries').textContent =
                        String(stats.total_entries == null ? 0 : stats.total_entries);
                    document.getElementById('past-total-exits').textContent =
                        String(stats.total_exits == null ? 0 : stats.total_exits);
                    document.getElementById('past-peak-occupancy').textContent =
                        String(stats.peak_occupancy == null ? 0 : stats.peak_occupancy);
                    document.getElementById('past-total-events').textContent =
                        String(stats.total_events == null ? 0 : stats.total_events);
                    pastEvents = Array.isArray(historyData.events) ? historyData.events : [];
                    renderPastEvents();
                    drawHourlyChart(results[1]);
                }).catch(error => {
                    errorBox.textContent = 'Could not load past data: ' + error.message;
                });
            }

            document.getElementById('past-refresh').addEventListener('click', fetchPastData);
            document.getElementById('past-limit').addEventListener('change', fetchPastData);
            document.getElementById('past-filter').addEventListener('change', renderPastEvents);

            function renderDashboard(data) {
                lastStatusData = data;
                const effectiveCap = getEffectiveCapacity(data.max_capacity);
                const peopleInside = data.people_inside;

                document.getElementById('entry-num').textContent = data.entry_count;
                document.getElementById('exit-num').textContent = data.exit_count;
                document.getElementById('inside-num').textContent = peopleInside;
                document.getElementById('capacity-num').textContent = effectiveCap;
                document.getElementById('frame-num').textContent = data.people_in_frame;

                // Dynamic safety thresholds update
                updateThresholdsUI(effectiveCap);

                // Dynamic zone status evaluation
                const zone = evaluateZone(peopleInside, effectiveCap);

                // Update Zone Badge
                const badge = document.getElementById('zone-badge');
                badge.className = zone.color;
                badge.innerHTML = `<span class="zone-icon">${ZONE_ICONS[zone.color]}</span><span id="zone-text">${zone.label}</span>`;

                // Smart Overcrowding Warning & Exit Calculator
                const alertBox = document.getElementById('critical-alert-box');
                const exitNumEl = document.getElementById('overcrowd-exit-num');
                const critNeededEl = document.getElementById('crit-needed-val');
                const critInsideEl = document.getElementById('crit-inside-val');
                const critTargetEl = document.getElementById('crit-target-val');
                const critCapEl = document.getElementById('crit-cap-val');

                if (zone.isCritical) {
                    const upperMediumThreshold = Math.floor(effectiveCap * 0.9);
                    const peopleToExit = Math.max(1, peopleInside - upperMediumThreshold);

                    if (exitNumEl) exitNumEl.textContent = peopleToExit;
                    if (critNeededEl) critNeededEl.textContent = peopleToExit;
                    if (critInsideEl) critInsideEl.textContent = peopleInside;
                    if (critTargetEl) critTargetEl.textContent = upperMediumThreshold;
                    if (critCapEl) critCapEl.textContent = effectiveCap;

                    if (alertBox) alertBox.style.display = 'block';
                    document.body.classList.add('critical-active');
                    startAudioAlarm();
                } else {
                    if (alertBox) alertBox.style.display = 'none';
                    document.body.classList.remove('critical-active');
                    stopAudioAlarm();
                }

                // Relocated fixed bottom footer counters (active only in critical mode)
                const footerEntryEl = document.getElementById('footer-entry-num');
                const footerExitEl = document.getElementById('footer-exit-num');
                const footerInsideEl = document.getElementById('footer-inside-num');
                if (footerEntryEl) footerEntryEl.textContent = data.entry_count;
                if (footerExitEl) footerExitEl.textContent = data.exit_count;
                if (footerInsideEl) footerInsideEl.textContent = peopleInside;

                // Flash the screen red the moment the zone becomes CRITICAL (red),
                // for a fraction of a second, to grab attention.
                const isRed = (zone.color === 'red');
                if (isRed && !wasRed) {
                    const overlay = document.getElementById('critical-overlay');
                    if (overlay) {
                        overlay.classList.remove('flash');
                        void overlay.offsetWidth; // restart animation
                        overlay.classList.add('flash');
                    }
                }
                wasRed = isRed;
                wasCritical = zone.isCritical;

                drawGraph(data.history, effectiveCap, zone.color);
                renderAlerts(data.alerts);
            }

            function refresh() {
                fetch('/status').then(r => r.json()).then(data => {
                    renderDashboard(data);
                }).catch(err => {
                    console.error("Status fetch error:", err);
                });
            }

            refresh();
            setInterval(refresh, 1500);
            // # --- DATABASE INTEGRATION ---
            setInterval(function() {
                if (document.getElementById('tab-past').classList.contains('active')) fetchPastData();
            }, 5000);
        
