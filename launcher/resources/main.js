// Design Inspector Launcher — folder pick, own spawn/kill, status window.
// The launcher OWNS the target dev child: closing the window stops the server.
// Generic: works with ANY local dev project ("검사 대상").
//
// Job file rendezvous with the supervisor (scripts/with-launcher.mjs):
//   launcher writes {dir, script, requestedAt, last, history, status}
//   supervisor reads {last.port, status} (browser open, HTTP panel, exit backstop)

(function () {
  'use strict';

  var els = {};
  ['titlebar', 'tb-btns', 'btn-min', 'btn-close', 'status-pill', 'status-text',
   'view-splash', 'splash-text', 'view-main', 'recent-wrap', 'recent-list',
   'folder-path', 'btn-browse', 'project-info', 'proj-name', 'proj-script',
   'error-line', 'btn-confirm', 'view-running', 'run-name', 'run-url',
   'run-log', 'run-error', 'btn-retry', 'btn-stop', 'btn-done'].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  // Keep in sync with scripts/ports.mjs TARGET_PORTS.
  var TARGET_PORTS = [3000, 3001, 3002, 5174, 8080, 8081, 4173, 9000, 1234, 4200, 3005];
  var HISTORY_CAP = 5;
  var LOG_CAP = 60;
  var LOG_TAIL_CAP = 30;
  var LOG_LINE_CAP = 4096;
  var LOG_BUFFER_CAP = 16384;
  var PORT_WAIT_MS = 90000;

  var jobFile = '';
  var selectedDir = '';
  var selectedScript = '';
  var history = [];
  var child = null; // { id, pid }
  var childGone = true;
  var childExitCode = null;
  var targetPort = null;
  var logLines = [];
  var logStreamBuffer = '';
  var sniffedPorts = [];
  var closing = false;
  var starting = false;
  var booted = false;
  var statusDirty = false;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function setStatus(mode, text) {
    els['status-pill'].className = 'pill' + (mode === 'on' ? ' on' : mode === 'err' ? ' err' : '');
    els['status-text'].textContent = text;
  }

  function show(name) {
    els['view-splash'].classList.toggle('hidden', name !== 'splash');
    els['view-main'].classList.toggle('hidden', name !== 'main');
    els['view-running'].classList.toggle('hidden', name !== 'running');
  }

  function splash(text) {
    els['splash-text'].textContent = text;
    show('splash');
  }

  function showError(msg) {
    els['error-line'].textContent = msg;
    els['error-line'].classList.remove('hidden');
  }

  function clearError() {
    els['error-line'].textContent = '';
    els['error-line'].classList.add('hidden');
  }

  // Neutralino builds may return file content JSON-encoded (observed on
  // v6.9.0). Unwrap defensively (mirrors scripts/jobfile.mjs).
  function lenientJsonParse(text) {
    var value = text;
    var last = null;
    for (var i = 0; i < 3; i++) {
      if (typeof value !== 'string') return value;
      var trimmed = value.replace(/^\s+|\s+$/g, '');
      if (trimmed === last) break;
      last = trimmed;
      try {
        value = JSON.parse(trimmed);
      } catch (e) {
        break;
      }
    }
    return value;
  }

  async function readJob() {
    if (!jobFile) return null;
    try {
      var raw = await Neutralino.filesystem.readFile(jobFile);
      var parsed = lenientJsonParse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  var jobWriteQueue = Promise.resolve();

  function writeJob(patch) {
    var operation = jobWriteQueue.then(async function () {
      var current = (await readJob()) || {};
      var next = {};
      for (var k in current) {
        if (Object.prototype.hasOwnProperty.call(current, k)) next[k] = current[k];
      }
      for (var k2 in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k2)) next[k2] = patch[k2];
      }
      next.updatedAt = Date.now();
      await Neutralino.filesystem.writeFile(jobFile, JSON.stringify(next, null, 2));
      return next;
    });
    jobWriteQueue = operation.catch(function () {});
    return operation;
  }

  function writeStatus(status) {
    status.updatedAt = Date.now();
    var operation = writeJob({ status: status });
    operation.catch(function () {});
    return operation;
  }

  function markStatusDirty() {
    statusDirty = true;
  }

  setInterval(function () {
    if (statusDirty && !closing && child && !childGone) {
      statusDirty = false;
      writeStatus({
        phase: targetPort ? 'running' : 'starting',
        port: targetPort,
        pid: child.pid,
        error: null,
        logTail: logLines.slice(-LOG_TAIL_CAP),
      });
    }
  }, 2000);

  function basename(dir) {
    var parts = String(dir).split(/[/\\]+/).filter(function (p) { return p !== ''; });
    return parts.length > 0 ? parts[parts.length - 1] : dir;
  }

  function pickScript(scripts) {
    if (!scripts || typeof scripts !== 'object') return null;
    if (typeof scripts.dev === 'string') return 'dev';
    if (typeof scripts.start === 'string') return 'start';
    return null;
  }

  function validScriptName(s) {
    return typeof s === 'string' && /^[A-Za-z0-9:_-]+$/.test(s);
  }

  async function probePort(port, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 1500);
    try {
      await fetch('http://127.0.0.1:' + port + '/', {
        mode: 'no-cors',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      return true;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function snapshotPorts(extra) {
    var ports = TARGET_PORTS.slice();
    (extra || []).forEach(function (p) {
      if (ports.indexOf(p) === -1) ports.push(p);
    });
    var alive = {};
    await Promise.all(ports.map(function (port) {
      return probePort(port, 1200).then(function (up) {
        if (up) alive[port] = true;
      });
    }));
    return alive;
  }

  function extractPortFromLogLine(line) {
    var text = String(line == null ? '' : line).replace(/\x1b\[[0-9;]*m/g, '');
    var ambientIgnored = /\bport\s*=\s*\d+/i.test(text) && /\bignored\b/i.test(text);
    var hasActualPort = /Local:\s*https?:\/\/[^/:]+:\d{2,5}/i.test(text) ||
      /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}/i.test(text) ||
      /\bpinned\s+to\s+\d{2,5}/i.test(text);
    if (ambientIgnored && !hasActualPort) return null;
    var m = text.match(/Local:\s*https?:\/\/[^/:]+:(\d{2,5})/i) ||
      text.match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i) ||
      text.match(/\bpinned\s+to\s+(\d{2,5})/i) ||
      text.match(/\bport\s*[:=]?\s*(\d{2,5})/i);
    if (!m) return null;
    var port = Number(m[1]);
    return port >= 1 && port <= 65535 ? port : null;
  }

  function trackSniffedPort(port) {
    if (!port || TARGET_PORTS.indexOf(port) !== -1) return;
    if (sniffedPorts.indexOf(port) !== -1) return;
    if (sniffedPorts.length >= 5) sniffedPorts.shift();
    sniffedPorts.push(port);
  }

  function appendLogLine(line) {
    if (line.trim() === '') return;
    appendLog(line);
    trackSniffedPort(extractPortFromLogLine(line));
  }

  function consumeLogChunk(data) {
    var chunk = String(data || '');
    if (chunk.length > LOG_BUFFER_CAP) chunk = chunk.slice(-LOG_BUFFER_CAP);
    logStreamBuffer += chunk;
    if (logStreamBuffer.length > LOG_BUFFER_CAP) {
      logStreamBuffer = logStreamBuffer.slice(-LOG_BUFFER_CAP);
    }
    var lines = logStreamBuffer.split(/\r?\n/);
    logStreamBuffer = lines.pop() || '';
    lines.forEach(appendLogLine);
  }

  function flushLogBuffer() {
    if (logStreamBuffer) {
      appendLogLine(logStreamBuffer);
      logStreamBuffer = '';
    }
  }

  function pushHistory(dir, port) {
    var entry = { dir: dir, port: port || null, at: Date.now() };
    history = [entry].concat(history.filter(function (h) { return h.dir !== dir; })).slice(0, HISTORY_CAP);
  }

  async function renderHistory() {
    var list = els['recent-list'];
    while (list.firstChild) list.removeChild(list.firstChild);
    if (history.length === 0) {
      els['recent-wrap'].classList.add('hidden');
      return;
    }
    els['recent-wrap'].classList.remove('hidden');
    var checks = await Promise.all(history.map(function (h) {
      return h.port ? probePort(h.port, 1200) : Promise.resolve(false);
    }));
    history.forEach(function (h, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sess';
      var main = document.createElement('span');
      main.style.flex = '1';
      main.style.minWidth = '0';
      var t = document.createElement('div');
      t.className = 't';
      t.textContent = basename(h.dir);
      var u = document.createElement('div');
      u.className = 'u';
      u.textContent = h.dir;
      main.appendChild(t);
      main.appendChild(u);
      btn.appendChild(main);
      if (h.port) {
        var chip = document.createElement('span');
        chip.className = 'port' + (checks[i] ? ' up' : '');
        chip.textContent = ':' + h.port + (checks[i] ? ' ✓' : '');
        btn.appendChild(chip);
      }
      btn.addEventListener('click', function () {
        selectedDir = h.dir;
        void refreshProject();
      });
      list.appendChild(btn);
    });
  }

  function appendLog(line) {
    var value = String(line);
    if (value.length > LOG_LINE_CAP) value = value.slice(0, LOG_LINE_CAP) + ' ...[truncated]';
    logLines.push(value);
    if (logLines.length > LOG_CAP) logLines.splice(0, logLines.length - LOG_CAP);
    var pre = els['run-log'];
    pre.textContent = logLines.join('\n');
    pre.scrollTop = pre.scrollHeight;
    markStatusDirty();
  }

  async function refreshProject() {
    clearError();
    els['folder-path'].value = selectedDir;
    els['btn-confirm'].disabled = true;
    els['project-info'].classList.add('hidden');
    selectedScript = '';
    if (!selectedDir) return;
    try {
      var raw = await Neutralino.filesystem.readFile(selectedDir + '/package.json');
      var pkg = lenientJsonParse(raw);
      if (!pkg || typeof pkg !== 'object') throw new Error('bad package.json');
      var name = typeof pkg.name === 'string' && pkg.name ? pkg.name : basename(selectedDir);
      var script = pickScript(pkg.scripts);
      els['proj-name'].textContent = name;
      if (script) {
        selectedScript = script;
        els['proj-script'].textContent = 'npm run ' + script;
        els['project-info'].classList.remove('hidden');
        els['btn-confirm'].disabled = false;
      } else {
        showError('package.json에 dev/start 스크립트가 없습니다.');
      }
    } catch (e) {
      showError('package.json을 읽을 수 없습니다. 프로젝트 폴더가 맞는지 확인해 주세요.');
    }
  }

  async function killTree(pid) {
    // Windows-first: /T takes the whole npm→node tree. Best effort elsewhere.
    try {
      await Neutralino.os.execCommand('taskkill /PID ' + pid + ' /T /F');
      return;
    } catch (e) { /* fall through */ }
    try {
      if (child) await Neutralino.os.updateSpawnedProcess(child.id, 'exit');
    } catch (e2) { /* best effort */ }
  }

  function showRunning() {
    els['run-name'].textContent = basename(selectedDir);
    els['run-url'].textContent = targetPort ? 'http://localhost:' + targetPort : '시작 중…';
    els['run-error'].classList.add('hidden');
    els['btn-retry'].classList.add('hidden');
    show('running');
  }

  function showRunError(msg) {
    setStatus('err', '오류');
    els['run-error'].textContent = msg;
    els['run-error'].classList.remove('hidden');
    els['btn-retry'].classList.remove('hidden');
  }

  async function waitForPort(before) {
    var deadline = Date.now() + PORT_WAIT_MS;
    for (;;) {
      if (childGone) return null;
      var alive = await snapshotPorts(sniffedPorts);
      if (childGone) return null;
      for (var i = 0; i < TARGET_PORTS.length; i++) {
        var p = TARGET_PORTS[i];
        if (alive[p] && !before[p]) return p;
      }
      // Fallback: off-list ports sniffed from THIS child's own stdout.
      for (var j = 0; j < sniffedPorts.length; j++) {
        var sp = sniffedPorts[j];
        if (alive[sp] && !before[sp]) return sp;
      }
      if (Date.now() >= deadline) return null;
      await sleep(1000);
    }
  }

  async function startTarget() {
    if (starting || !selectedDir || !validScriptName(selectedScript)) return;
    starting = true;
    clearError();
    targetPort = null;
    childGone = false;
    childExitCode = null;
    logLines = [];
    logStreamBuffer = '';
    sniffedPorts = [];
    els['run-log'].textContent = '';
    setStatus('on', '시작 중');
    showRunning();
    try {
      await writeJob({
        dir: selectedDir,
        script: selectedScript,
        requestedAt: Date.now(),
        last: { dir: selectedDir, port: null },
      });
    } catch (e) { /* job write is best-effort */ }
    writeStatus({ phase: 'starting', port: null, pid: null, error: null, logTail: [] });

    var before = await snapshotPorts();
    var proc;
    try {
      proc = await Neutralino.os.spawnProcess('cmd /d /s /c npm run ' + selectedScript, { cwd: selectedDir });
    } catch (e) {
      starting = false;
      var msg = '서버를 실행하지 못했습니다. npm이 설치되어 있는지 확인해 주세요.';
      showRunError(msg);
      writeStatus({ phase: 'error', port: null, pid: null, error: msg, logTail: [] });
      return;
    }
    child = { id: proc.id, pid: proc.pid };
    appendLog('$ npm run ' + selectedScript + '  (pid ' + proc.pid + ')');
    try {
      await Neutralino.os.updateSpawnedProcess(proc.id, 'stdInEnd');
      appendLog('stdin closed (non-interactive dev process)');
    } catch (e) {
      await killTree(proc.pid);
      child = null;
      childGone = true;
      starting = false;
      var stdinMsg = '개발 서버 입력 파이프를 닫지 못했습니다: ' + (e?.message ?? e);
      showRunError(stdinMsg);
      writeStatus({ phase: 'error', port: null, pid: proc.pid, error: stdinMsg, logTail: logLines.slice(-LOG_TAIL_CAP) });
      return;
    }
    flushLogBuffer();

    var port = await waitForPort(before);
    starting = false;
    if (port === null) {
      var aliveNow = await snapshotPorts(sniffedPorts);
      for (var k = 0; k < sniffedPorts.length; k++) {
        if (aliveNow[sniffedPorts[k]] && !before[sniffedPorts[k]]) {
          port = sniffedPorts[k];
          break;
        }
      }
    }
    if (port === null) {
      var busy = TARGET_PORTS.filter(function (p) { return aliveNow[p]; });
      var timeoutMsg;
      if (childGone) {
        timeoutMsg = '개발 서버 프로세스가 종료되었습니다 (code ' + childExitCode + '). ' +
          '로그 끝의 오류를 확인해 주세요.';
      } else if (busy.length > 0) {
        timeoutMsg = '새 서버를 찾지 못했습니다: :' + busy.join(' / :') +
          ' 포트가 시작 전부터 응답 중이라 새 서버로 인식하지 못했습니다.' +
          ' 기존 서버를 종료한 뒤 [다시 시작]을 눌러 주세요.' +
          ' (위 로그에 EADDRINUSE가 있는지도 확인해 주세요.)';
      } else {
        timeoutMsg = '개발 서버 포트가 90초 안에 응답하지 않았습니다.' +
          ' 위 로그 끝까지 npm ERR·EADDRINUSE 같은 에러가 있는지 확인해 주세요.';
      }
      showRunError(timeoutMsg);
      writeStatus({ phase: 'error', port: null, pid: child.pid, error: timeoutMsg, logTail: logLines.slice(-LOG_TAIL_CAP) });
      return;
    }
    targetPort = port;
    pushHistory(selectedDir, port);
    try {
      await writeJob({
        last: { dir: selectedDir, port: port },
        history: history,
      });
    } catch (e) { /* best effort */ }
    setStatus('on', '실행 중');
    els['run-url'].textContent = 'http://localhost:' + port;
    writeStatus({ phase: 'running', port: port, pid: child.pid, error: null, logTail: logLines.slice(-LOG_TAIL_CAP) });
    try {
      await Neutralino.window.minimize();
    } catch (e) { /* minimize is best-effort */ }
  }

  async function stopTarget() {
    if (child && !childGone && child.pid) {
      appendLog('■ stopping pid ' + child.pid + '…');
      await killTree(child.pid);
    }
    child = null;
    childGone = true;
    targetPort = null;
    starting = false;
    setStatus('', '대기 중');
    await writeStatus({ phase: 'stopped', port: null, pid: null, error: null, logTail: [] });
  }

  async function closeRequest() {
    if (closing) return;
    closing = true;
    splash('종료 중…');
    if (child && !childGone) {
      await stopTarget();
    }
    try {
      Neutralino.app.exit(0);
    } catch (e) {
      window.close();
    }
  }

  function inTitleButtons(target) {
    return !!(target && target.closest && target.closest('#tb-btns'));
  }

  function enableManualDrag() {
    var bar = els['titlebar'];
    var dragging = false;
    var startX = 0;
    var startY = 0;
    var winX = 0;
    var winY = 0;
    bar.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || inTitleButtons(e.target)) return;
      e.preventDefault();
      Neutralino.window.getPosition().then(function (pos) {
        dragging = true;
        startX = e.screenX;
        startY = e.screenY;
        winX = pos.x;
        winY = pos.y;
      }).catch(function () { dragging = false; });
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      try {
        var p = Neutralino.window.move(winX + (e.screenX - startX), winY + (e.screenY - startY));
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (err) { /* ignore */ }
    });
    window.addEventListener('mouseup', function () { dragging = false; });
    window.addEventListener('blur', function () { dragging = false; });
  }

  async function boot() {
    if (booted) return;
    booted = true;
    if (typeof Neutralino === 'undefined') {
      splash('런처 바이너리로 실행해야 합니다.');
      return;
    }
    var ready = false;
    var lastErr = '';
    for (var attempt = 1; attempt <= 5; attempt++) {
      splash('초기화 중… (' + attempt + '/5)');
      try {
        Neutralino.init();
        ready = true;
        break;
      } catch (e) {
        lastErr = String((e && e.message) || e);
        await sleep(500);
      }
    }
    if (!ready) {
      splash('런처 초기화에 실패했습니다: ' + lastErr);
      return;
    }
    // Manual window drag (deterministic): the declarative draggable region
    // proved unreliable, so drive window.move from pointer events instead.
    // Buttons inside #tb-btns are excluded so clicks still work.
    enableManualDrag();
    try {
      Neutralino.events.on('windowClose', function () { void closeRequest(); });
      Neutralino.events.on('spawnedProcess', function (evt) {
        try {
          var detail = (evt && evt.detail) || {};
          if (!child || detail.id !== child.id) return;
          if (detail.action === 'stdOut' || detail.action === 'stdErr') {
            consumeLogChunk(detail.data || '');
          } else if (detail.action === 'exit') {
            childGone = true;
            childExitCode = detail.data;
            flushLogBuffer();
            if (!closing && targetPort) {
              var msg = '서버가 종료되었습니다 (code ' + detail.data + '). 다시 시작하거나 닫아 주세요.';
              showRunError(msg);
              writeStatus({ phase: 'error', port: targetPort, pid: null, error: msg, logTail: logLines.slice(-LOG_TAIL_CAP) });
            }
          }
        } catch (e) { /* log streaming is best-effort */ }
      });
    } catch (e) { /* event wiring is best-effort */ }

    splash('환경을 읽고 있습니다…');
    try {
      jobFile = (await Neutralino.os.getEnv('INSPECTOR_JOB_FILE')) || '';
    } catch (e) {
      jobFile = '';
    }

    // Smart-skip: remembered target already serving → splash and exit.
    splash('이전 대상을 확인하고 있습니다…');
    var job = await readJob();
    var last = job && job.last ? job.last : null;
    if (job && Array.isArray(job.history)) {
      history = job.history.filter(function (h) {
        return h && typeof h.dir === 'string';
      }).slice(0, HISTORY_CAP);
    }
    if (
      last && last.dir && last.port &&
      job.status && job.status.phase === 'running' &&
      Number.isFinite(Number(job.status.pid)) && Number(job.status.pid) > 0 &&
      Number.isFinite(Number(job.requestedAt))
    ) {
      if (await probePort(last.port)) {
        splash('이미 실행 중입니다 ✓');
        setTimeout(function () {
          try { Neutralino.app.exit(0); } catch (e) { window.close(); }
        }, 1200);
        return;
      }
      selectedDir = last.dir;
      await refreshProject();
      await renderHistory();
      show('main');
      return;
    }
    if (last && last.dir) {
      selectedDir = last.dir;
      await refreshProject();
    }
    await renderHistory();
    show('main');
  }

  els['btn-min'].addEventListener('click', function () {
    try { Neutralino.window.minimize(); } catch (e) { /* ignore */ }
  });
  els['btn-close'].addEventListener('click', function () {
    void closeRequest();
  });

  els['btn-browse'].addEventListener('click', async function () {
    clearError();
    try {
      var opts = selectedDir ? { defaultPath: selectedDir } : undefined;
      var picked = await Neutralino.os.showFolderDialog('검사할 프로젝트 폴더 선택', opts);
      if (picked) {
        selectedDir = picked;
        await refreshProject();
      }
    } catch (e) {
      showError('폴더 선택 대화상자를 열 수 없습니다.');
    }
  });

  els['btn-confirm'].addEventListener('click', function () {
    if (!selectedDir || !selectedScript) return;
    clearError();
    void startTarget();
  });

  els['btn-stop'].addEventListener('click', function () {
    void (async function () {
      await stopTarget();
      await renderHistory();
      show('main');
    })();
  });

  els['btn-retry'].addEventListener('click', function () {
    void (async function () {
      if (child && !childGone) await stopTarget();
      els['run-error'].classList.add('hidden');
      els['btn-retry'].classList.add('hidden');
      await startTarget();
    })();
  });

  els['btn-done'].addEventListener('click', function () {
    void closeRequest();
  });

  if (typeof window !== 'undefined') {
    if (document.readyState === 'complete') {
      void boot();
    } else {
      window.addEventListener('load', function () { void boot(); });
    }
  }
})();
