// Replace everything from "var stepMap=" down to the end of "async function pollStatus()" with this:

var stepMap={
  queued:      {pct:8},
  downloading: {pct:20},
  transcribing:{pct:38},
  analyzing:   {pct:56},
  cutting:     {pct:70},
  captioning:  {pct:82},
  reframing:   {pct:90},
  uploading:   {pct:96},
  done:        {pct:100}
};

var statusMessages={
  queued:'Queued — pipeline ready...',
  downloading:'Downloading video at 1080p...',
  transcribing:'Whisper AI transcribing audio...',
  analyzing:'GPT-4o detecting viral moments...',
  cutting:'FFmpeg precision cutting clips...',
  captioning:'Adding animated captions...',
  reframing:'Smart reframing for all platforms...',
  uploading:'Uploading clips to CDN...',
  done:'Done! Your viral clips are ready 🎉'
};

var _currentDisplayPct = 0;
var _smoothTimer = null;
var _targetPct = 0;

function smoothTickTo(target) {
  _targetPct = target;
  if (_smoothTimer) return; // already ticking
  _smoothTimer = setInterval(function() {
    if (_currentDisplayPct < _targetPct) {
      // Move faster when far away, slower when close
      var gap = _targetPct - _currentDisplayPct;
      var step = Math.max(0.3, Math.min(gap * 0.04, 1.5));
      _currentDisplayPct = Math.min(_currentDisplayPct + step, _targetPct);
      var pct = Math.floor(_currentDisplayPct);
      document.getElementById('dashProcFill').style.width = pct + '%';
      document.getElementById('procPct').innerHTML = pct + '<span style="font-size:28px">%</span>';
    }
    // Never go backward — just wait
    if (_currentDisplayPct >= _targetPct) {
      clearInterval(_smoothTimer);
      _smoothTimer = null;
    }
  }, 80);
}

function updateProgress(status) {
  var allSteps = ['queued','downloading','transcribing','analyzing','cutting','captioning','reframing','uploading'];
  var idx = allSteps.indexOf(status);

  allSteps.forEach(function(s, i) {
    if (status === 'done') {
      setStep(s, 'done');
    } else if (i < idx) {
      setStep(s, 'done');
    } else if (i === idx) {
      setStep(s, 'active');
    }
    // else leave as-is (not started yet)
  });

  var info = stepMap[status] || stepMap['queued'];
  smoothTickTo(info.pct);
  document.getElementById('dashProcStatus').textContent = statusMessages[status] || 'Processing...';
}

function resetSteps() {
  ['queued','downloading','transcribing','analyzing','cutting','captioning','reframing','uploading'].forEach(function(s) {
    var el = document.getElementById('ps-' + s); if (el) el.className = 'proc-step';
  });
  _currentDisplayPct = 0;
  _targetPct = 0;
  if (_smoothTimer) { clearInterval(_smoothTimer); _smoothTimer = null; }
  document.getElementById('dashProcFill').style.width = '0%';
  document.getElementById('procPct').innerHTML = '0<span style="font-size:28px">%</span>';
}

async function pollStatus() {
  if (!currentProjectId) return;
  try {
    var r = await authFetch(API + '/analyze/' + currentProjectId + '/status');
    var d = await r.json();
    var status = (d.status || d.state || 'queued').toLowerCase();
    updateProgress(status);
    if (status === 'done' || status === 'completed' || status === 'complete') {
      smoothTickTo(100);
      setTimeout(function() {
        document.getElementById('dashGenBtn').disabled = false;
        document.getElementById('dashGenBtn').textContent = 'Generate Clips ⚡';
        loadClips(currentProjectId);
      }, 800);
      return;
    }
    if (status === 'error' || status === 'failed') {
      document.getElementById('procError').textContent = 'Processing failed: ' + (d.error || 'Unknown error');
      document.getElementById('procError').style.display = 'block';
      document.getElementById('dashGenBtn').disabled = false;
      document.getElementById('dashGenBtn').textContent = 'Generate Clips ⚡';
      return;
    }
    pollTimer = setTimeout(pollStatus, 3000);
  } catch(e) {
    if (e.message === 'TOKEN_EXPIRED') return;
    pollTimer = setTimeout(pollStatus, 5000);
  }
}
