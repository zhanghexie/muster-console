/** Private to the helper process. A signal is not evidence of physical input. */
export interface X11EscapePeer {
  readonly workerPid: number;
  readonly workerStart: string;
  readonly serverPid: number;
  readonly serverStart: string;
  readonly namespace: string;
  readonly serverExecutable: string;
}
export interface UnixEscapeNative {
  readonly peer?: Readonly<X11EscapePeer>;
  poll(): boolean;
  close(): void;
}
