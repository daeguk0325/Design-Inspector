// Ambient declarations for the File System Access API (folder picker).
// Not yet part of TypeScript's DOM lib; kept minimal and local.

interface FileSystemPermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  readonly kind: 'file' | 'directory';
  readonly name: string;
  queryPermission?: (
    descriptor?: FileSystemPermissionDescriptor,
  ) => Promise<PermissionState>;
  requestPermission?: (
    descriptor?: FileSystemPermissionDescriptor,
  ) => Promise<PermissionState>;
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: 'file';
  getFile(): Promise<File>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: 'directory';
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>;
  keys(): AsyncIterableIterator<string>;
}

interface Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}
