// Folder-load orchestration: picker → scan → dev-server probe → onTarget.
// Picker cancellation is silent; every other failure lands on an explicit phase.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEV_PORTS,
  folderPermission,
  isFolderPickerSupported,
  pickTargetFolder,
  probeDevServers,
  recallFolder,
  rememberFolder,
  scanDirectoryHandle,
  scanFallbackFiles,
} from '../target/folders.ts';
import type { FallbackFile, ProjectFacts } from '../target/folders.ts';

export type FolderPhase =
  | 'idle'
  | 'needs-reconnect'
  | 'picking'
  | 'scanning'
  | 'probing'
  | 'server-missing';

interface Options {
  selfPort: string | null;
  onTarget: (url: string, folderName: string | null) => void;
  autoRestore?: boolean;
}

async function pickViaInput(): Promise<{ folderName: string; files: FallbackFile[] } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    let done = false;
    const finish = (v: { folderName: string; files: FallbackFile[] } | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', () => {
      const list = [...(input.files ?? [])] as Array<File & { webkitRelativePath?: string }>;
      if (list.length === 0) {
        finish(null);
        return;
      }
      const first = list[0]?.webkitRelativePath ?? list[0]?.name ?? '';
      const folderName = first.split('/')[0] || '(selected files)';
      finish({
        folderName,
        files: list.map((f) => ({
          path: f.webkitRelativePath || f.name,
          readText: () => f.text(),
        })),
      });
    });
    // Cancel detection: focus returning without change fires cancel in Chromium.
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
    // Safety net for browsers without a cancel event.
    window.setTimeout(() => finish(null), 120_000);
  });
}

export function useTargetFolder({ selfPort, onTarget, autoRestore = true }: Options) {
  const [phase, setPhase] = useState<FolderPhase>('idle');
  const [folderName, setFolderName] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectFacts | null>(null);
  const [supported] = useState(() => isFolderPickerSupported());

  const onTargetRef = useRef(onTarget);
  onTargetRef.current = onTarget;
  const handleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const restoredRef = useRef(false);

  const runProbe = useCallback(
    async (name: string, facts: ProjectFacts | null) => {
      setPhase('probing');
      const hit = await probeDevServers(DEV_PORTS, selfPort);
      if (hit) {
        setPhase('idle');
        onTargetRef.current(hit.url, name);
      } else {
        setFolderName(name);
        setProject(facts);
        setPhase('server-missing');
      }
    },
    [selfPort],
  );

  const pick = useCallback(async () => {
    setPhase('picking');
    try {
      if (isFolderPickerSupported()) {
        const handle = await pickTargetFolder();
        if (!handle) {
          setPhase('idle');
          return; // user cancelled — silent
        }
        handleRef.current = handle;
        setPhase('scanning');
        const facts = await scanDirectoryHandle(handle);
        await rememberFolder(handle, facts.folderName);
        setFolderName(facts.folderName);
        setProject(facts);
        await runProbe(facts.folderName, facts);
      } else {
        const picked = await pickViaInput();
        if (!picked) {
          setPhase('idle');
          return;
        }
        handleRef.current = null;
        setPhase('scanning');
        const facts = await scanFallbackFiles(picked.folderName, picked.files);
        setFolderName(facts.folderName);
        setProject(facts);
        await runProbe(facts.folderName, facts);
      }
    } catch {
      setPhase('idle');
    }
  }, [runProbe]);

  const retry = useCallback(async () => {
    const name = folderName ?? handleRef.current?.name ?? '(folder)';
    setPhase('probing');
    const hit = await probeDevServers(DEV_PORTS, selfPort);
    if (hit) {
      setPhase('idle');
      onTargetRef.current(hit.url, name);
    } else {
      setPhase('server-missing');
    }
  }, [folderName, selfPort]);

  const reconnect = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) {
      await pick();
      return;
    }
    setPhase('scanning');
    const perm = await folderPermission(handle);
    if (perm !== 'granted') {
      setPhase('needs-reconnect');
      return;
    }
    const facts = await scanDirectoryHandle(handle);
    setFolderName(facts.folderName);
    setProject(facts);
    await runProbe(facts.folderName, facts);
  }, [pick, runProbe]);

  const dismiss = useCallback(() => setPhase('idle'), []);

  // Silent one-time restore: remembered folder + already-granted permission →
  // scan, probe, and connect without any click. Anything less stays manual.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!autoRestore) return;
    (async () => {
      const entry = await recallFolder();
      if (!entry) return;
      handleRef.current = entry.handle;
      setFolderName(entry.folderName);
      let perm: 'granted' | 'prompt' | 'denied' = 'prompt';
      try {
        if (typeof entry.handle.queryPermission === 'function') {
          perm = await entry.handle.queryPermission({ mode: 'read' });
        } else {
          perm = 'granted';
        }
      } catch {
        perm = 'denied';
      }
      if (perm !== 'granted') {
        setPhase('needs-reconnect');
        return;
      }
      const facts = await scanDirectoryHandle(entry.handle);
      setProject(facts);
      const hit = await probeDevServers(DEV_PORTS, selfPort);
      if (hit) {
        setPhase('idle');
        onTargetRef.current(hit.url, facts.folderName);
      }
      // Miss: stay idle with the folder chip visible — user presses Load/Retry.
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = phase === 'picking' || phase === 'scanning' || phase === 'probing';

  return { phase, folderName, project, supported, busy, pick, retry, reconnect, dismiss };
}

export type TargetFolderApi = ReturnType<typeof useTargetFolder>;
