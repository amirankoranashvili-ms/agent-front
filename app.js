(function () {
  'use strict';

  var SAMPLE_RATE = 24000;

  // ─── State ───────────────────────────────────────────────────────
  var ws = null;
  var audioCtx = null;
  var micStream = null;
  var captureNode = null;
  var isRecording = false;
  var workletReady = false;
  var nextPlayTime = 0;
  var currentSources = [];

  // ─── DOM refs ────────────────────────────────────────────────────
  var micBtn = document.getElementById('mic-btn');
  var voiceStatus = document.getElementById('voice-status');
  var orderItemsEl = document.getElementById('order-items');
  var orderFooter = document.getElementById('order-footer');
  var orderSubtotal = document.getElementById('order-subtotal');
  var orderCalories = document.getElementById('order-calories');
  var orderConfirmed = document.getElementById('order-confirmed');
  var confirmedNumber = document.getElementById('confirmed-number');
  var confirmedTotal = document.getElementById('confirmed-total');
  var confirmedWait = document.getElementById('confirmed-wait');
  var loyaltyBar = document.getElementById('loyalty-bar');
  var userTranscript = document.getElementById('user-transcript');
  var agentTranscript = document.getElementById('agent-transcript');
  var menuContent = document.getElementById('menu-content');
  var agentRobot = document.querySelector('.agent-robot');

  // Two OFF paths:
  //   setAgentSpeaking(false)          — debounced 400ms; used only from
  //     source.onended where brief inter-chunk gaps (network jitter) would
  //     otherwise flicker the pop-in.
  //   setAgentSpeakingImmediate(false) — synchronous; used from clearPlayback
  //     (barge-in / interruptionSignal) where the robot must vanish the
  //     instant audio is silenced.
  var agentSpeakingOffTimer = null;
  function setAgentSpeaking(on) {
    if (!agentRobot) return;
    if (on) {
      if (agentSpeakingOffTimer) { clearTimeout(agentSpeakingOffTimer); agentSpeakingOffTimer = null; }
      agentRobot.classList.add('speaking');
    } else {
      if (agentSpeakingOffTimer) return;
      agentSpeakingOffTimer = setTimeout(function () {
        agentSpeakingOffTimer = null;
        agentRobot.classList.remove('speaking');
      }, 400);
    }
  }
  function setAgentSpeakingImmediate(on) {
    if (!agentRobot) return;
    if (agentSpeakingOffTimer) { clearTimeout(agentSpeakingOffTimer); agentSpeakingOffTimer = null; }
    if (on) agentRobot.classList.add('speaking');
    else agentRobot.classList.remove('speaking');
  }

  // ─── Audio Engine (AudioWorklet) ─────────────────────────────────

  function initAudio() {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    audioCtx.audioWorklet.addModule('audio-processor.js').then(function () {
      workletReady = true;
    }).catch(function (err) {
      console.error('AudioWorklet failed, check audio-processor.js:', err);
    });
  }

  function startRecording() {
    if (isRecording) return;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      updateStatus('Mic requires localhost or HTTPS');
      return;
    }

    if (!audioCtx) initAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    }).then(function (stream) {
      micStream = stream;

      var nativeRate = audioCtx.sampleRate;
      var downsampleRatio = Math.round(nativeRate / SAMPLE_RATE);

      function setup() {
        var source = audioCtx.createMediaStreamSource(micStream);
        captureNode = new AudioWorkletNode(audioCtx, 'capture-processor');

        captureNode.port.onmessage = function (e) {
          if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;

          var raw = e.data;
          var downsampled = downsampleRatio > 1
            ? downsample(raw, downsampleRatio)
            : raw;

          var int16 = new Int16Array(downsampled.length);
          for (var i = 0; i < downsampled.length; i++) {
            var s = Math.max(-1, Math.min(1, downsampled[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          var bytes = new Uint8Array(int16.buffer);
          var binary = '';
          for (var j = 0; j < bytes.length; j++) {
            binary += String.fromCharCode(bytes[j]);
          }

          ws.send(JSON.stringify({ realtimeInput: { audio: btoa(binary) } }));
        };

        source.connect(captureNode);
        captureNode.connect(audioCtx.destination);
        isRecording = true;
        micBtn.classList.add('recording');
        updateStatus('Listening...');
      }

      if (workletReady) {
        setup();
      } else {
        audioCtx.audioWorklet.addModule('audio-processor.js').then(function () {
          workletReady = true;
          setup();
        });
      }
    }).catch(function (err) {
      console.error('Microphone error:', err);
      updateStatus('Microphone access denied');
    });
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    // Do NOT clearPlayback() here — stopping the mic should not truncate the
    // agent's currently-playing farewell/reply. Queued audio drains via
    // source.onended and the robot hides after the last chunk.

    if (captureNode) {
      captureNode.disconnect();
      captureNode = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
    }
    updateStatus('Microphone off');
  }

  function playAudioChunk(base64Audio) {
    if (!audioCtx) return;

    var raw = atob(base64Audio);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }

    var int16 = new Int16Array(bytes.buffer);
    var float32 = new Float32Array(int16.length);
    for (var j = 0; j < int16.length; j++) {
      float32[j] = int16[j] / 32768.0;
    }

    var buffer = audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    var source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);

    var now = audioCtx.currentTime;
    if (nextPlayTime < now) nextPlayTime = now;
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;

    currentSources.push(source);
    setAgentSpeaking(true);
    source.onended = function () {
      var idx = currentSources.indexOf(source);
      if (idx !== -1) currentSources.splice(idx, 1);
      if (currentSources.length === 0) {
        setAgentSpeaking(false);
        if (isRecording) updateStatus('Listening...');
      }
    };

    if (isRecording) updateStatus('Agent speaking...');
  }

  function clearPlayback() {
    for (var i = 0; i < currentSources.length; i++) {
      try { currentSources[i].stop(); } catch (e) {}
    }
    currentSources = [];
    nextPlayTime = 0;
    // Barge-in / interruption: the robot must vanish immediately, not after
    // the 400ms debounce that only exists for inter-chunk jitter.
    setAgentSpeakingImmediate(false);
  }

  function downsample(float32, ratio) {
    var len = Math.floor(float32.length / ratio);
    var result = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      result[i] = float32[i * ratio];
    }
    return result;
  }

  // ─── WebSocket ───────────────────────────────────────────────────

  function connect() {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + window.location.host + '/ws/voice';

    updateStatus('Connecting...');
    ws = new WebSocket(url);

    ws.onopen = function () {
      updateStatus('Agent starting...');
      startRecording();
    };

    ws.onmessage = function (event) {
      var msg;
      try { msg = JSON.parse(event.data); } catch (e) { return; }

      if (msg.error) {
        updateStatus('Error: ' + msg.error);
        return;
      }

      if (msg.sessionOutput) {
        var hasPayload = !!msg.sessionOutput.payload;
        if (!hasPayload) {
          if (msg.sessionOutput.audio) playAudioChunk(msg.sessionOutput.audio);
          if (msg.sessionOutput.text) agentTranscript.textContent = msg.sessionOutput.text;
        }
        if (hasPayload) {
          handlePayload(msg.sessionOutput.payload);
        }
      }

      if (msg.recognitionResult) {
        if (msg.recognitionResult.transcript) {
          userTranscript.textContent = msg.recognitionResult.transcript;
        }
      }

      if (msg.interruptionSignal) {
        clearPlayback();
      }

      if (msg.endSession) {
        updateStatus('Session ended');
        stopRecording();
      }
    };

    ws.onclose = function () {
      // Do NOT clearPlayback() — any queued audio should drain naturally.
      // Web Audio playback is independent of the socket; source.onended
      // will hide the robot after the last chunk finishes.
      updateStatus('Disconnected — refreshing reconnects');
    };

    ws.onerror = function () {
      updateStatus('Connection error');
    };
  }

  // ─── Payload Handlers ───────────────────────────────────────────

  function handlePayload(payload) {
    switch (payload.type) {
      case 'order_update':
        updateOrderPanel(payload);
        break;
      case 'order_confirmed':
        showConfirmation(payload);
        break;
      case 'loyalty_identified':
        showLoyalty(payload);
        break;
    }
  }

  // ─── UI Updaters ────────────────────────────────────────────────

  function updateOrderPanel(data) {
    var items = data.items || [];

    if (items.length === 0) {
      orderItemsEl.innerHTML = '<p class="empty-order">Your order is empty.<br>Start speaking to add items.</p>';
      orderFooter.classList.add('hidden');
      return;
    }

    orderConfirmed.classList.add('hidden');
    orderFooter.classList.remove('hidden');

    var html = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var details = [];

      if (item.quantity > 1) details.push('Qty: ' + item.quantity);
      if (item.size) details.push(item.size);
      if (item.modifications && item.modifications.length) {
        details.push(item.modifications.join(', '));
      }
      if (item.choices && item.choices.length) {
        details.push(item.choices.join(', '));
      }

      var price = typeof item.total_price === 'number'
        ? '$' + (item.total_price / 100).toFixed(2)
        : '';

      html += '<div class="order-item">'
        + '<div class="order-item-info">'
        + '<div class="order-item-name">' + escapeHtml(item.name) + '</div>'
        + (details.length ? '<div class="order-item-details">' + escapeHtml(details.join(' · ')) + '</div>' : '')
        + '</div>'
        + '<div class="order-item-price">' + price + '</div>'
        + '</div>';
    }
    orderItemsEl.innerHTML = html;

    orderSubtotal.textContent = data.subtotal_display || '$0.00';
    orderCalories.textContent = (data.calorie_total || 0) + ' cal';
  }

  function showConfirmation(data) {
    orderItemsEl.innerHTML = '';
    orderFooter.classList.add('hidden');
    orderConfirmed.classList.remove('hidden');

    confirmedNumber.textContent = 'Order ' + (data.order_number || '');
    confirmedTotal.textContent = 'Total: ' + (data.total_with_tax || '');
    confirmedWait.textContent = data.estimated_wait
      ? 'Estimated wait: ' + data.estimated_wait + ' minutes'
      : '';
  }

  function showLoyalty(data) {
    loyaltyBar.classList.remove('hidden');
    var html = '<span class="name">Welcome, ' + escapeHtml(data.customer_name) + '!</span>';
    html += '<span class="points">' + (data.points_balance || 0) + ' pts</span>';
    if (data.available_rewards && data.available_rewards.length) {
      html += '<span class="rewards">Rewards: ' + escapeHtml(data.available_rewards.join(', ')) + '</span>';
    }
    loyaltyBar.innerHTML = html;
  }

  function updateStatus(text) {
    voiceStatus.textContent = text;
  }

  // ─── Menu Loading ───────────────────────────────────────────────

  function loadMenu() {
    fetch('/api/menu')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderMenu(data.categories || []);
      })
      .catch(function () {
        menuContent.innerHTML = '<p class="loading">Could not load menu.</p>';
      });
  }

  function renderMenu(categories) {
    var html = '';
    for (var c = 0; c < categories.length; c++) {
      var cat = categories[c];
      html += '<div class="menu-category">';
      html += '<h3>' + escapeHtml(cat.name) + '</h3>';

      var items = cat.items || [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var price = formatMenuPrice(item);
        var tags = renderTags(item.tags || []);
        var cls = item.available === false ? ' unavailable' : '';

        html += '<div class="menu-item' + cls + '">';
        html += '<span class="menu-item-name">' + escapeHtml(item.name) + tags + '</span>';
        html += '<span class="menu-item-price">' + price + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    menuContent.innerHTML = html;
  }

  function formatMenuPrice(item) {
    if (item.sizes && item.sizes.length) {
      var prices = item.sizes.map(function (s) {
        return '$' + (s.price / 100).toFixed(2);
      });
      return prices[0] + (prices.length > 1 ? ' - ' + prices[prices.length - 1] : '');
    }
    if (item.basePrice) {
      return '$' + (item.basePrice / 100).toFixed(2);
    }
    return '';
  }

  function renderTags(tags) {
    var html = '';
    var display = { 'popular': 1, 'seasonal': 1, 'limited-time': 1, 'spicy': 1, 'bestseller': 1, 'vegetarian': 1, 'new': 1 };
    for (var i = 0; i < tags.length; i++) {
      if (display[tags[i]]) {
        html += ' <span class="tag tag-' + tags[i] + '">' + tags[i] + '</span>';
      }
    }
    return html;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Event Handlers ─────────────────────────────────────────────

  micBtn.addEventListener('click', function () {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connect();
    } else if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  // ─── Init ───────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    loadMenu();
  });

})();
